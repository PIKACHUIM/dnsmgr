import type { Context } from 'hono';
import type { AppEnv, Bindings } from '../core/types';
import type { SqlDatabase } from '../storage/sql';
import { AppError } from '../core/errors';
import { nowSeconds } from '../security/auth';
import { encrypt } from '../security/crypto';
import { createCertificateKeyAndCsr, fetchAcmeNonce, type AcmeDirectory, type AcmeEnvironment } from '../certificates/acme';
import { CERT_NOTIFY_ENABLED, queueNotification } from '../notify/certificate';
import {
  stepAddDns, stepAuthorize, stepCleanupDns, stepFetchCertificate, stepFinalize,
  stepPlaceOrder, stepPollAuthorization, stepPollOrder, stepTrigger,
} from '../routes/certificate-acme';

export const CERT_RENEW_ENABLED = 'cert_renew_enabled';
export const CERT_RENEW_DAYS = 'cert_renew_days';
const defaultRenewDays = 7;

interface RenewalSettings {
  enabled: boolean;
  days: number;
  notifyEnabled: boolean;
}

interface SourceOrderRow extends Record<string, unknown> {
  id: number;
  created_by: number;
  expires_at: number;
}

interface SourceIssuanceRow extends Record<string, unknown> {
  id: number;
  account_id: number;
  dns_domain_id: number;
  dns_account_id: number;
  directory: AcmeEnvironment;
  directory_json: string;
  account_kid: string;
  account_key_cipher: string;
  dns_config_cipher: string;
  dns_zone_name: string;
  dns_zone_remote_id: string;
  status: string;
  updated_at: number;
  renewal_of: number | null;
  challenge_map_json: string;
}

interface AccountRow extends Record<string, unknown> {
  id: number;
  directory: AcmeEnvironment;
  directory_json: string | null;
  status: string;
  replay_nonce: string | null;
  claimed_nonce: string | null;
  claimed_at: number | null;
}

function newId(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return Number(value & BigInt(Number.MAX_SAFE_INTEGER)) || 1;
}

function stepContext(env: Bindings, db: SqlDatabase, userId: number, orderId: number): Context<AppEnv> {
  return {
    env,
    get: (key: string) => key === 'db' ? db
      : key === 'principal' ? { user: { id: userId, level: 2 } }
        : undefined,
    req: { param: () => String(orderId) },
    json: (value: unknown, status = 200) => Response.json(value, { status }),
  } as unknown as Context<AppEnv>;
}

