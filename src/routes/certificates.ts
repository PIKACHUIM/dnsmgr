import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { decrypt, encrypt } from '../security/crypto';
import { nowSeconds, requireAdmin, requireCertificateSession, requireCsrf, requireLegacyApi } from '../security/auth';
import { inspectCertificate, legacyPfxBytes, exportLegacyPfx, certificateDerBase64Url } from '../certificates';
import {
  AcmeProtocolError, fetchAcmeNonce, postAcmeJws, validateAcmeUrlFrom,
  type AcmeDirectory, type AcmeEnvironment,
} from '../certificates/acme';

interface CertificateOrderRow extends Record<string, unknown> {
  id: number;
  source: 'manual' | 'acme';
  status: 'issued';
  issuer: string;
  key_type: 'RSA';
  key_size: number;
  issued_at: number;
  expires_at: number;
  fullchain_cipher: string;
  private_key_cipher: string;
  created_by: number;
  created_at: number;
  updated_at: number;
  is_auto: number;
  revoked_at: number | null;
  renewed_from: number | null;
  domain: string | null;
  sort: number | null;
}

interface CertificateOrder {
  id: number;
  source: 'manual' | 'acme';
  status: 'issued';
  issuer: string;
  keyType: 'RSA';
  keySize: number;
  issuedAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  isAuto: boolean;
  revokedAt: number | null;
  renewedFrom: number | null;
  domains: string[];
  fullchainCipher: string;
  privateKeyCipher: string;
}

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '证书订单目前仅支持 DB_FORMAT=sql', 'CERT_STORAGE_UNSUPPORTED');
  }
}

function orderId(value: unknown): number {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw new AppError(400, '证书订单编号无效', 'INVALID_CERT_ORDER_ID');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new AppError(400, '证书订单编号无效', 'INVALID_CERT_ORDER_ID');
  return parsed;
}

function newOrderId(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const id = Number(value & BigInt(Number.MAX_SAFE_INTEGER));
  return id || 1;
}

async function loadOrder(c: Context<AppEnv>, id: number): Promise<CertificateOrder | null> {
  const rows = await c.get('db').query<CertificateOrderRow>(
    `SELECT o.id, o.source, o.status, o.issuer, o.key_type, o.key_size, o.issued_at, o.expires_at,
      o.fullchain_cipher, o.private_key_cipher, o.created_by, o.created_at, o.updated_at,
      o.is_auto, o.revoked_at, o.renewed_from, d.domain, d.sort
     FROM cert_orders o LEFT JOIN cert_order_domains d ON d.order_id=o.id
     WHERE o.id=? ORDER BY d.sort`, [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    id: row.id, source: row.source, status: row.status, issuer: row.issuer,
    keyType: row.key_type, keySize: row.key_size, issuedAt: row.issued_at, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    isAuto: row.is_auto === 1, revokedAt: row.revoked_at, renewedFrom: row.renewed_from,
    domains: rows.flatMap((entry) => entry.domain === null ? [] : [entry.domain]),
    fullchainCipher: row.fullchain_cipher, privateKeyCipher: row.private_key_cipher,
  };
}

async function readMaterial(c: Context<AppEnv>, order: CertificateOrder): Promise<{ fullchain: string; privateKey: string }> {
  const [fullchain, privateKey] = await Promise.all([
    decrypt(order.fullchainCipher, c.env.APP_KEY, `cert-order/${order.id}/fullchain`),
    decrypt(order.privateKeyCipher, c.env.APP_KEY, `cert-order/${order.id}/private-key`),
  ]);
  return { fullchain, privateKey };
}

async function auditExport(c: Context<AppEnv>, id: number, detail: string): Promise<void> {
  try {
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.order.export', String(id), detail, nowSeconds()],
    );
  } catch {
    throw new AppError(503, '证书材料访问审计未确认，未返回证书数据', 'CERT_EXPORT_AUDIT_FAILED');
  }
}

function pageParams(c: Context<AppEnv>): { limit: number; offset: number } {
  const rawLimit = c.req.query('limit') ?? '20';
  const rawOffset = c.req.query('offset') ?? '0';
  if (!/^\d{1,3}$/.test(rawLimit) || !/^\d{1,7}$/.test(rawOffset)) {
    throw new AppError(400, '分页参数无效', 'INVALID_PAGINATION');
  }
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (limit < 1 || limit > 100 || offset > 1_000_000) throw new AppError(400, '分页参数超出范围', 'INVALID_PAGINATION');
  return { limit, offset };
}

function idFromLegacyBody(body: Record<string, unknown>): number {
  return orderId(body.id);
}

function publicOrder(order: CertificateOrder): Omit<CertificateOrder, 'fullchainCipher' | 'privateKeyCipher'> {
  const { fullchainCipher: _fullchain, privateKeyCipher: _privateKey, ...visible } = order;
  return visible;
}

function acmeDirectoryFrom(row: { directory: AcmeEnvironment; directory_json: string | null }): AcmeDirectory {
  if (!row.directory_json) throw new AppError(409, '签发任务的 ACME Directory 不可用', 'ACME_DIRECTORY_REQUIRED');
  let raw: unknown;
  try { raw = JSON.parse(row.directory_json); } catch { throw new AppError(503, 'ACME Directory 状态损坏', 'ACME_DIRECTORY_CORRUPT'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(503, 'ACME Directory 状态损坏', 'ACME_DIRECTORY_CORRUPT');
  const value = raw as Record<string, unknown>;
  const nonce = String(value.newNonce ?? '');
  let origin: string;
  try { origin = new URL(nonce).origin; } catch { throw new AppError(503, 'ACME Directory 状态损坏', 'ACME_DIRECTORY_CORRUPT'); }
  return {
    newNonce: validateAcmeUrlFrom(origin, nonce),
    newAccount: validateAcmeUrlFrom(origin, String(value.newAccount ?? '')),
    newOrder: validateAcmeUrlFrom(origin, String(value.newOrder ?? '')),
    ...(typeof value.revokeCert === 'string' ? { revokeCert: validateAcmeUrlFrom(origin, value.revokeCert) } : {}),
  };
}

export function certificateRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/cert/orders', requireCertificateSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const { limit, offset } = pageParams(c);
    const rows = await c.get('db').query<CertificateOrderRow>(
      `SELECT o.id, o.source, o.status, o.issuer, o.key_type, o.key_size, o.issued_at, o.expires_at,
        o.created_by, o.created_at, o.updated_at, o.is_auto, o.revoked_at, o.renewed_from, d.domain, d.sort
       FROM (SELECT * FROM cert_orders ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?) o
       LEFT JOIN cert_order_domains d ON d.order_id=o.id
       ORDER BY o.created_at DESC,o.id DESC,d.sort`, [limit, offset],
    );
    const items = new Map<number, Omit<CertificateOrder, 'fullchainCipher' | 'privateKeyCipher'>>();
    for (const row of rows) {
      const item = items.get(row.id) ?? {
        id: row.id, source: row.source, status: row.status, issuer: row.issuer,
        keyType: row.key_type, keySize: row.key_size, issuedAt: row.issued_at, expiresAt: row.expires_at,
        createdAt: row.created_at, updatedAt: row.updated_at,
        isAuto: row.is_auto === 1, revokedAt: row.revoked_at, renewedFrom: row.renewed_from, domains: [],
      };
      if (row.domain !== null) item.domains.push(row.domain);
      items.set(row.id, item);
    }
    return c.json({ code: 0, items: [...items.values()], limit, offset });
  });

  routes.post('/api/v1/cert/orders/import', requireCertificateSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const fullchain = text(body, 'fullchain', 48 * 1024);
    const privateKey = text(body, 'privateKey', 16 * 1024);
    const inspected = inspectCertificate(fullchain, privateKey);
    const id = newOrderId();
    const now = nowSeconds();
    const [fullchainCipher, privateKeyCipher] = await Promise.all([
      encrypt(fullchain, c.env.APP_KEY, `cert-order/${id}/fullchain`),
      encrypt(privateKey, c.env.APP_KEY, `cert-order/${id}/private-key`),
    ]);
    await c.get('db').batch([
      {
        sql: `INSERT INTO cert_orders
          (id,source,status,issuer,key_type,key_size,issued_at,expires_at,fullchain_cipher,private_key_cipher,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, 'manual', 'issued', inspected.issuer, 'RSA', inspected.keySize, inspected.issuedAt, inspected.expiresAt,
          fullchainCipher, privateKeyCipher, c.get('principal').user.id, now, now],
      },
      ...inspected.domains.map((domain, sort) => ({
        sql: 'INSERT INTO cert_order_domains (order_id,domain,sort) VALUES (?,?,?)', args: [id, domain, sort],
      })),
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
        args: [c.get('principal').user.id, 'cert.order.import', String(id), 'manual RSA certificate imported', now],
      },
    ]);
    return c.json({ code: 0, id });
  });

  routes.post('/api/v1/cert/orders/:id/export', requireCertificateSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const id = orderId(c.req.param('id'));
    const order = await loadOrder(c, id);
    if (!order) throw new AppError(404, '证书订单不存在', 'CERT_ORDER_NOT_FOUND');
    const { fullchain, privateKey } = await readMaterial(c, order);
    const pfx = legacyPfxBytes(fullchain, privateKey);
    await auditExport(c, id, 'admin PFX download');
    return new Response(pfx.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/x-pkcs12',
        'Content-Disposition': `attachment; filename="certificate-${id}.p12"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  routes.get('/api/v1/cert/orders/:id', requireCertificateSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const id = orderId(c.req.param('id'));
    const order = await loadOrder(c, id);
    if (!order) throw new AppError(404, '证书订单不存在', 'CERT_ORDER_NOT_FOUND');
    const renewals = await c.get('db').query<{ id: number; issued_at: number; expires_at: number; revoked_at: number | null }>(
      'SELECT id,issued_at,expires_at,revoked_at FROM cert_orders WHERE renewed_from=? ORDER BY id DESC LIMIT 20', [id],
    );
    const issuance = await c.get('db').query<{ id: number; status: string; updated_at: number }>(
      'SELECT id,status,updated_at FROM cert_acme_orders WHERE cert_order_id=? ORDER BY id DESC LIMIT 1', [id],
    );
    return c.json({ code: 0, item: publicOrder(order), renewals, issuance: issuance[0] ?? null });
  });

  routes.patch('/api/v1/cert/orders/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const id = orderId(c.req.param('id'));
    const body = await input(c);
    if (typeof body.isAuto !== 'boolean') throw new AppError(400, '请提供 isAuto 布尔值', 'INVALID_CERT_ORDER_UPDATE');
    const order = await loadOrder(c, id);
    if (!order) throw new AppError(404, '证书订单不存在', 'CERT_ORDER_NOT_FOUND');
    if (body.isAuto && order.revokedAt !== null) throw new AppError(409, '已吊销的证书不能开启自动续签', 'CERT_ORDER_REVOKED');
    const now = nowSeconds();
    await c.get('db').batch([
      { sql: 'UPDATE cert_orders SET is_auto=?,updated_at=? WHERE id=?', args: [body.isAuto ? 1 : 0, now, id] },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
        args: [c.get('principal').user.id, 'cert.order.auto', String(id), body.isAuto ? 'auto renewal enabled' : 'auto renewal disabled', now],
      },
    ]);
    return c.json({ code: 0, id, isAuto: body.isAuto });
  });

  routes.delete('/api/v1/cert/orders/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const id = orderId(c.req.param('id'));
    const order = await loadOrder(c, id);
    if (!order) throw new AppError(404, '证书订单不存在', 'CERT_ORDER_NOT_FOUND');
    const now = nowSeconds();
    await c.get('db').batch([
      { sql: 'UPDATE cert_acme_orders SET cert_order_id=NULL WHERE cert_order_id=?', args: [id] },
      { sql: 'UPDATE cert_orders SET renewed_from=NULL WHERE renewed_from=?', args: [id] },
      { sql: 'DELETE FROM cert_order_domains WHERE order_id=?', args: [id] },
      { sql: 'DELETE FROM cert_orders WHERE id=?', args: [id] },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
        args: [c.get('principal').user.id, 'cert.order.delete', String(id), `${order.domains.length} domains removed`, now],
      },
    ]);
    return c.json({ code: 0, id });
  });

  routes.post('/api/v1/cert/orders/:id/revoke', requireCertificateSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const id = orderId(c.req.param('id'));
    const order = await loadOrder(c, id);
    if (!order) throw new AppError(404, '证书订单不存在', 'CERT_ORDER_NOT_FOUND');
    if (order.revokedAt !== null) throw new AppError(409, '证书已标记吊销', 'CERT_ORDER_ALREADY_REVOKED');
    if (order.source !== 'acme') throw new AppError(501, '手动导入的证书无法通过本系统吊销', 'CERT_REVOKE_UNSUPPORTED');
    const rows = await c.get('db').query<{
      id: number; account_id: number; directory: AcmeEnvironment; directory_json: string | null;
      account_kid: string; account_key_cipher: string;
    }>(
      `SELECT id,account_id,directory,directory_json,account_kid,account_key_cipher
       FROM cert_acme_orders WHERE cert_order_id=? ORDER BY id DESC LIMIT 1`, [id],
    );
    const issuance = rows[0];
    if (!issuance) throw new AppError(409, '找不到对应的 ACME 签发任务', 'CERT_ACME_ORDER_MISSING');
    const apiDirectory = acmeDirectoryFrom(issuance);
    if (!apiDirectory.revokeCert) throw new AppError(501, '当前 CA 未声明吊销端点', 'CERT_REVOKE_UNSUPPORTED');
    const { fullchain } = await readMaterial(c, order);
    const certificate = certificateDerBase64Url(fullchain);
    let accountKey: string;
    try { accountKey = await decrypt(issuance.account_key_cipher, c.env.APP_KEY, `cert-acme-account/${issuance.account_id}/key`); }
    catch { throw new AppError(503, 'ACME 账户密钥无法解密', 'ACME_ACCOUNT_KEY_UNAVAILABLE'); }
    let revoked = false;
    try {
      const origin = new URL(apiDirectory.newNonce).origin;
      const nonce = await fetchAcmeNonce(c.env.BUDGET.fetch, origin, apiDirectory.newNonce);
      await postAcmeJws(c.env.BUDGET.fetch, {
        environment: issuance.directory, origin, privateKeyPem: accountKey, nonce,
        url: apiDirectory.revokeCert, payload: { certificate }, kid: issuance.account_kid,
      });
      revoked = true;
    } catch (error) {
      if (error instanceof AcmeProtocolError && error.problemType?.includes('alreadyRevoked')) revoked = true;
      else if (error instanceof AppError) throw error;
      else throw new AppError(503, 'CA 吊销结果未知，请先核对 CA 侧状态', 'ACME_OUTCOME_UNKNOWN');
    }
    if (!revoked) throw new AppError(503, 'CA 吊销结果未知，请先核对 CA 侧状态', 'ACME_OUTCOME_UNKNOWN');
    const now = nowSeconds();
    await c.get('db').batch([
      { sql: 'UPDATE cert_orders SET revoked_at=?,updated_at=? WHERE id=?', args: [now, now, id] },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
        args: [c.get('principal').user.id, 'cert.order.revoke', String(id), 'ACME certificate revoked', now],
      },
    ]);
    return c.json({ code: 0, id, revokedAt: now });
  });

  routes.post('/api/cert/order', requireLegacyApi, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const id = idFromLegacyBody(c.get('legacyApiBody'));
    const order = await loadOrder(c, id);
    if (!order) return c.json({ code: -1, msg: '证书订单不存在' });
    const { fullchain, privateKey } = await readMaterial(c, order);
    const pfx = exportLegacyPfx(fullchain, privateKey);
    await auditExport(c, id, 'legacy signed API export');
    return c.json({
      code: 0,
      data: {
        id: order.id, crt: fullchain, key: privateKey, pfx,
        issuetime: order.issuedAt, expiretime: order.expiresAt, domains: order.domains,
      },
    });
  });

  return routes;
}