export async function readCertificateRenewSettings(db: SqlDatabase): Promise<RenewalSettings> {
  const rows = await db.query<{ key: string; value: string }>(
    'SELECT key,value FROM app_settings WHERE key IN (?,?,?)', [CERT_RENEW_ENABLED, CERT_RENEW_DAYS, CERT_NOTIFY_ENABLED],
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const rawDays = Number(values.get(CERT_RENEW_DAYS) ?? defaultRenewDays);
  return {
    enabled: values.get(CERT_RENEW_ENABLED) !== '0',
    days: Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 60 ? rawDays : defaultRenewDays,
    notifyEnabled: values.get(CERT_NOTIFY_ENABLED) !== '0',
  };
}

function acmeDirectory(row: { directory: AcmeEnvironment; directory_json: string | null }): AcmeDirectory {
  if (!row.directory_json) throw new AppError(409, '续签账户缺少 ACME Directory', 'ACME_DIRECTORY_REQUIRED');
  let raw: unknown;
  try { raw = JSON.parse(row.directory_json); } catch { throw new AppError(503, 'ACME Directory 状态损坏', 'ACME_DIRECTORY_CORRUPT'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(503, 'ACME Directory 状态损坏', 'ACME_DIRECTORY_CORRUPT');
  const value = raw as Record<string, unknown>;
  return {
    newNonce: String(value.newNonce ?? ''),
    newAccount: String(value.newAccount ?? ''),
    newOrder: String(value.newOrder ?? ''),
  };
}

async function advance(env: Bindings, db: SqlDatabase, row: SourceIssuanceRow, userId: number): Promise<string> {
  const context = stepContext(env, db, userId, row.id);
  switch (row.status) {
    case 'draft': await stepPlaceOrder(context); break;
    case 'authorizing': await stepAuthorize(context); break;
    case 'challenge_ready': await stepAddDns(context); break;
    case 'dns_present':
      if (nowSeconds() - row.updated_at < 60) return 'dns_present';
      await stepTrigger(context); break;
    case 'submitted':
    case 'triggering': await stepPollAuthorization(context); break;
    case 'authorization_valid': await stepCleanupDns(context); break;
    case 'ready_to_finalize': await stepFinalize(context); break;
    case 'processing': await stepPollOrder(context); break;
    case 'certificate_ready': await stepFetchCertificate(context); break;
    case 'failed':
    case 'cancelled':
    case 'outcome_unknown':
    case 'issued': return row.status;
    default: return row.status;
  }
  const updated = await db.query<{ status: string }>('SELECT status FROM cert_acme_orders WHERE id=?', [row.id]);
  return updated[0]?.status ?? 'unknown';
}

async function createRenewalOrder(
  env: Bindings, db: SqlDatabase, source: SourceOrderRow, issuance: SourceIssuanceRow,
): Promise<number> {
  const domains = (await db.query<{ domain: string }>(
    'SELECT domain FROM cert_order_domains WHERE order_id=? ORDER BY sort', [source.id],
  )).map((row) => row.domain);
  if (domains.length === 0) throw new AppError(409, '源证书订单没有域名', 'ACME_RENEW_SOURCE_INVALID');
  const accounts = await db.query<AccountRow>('SELECT * FROM cert_acme_accounts WHERE id=?', [issuance.account_id]);
  const account = accounts[0];
  if (!account || account.status !== 'ready') throw new AppError(409, '续签 ACME 账户不可用', 'ACME_ACCOUNT_NOT_READY');
  const apiDirectory = acmeDirectory(account);
  let claimed = await db.execute(
    `UPDATE cert_acme_accounts SET claimed_nonce=replay_nonce,replay_nonce=NULL,claimed_at=?,updated_at=?
     WHERE id=? AND status='ready' AND replay_nonce IS NOT NULL AND claimed_nonce IS NULL
      AND (claimed_at IS NULL OR claimed_at<=?) RETURNING claimed_nonce`,
    [nowSeconds(), nowSeconds(), account.id, nowSeconds() - 60],
  );
  if (!claimed.rows[0]) {
    const nonce = await fetchAcmeNonce(env.BUDGET?.fetch ?? fetch, account.directory, apiDirectory.newNonce);
    await db.execute(
      `UPDATE cert_acme_accounts SET replay_nonce=? WHERE id=? AND status='ready' AND replay_nonce IS NULL`,
      [nonce, account.id],
    );
    claimed = await db.execute(
      `UPDATE cert_acme_accounts SET claimed_nonce=replay_nonce,replay_nonce=NULL,claimed_at=?,updated_at=?
       WHERE id=? AND status='ready' AND replay_nonce IS NOT NULL AND claimed_nonce IS NULL RETURNING claimed_nonce`,
      [nowSeconds(), nowSeconds(), account.id],
    );
  }
  const nonce = claimed.rows[0]?.claimed_nonce as string | undefined;
  if (!nonce) throw new AppError(409, '续签账户的一次性 nonce 已被占用', 'ACME_NONCE_REQUIRED');

  const orderId = newId();
  const now = nowSeconds();
  const generated = createCertificateKeyAndCsr(domains);
  const privateKeyCipher = await encrypt(generated.privateKey, env.APP_KEY, `cert-acme-order/${orderId}/private-key`);
  await db.batch([
    {
      sql: `INSERT INTO cert_acme_orders
        (id,account_id,dns_domain_id,dns_account_id,dns_config_cipher,dns_zone_name,dns_zone_remote_id,created_by,
         directory,directory_json,account_kid,account_key_cipher,replay_nonce,claimed_nonce,claimed_at,domains_json,
         authorization_state_json,authorization_index,status,remote_order_url,finalize_url,certificate_url,csr_der,
         private_key_cipher,cert_order_id,last_error,created_at,updated_at,renewal_of,challenge_map_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,?,?,?,?,?)`,
      args: [orderId, issuance.account_id, issuance.dns_domain_id, issuance.dns_account_id, issuance.dns_config_cipher,
        issuance.dns_zone_name, issuance.dns_zone_remote_id, source.created_by, issuance.directory, issuance.directory_json,
        issuance.account_kid, issuance.account_key_cipher, nonce, null, null, JSON.stringify(domains), '[]', 0, 'draft',
        generated.csrDer, privateKeyCipher, null, now, now, source.id, issuance.challenge_map_json ?? '{}'],
    },
    {
      sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      args: [source.created_by, 'cert.acme.renew.create', String(orderId), `${domains.length} identifiers for certificate order ${source.id}`, now],
    },
  ]);
  return orderId;
}

export async function executeCertificateRenewal(
  env: Bindings, db: SqlDatabase,
): Promise<{ processed: boolean; detail: string }> {
  const settings = await readCertificateRenewSettings(db);
  if (!settings.enabled) return { processed: false, detail: 'certificate auto renewal disabled' };

  const active = await db.query<SourceIssuanceRow>(
    `SELECT id,account_id,dns_domain_id,dns_account_id,directory,directory_json,account_kid,account_key_cipher,
       dns_config_cipher,dns_zone_name,dns_zone_remote_id,status,updated_at,renewal_of,challenge_map_json
     FROM cert_acme_orders
     WHERE renewal_of IS NOT NULL AND status NOT IN ('issued','failed','cancelled','outcome_unknown')
     ORDER BY updated_at ASC,id ASC LIMIT 1`,
  );
  if (active[0]) {
    const row = active[0];
    try {
      const status = await advance(env, db, row, await sourceOwner(db, row.renewal_of ?? 0));
      return { processed: true, detail: `续签任务 ${row.id} 推进到 ${status}` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown';
      await queueNotification(
        db, 'certificate', 'SSL 证书续签失败',
        `续签任务 #${row.id} 未完成：${detail}。请登录后台核对 CA 与 DNS 状态。`,
      );
      return { processed: true, detail: `续签任务 ${row.id} 未完成：${detail}` };
    }
  }

  const deadline = nowSeconds() + settings.days * 86_400;
  const due = await db.query<SourceOrderRow>(
    `SELECT o.id,o.created_by,o.expires_at FROM cert_orders o
     WHERE o.is_auto=1 AND o.revoked_at IS NULL AND o.expires_at<=?
       AND NOT EXISTS (SELECT 1 FROM cert_acme_orders a WHERE a.renewal_of=o.id AND a.status NOT IN ('issued','failed','cancelled','outcome_unknown'))
     ORDER BY o.expires_at ASC,o.id ASC LIMIT 1`, [deadline],
  );
  const source = due[0];
  if (!source) return { processed: false, detail: 'no certificate due for renewal' };

  const issuances = await db.query<SourceIssuanceRow>(
    `SELECT id,account_id,dns_domain_id,dns_account_id,directory,directory_json,account_kid,account_key_cipher,
       dns_config_cipher,dns_zone_name,dns_zone_remote_id,status,updated_at,renewal_of,challenge_map_json
     FROM cert_acme_orders WHERE cert_order_id=? ORDER BY id DESC LIMIT 1`, [source.id],
  );
  const issuance = issuances[0];
  if (!issuance) return { processed: false, detail: `证书订单 ${source.id} 缺少 ACME 签发来源，无法自动续签` };

  try {
    const orderId = await createRenewalOrder(env, db, source, issuance);
    const rows = await db.query<SourceIssuanceRow>(
      `SELECT id,account_id,dns_domain_id,dns_account_id,directory,directory_json,account_kid,account_key_cipher,
         dns_config_cipher,dns_zone_name,dns_zone_remote_id,status,updated_at,renewal_of,challenge_map_json
       FROM cert_acme_orders WHERE id=?`, [orderId],
    );
    const status = rows[0] ? await advance(env, db, rows[0], source.created_by) : 'draft';
    return { processed: true, detail: `已为证书订单 ${source.id} 创建续签任务 ${orderId}，状态 ${status}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown';
    await queueNotification(
      db, 'certificate', 'SSL 证书续签失败',
      `证书订单 #${source.id} 的续签未能启动：${detail}。请登录后台核对 ACME 账户与 DNS Zone。`,
    );
    return { processed: false, detail: `证书订单 ${source.id} 续签未启动：${detail}` };
  }
}

async function sourceOwner(db: SqlDatabase, orderId: number): Promise<number> {
  const rows = await db.query<{ created_by: number }>('SELECT created_by FROM cert_orders WHERE id=?', [orderId]);
  return rows[0]?.created_by ?? 1;
}
