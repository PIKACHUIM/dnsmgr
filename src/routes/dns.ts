import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireSession, requireCsrf, requireAdmin, requireDomain, nowSeconds, consumeRateLimit } from '../security/auth';
import { decrypt, encrypt } from '../security/crypto';
import { DnsError, isRecordType, type DnsDomain, type DnsProvider, type DnsRecordInput } from '../dns/types';
import { createProvider, providerCatalog, providerMeta, validateProviderConfig } from '../dns/registry';
import type { SqlDatabase } from '../storage/sql';

interface AccountRow extends Record<string, unknown> {
  id: number;
  type: string;
  name: string;
  config_cipher: string;
  remark: string | null;
  created_at: number;
  updated_at: number;
}

interface DomainRow extends Record<string, unknown> {
  id: number;
  account_id: number;
  name: string;
  third_id: string | null;
  category_id: number | null;
  hidden: number;
  notice: number;
  remark: string | null;
  record_count: number;
  expires_at: number | null;
  checked_at: number | null;
  check_status: number;
}

const DOMAIN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const RECORD_NAME = /^(?:@|\*|(?:\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)$/i;

function id(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value)) throw new AppError(400, '编号无效', 'INVALID_ID');
  return Number(value);
}

function db(c: Context<AppEnv>): SqlDatabase {
  return c.get('db');
}

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持 DNS 业务表，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

function providerFetch(c: Context<AppEnv>): typeof fetch {
  return c.env.BUDGET?.fetch ?? fetch;
}

async function audit(c: Context<AppEnv>, action: string, target: string, detail: string): Promise<void> {
  await db(c).execute(
    'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
    [c.get('principal').user.id, action, target.slice(0, 255), detail.slice(0, 500), nowSeconds()],
  );
}

function providerError(error: unknown): never {
  if (error instanceof DnsError) {
    const direct = [400, 401, 403, 404, 409, 429, 501].includes(error.status)
      ? error.status as 400 | 401 | 403 | 404 | 409 | 429 | 501
      : 503;
    throw new AppError(direct, error.message, error.code);
  }
  throw error;
}

async function providerFor(c: Context<AppEnv>, account: AccountRow): Promise<DnsProvider> {
  let config: unknown;
  try {
    config = JSON.parse(await decrypt(account.config_cipher, c.env.APP_KEY, `dns-account/${account.id}`));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'DNS 账户凭据损坏，无法解密', 'ACCOUNT_CORRUPTED');
  }
  return createProvider(account.type, config as Record<string, string>, providerFetch(c));
}

async function account(c: Context<AppEnv>, accountId: number): Promise<AccountRow> {
  const rows = await db(c).query<AccountRow>('SELECT * FROM dns_accounts WHERE id = ?', [accountId]);
  const row = rows[0];
  if (!row) throw new AppError(404, 'DNS 账户不存在', 'ACCOUNT_NOT_FOUND');
  return row;
}

async function domainRow(c: Context<AppEnv>, domainId: number): Promise<{ domain: DomainRow; account: AccountRow }> {
  const rows = await db(c).query<DomainRow>('SELECT * FROM dns_domains WHERE id = ?', [domainId]);
  const domain = rows[0];
  if (!domain) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
  return { domain, account: await account(c, domain.account_id) };
}

function toDnsDomain(row: { third_id: string | null; name: string }): DnsDomain {
  return { id: row.third_id ?? '', name: row.name, recordCount: 0 };
}

function pageParams(c: Context<AppEnv>): { page: number; pageSize: number } {
  const page = c.req.query('page') ?? '1';
  const pageSize = c.req.query('pageSize') ?? '20';
  if (!/^\d{1,4}$/.test(page) || !/^\d{1,3}$/.test(pageSize)) throw new AppError(400, '分页参数无效', 'INVALID_PAGE');
  const parsed = { page: Math.max(1, Number(page)), pageSize: Math.min(100, Math.max(1, Number(pageSize))) };
  return parsed;
}

function recordInput(body: Record<string, unknown>): DnsRecordInput {
  const name = text(body, 'name', 128).trim();
  if (!RECORD_NAME.test(name)) throw new AppError(400, '主机记录格式无效', 'INVALID_RECORD_NAME');
  const type = text(body, 'type', 16).trim().toUpperCase();
  if (!isRecordType(type)) throw new AppError(400, '不支持的记录类型', 'INVALID_RECORD_TYPE');
  const value = text(body, 'value', 2048).trim();
  if (!value) throw new AppError(400, '记录值不能为空', 'INVALID_RECORD_VALUE');
  const line = typeof body.line === 'string' && body.line.trim() ? body.line.trim().slice(0, 64) : 'default';
  const ttl = Number(body.ttl ?? 600);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw new AppError(400, 'TTL 必须在 1–86400 之间', 'INVALID_TTL');
  const mxRaw = body.mx === undefined || body.mx === null || body.mx === '' ? null : Number(body.mx);
  if (mxRaw !== null && (!Number.isSafeInteger(mxRaw) || mxRaw < 0 || mxRaw > 65535)) throw new AppError(400, 'MX 优先级无效', 'INVALID_MX');
  const weightRaw = body.weight === undefined || body.weight === null || body.weight === '' ? null : Number(body.weight);
  if (weightRaw !== null && (!Number.isSafeInteger(weightRaw) || weightRaw < 0 || weightRaw > 65535)) throw new AppError(400, '权重无效', 'INVALID_WEIGHT');
  const remarkRaw = typeof body.remark === 'string' ? body.remark.trim() : '';
  if (remarkRaw.length > 100) throw new AppError(400, '备注最多 100 字', 'INVALID_REMARK');
  return { name, type, value, line, ttl, mx: mxRaw, weight: weightRaw, remark: remarkRaw || null };
}

export function dnsRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/dns/providers', requireSession, (c) => c.json({ code: 0, ...providerCatalog() }));

  routes.get('/api/v1/dns/accounts', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const rows = await db(c).query<AccountRow & { domain_count: number }>(
      `SELECT a.*, (SELECT COUNT(*) FROM dns_domains d WHERE d.account_id = a.id) AS domain_count
       FROM dns_accounts a ORDER BY a.id DESC`,
    );
    return c.json({
      code: 0,
      items: rows.map((row) => ({
        id: row.id, type: row.type, name: row.name, remark: row.remark,
        domainCount: Number(row.domain_count), createdAt: row.created_at, updatedAt: row.updated_at,
      })),
    });
  });

  routes.post('/api/v1/dns/accounts', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const type = text(body, 'type', 20);
    let meta;
    try { meta = providerMeta(type); } catch (error) { providerError(error); }
    if (!meta.supported) throw new AppError(501, `DNS 驱动 ${type} 尚未移植`, 'DNS_PROVIDER_NOT_PORTED');
    const name = text(body, 'name', 64).trim();
    if (!/^[\p{L}\p{N}_.@ -]{1,64}$/u.test(name)) throw new AppError(400, '账户名称格式无效', 'INVALID_ACCOUNT_NAME');
    let config: Record<string, string>;
    try { config = validateProviderConfig(type, body.config); } catch (error) { providerError(error); }
    const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) : null;
    let provider: DnsProvider;
    try { provider = createProvider(type, config, providerFetch(c)); } catch (error) { providerError(error); }
    try { await provider.check(); } catch (error) { providerError(error); }
    const now = nowSeconds();
    const cipher = await encrypt(JSON.stringify(config), c.env.APP_KEY, 'dns-account/pending');
    const result = await db(c).execute(
      'INSERT INTO dns_accounts (type, name, config_cipher, remark, created_at, updated_at) VALUES (?,?,?,?,?,?) RETURNING id',
      [type, name, cipher, remark, now, now],
    );
    const created = Number(result.rows[0]?.id);
    // 加密用途绑定账户 ID，创建后立即重写一次密文。
    await db(c).execute('UPDATE dns_accounts SET config_cipher = ? WHERE id = ?',
      [await encrypt(JSON.stringify(config), c.env.APP_KEY, `dns-account/${created}`), created]);
    await audit(c, 'account.create', name, `type=${type}`);
    return c.json({ code: 0, id: created });
  });

  routes.put('/api/v1/dns/accounts/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const accountId = id(c.req.param('id'));
    const current = await account(c, accountId);
    const body = await input(c);
    const name = text(body, 'name', 64).trim();
    if (!/^[\p{L}\p{N}_.@ -]{1,64}$/u.test(name)) throw new AppError(400, '账户名称格式无效', 'INVALID_ACCOUNT_NAME');
    let config: Record<string, string>;
    try { config = validateProviderConfig(current.type, body.config); } catch (error) { providerError(error); }
    const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) : null;
    let provider: DnsProvider;
    try { provider = createProvider(current.type, config, providerFetch(c)); } catch (error) { providerError(error); }
    try { await provider.check(); } catch (error) { providerError(error); }
    await db(c).execute(
      'UPDATE dns_accounts SET name=?, config_cipher=?, remark=?, updated_at=? WHERE id=?',
      [name, await encrypt(JSON.stringify(config), c.env.APP_KEY, `dns-account/${accountId}`), remark, nowSeconds(), accountId],
    );
    await audit(c, 'account.update', name, `type=${current.type}`);
    return c.json({ code: 0 });
  });

  routes.delete('/api/v1/dns/accounts/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const accountId = id(c.req.param('id'));
    const current = await account(c, accountId);
    const domains = await db(c).query<{ n: number }>('SELECT COUNT(*) AS n FROM dns_domains WHERE account_id = ?', [accountId]);
    if (Number(domains[0]?.n ?? 0) > 0) throw new AppError(409, '该账户下仍有域名，请先移除域名', 'ACCOUNT_NOT_EMPTY');
    await db(c).execute('DELETE FROM dns_accounts WHERE id = ?', [accountId]);
    await audit(c, 'account.delete', current.name, `type=${current.type}`);
    return c.json({ code: 0 });
  });

  routes.post('/api/v1/dns/accounts/:id/check', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const current = await account(c, id(c.req.param('id')));
    const provider = await providerFor(c, current);
    try { await provider.check(); } catch (error) { providerError(error); }
    return c.json({ code: 0, msg: '凭据验证通过' });
  });

  routes.get('/api/v1/dns/accounts/:id/remote-domains', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const current = await account(c, id(c.req.param('id')));
    const provider = await providerFor(c, current);
    const { page, pageSize } = pageParams(c);
    const keyword = c.req.query('keyword')?.trim().slice(0, 64);
    try {
      const result = await provider.listDomains({ page, pageSize, keyword });
      return c.json({ code: 0, ...result });
    } catch (error) { providerError(error); }
  });

  routes.post('/api/v1/dns/accounts/:id/sync', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const current = await account(c, id(c.req.param('id')));
    const body = await input(c);
    const domains = Array.isArray(body.domains) ? body.domains : [];
    if (domains.length === 0 || domains.length > 50) throw new AppError(400, '一次需同步 1–50 个域名', 'INVALID_SYNC');
    const now = nowSeconds();
    let imported = 0;
    for (const raw of domains) {
      if (!raw || typeof raw !== 'object') throw new AppError(400, '同步数据格式无效', 'INVALID_SYNC');
      const item = raw as Record<string, unknown>;
      const domainName = String(item.name ?? '').toLowerCase();
      if (!DOMAIN_NAME.test(domainName)) throw new AppError(400, `域名 ${domainName} 格式无效`, 'INVALID_DOMAIN_NAME');
      const thirdId = typeof item.id === 'string' ? item.id.slice(0, 64) : '';
      const result = await db(c).execute(
        `INSERT INTO dns_domains (account_id, name, third_id, record_count, created_at, updated_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO NOTHING RETURNING id`,
        [current.id, domainName, thirdId, Number(item.recordCount) || 0, now, now],
      );
      if (result.changes === 1) imported++;
    }
    await audit(c, 'domain.sync', current.name, `${domains.length} requested, ${imported} imported`);    return c.json({ code: 0, imported, skipped: domains.length - imported });
  });

  routes.get('/api/v1/dns/domains', requireSession, async (c) => {
    requireSql(c);
    const { page, pageSize } = pageParams(c);
    const keyword = c.req.query('keyword')?.trim().slice(0, 64) ?? '';
    const principal = c.get('principal');
    const where = ['1=1'];
    const args: (string | number)[] = [];
    if (keyword) { where.push('d.name LIKE ?'); args.push(`%${keyword}%`); }
    if (principal.user.level !== 2) {
      where.push('EXISTS (SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT))');
      args.push(principal.user.id);
    }
    const rows = await db(c).query<DomainRow & { account_name: string; account_type: string }>(
      `SELECT d.*, a.name AS account_name, a.type AS account_type FROM dns_domains d
       JOIN dns_accounts a ON a.id = d.account_id WHERE ${where.join(' AND ')}
       ORDER BY d.id DESC LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize],
    );
    const total = await db(c).query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM dns_domains d WHERE ${where.join(' AND ')}`, args,
    );
    return c.json({
      code: 0, page, pageSize, total: Number(total[0]?.n ?? 0),
      items: rows.map((row) => ({
        id: row.id, name: row.name, accountId: row.account_id, accountName: row.account_name,
        accountType: row.account_type, remark: row.remark, recordCount: row.record_count,
        hidden: row.hidden === 1, notice: row.notice === 1, thirdId: row.third_id,
        categoryId: row.category_id, expiresAt: row.expires_at, checkStatus: row.check_status,
      })),
    });
  });

  routes.post('/api/v1/dns/domains', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const accountId = Number(body.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 1) throw new AppError(400, '账户编号无效', 'INVALID_ID');
    const current = await account(c, accountId);
    const name = text(body, 'name', 253).trim().toLowerCase();
    if (!DOMAIN_NAME.test(name)) throw new AppError(400, '域名格式无效', 'INVALID_DOMAIN_NAME');
    const provider = await providerFor(c, current);
    let remote: DnsDomain;
    try { remote = await provider.addDomain(name); } catch (error) { providerError(error); }
    const now = nowSeconds();
    const result = await db(c).execute(
      `INSERT INTO dns_domains (account_id, name, third_id, created_at, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO NOTHING RETURNING id`,
      [accountId, name, remote.id.slice(0, 64), now, now],
    );
    if (result.changes !== 1) throw new AppError(409, '该域名已存在', 'DOMAIN_EXISTS');
    const created = Number(result.rows[0]?.id);
    await audit(c, 'domain.create', name, `account=${accountId}`);
    return c.json({ code: 0, id: created, name: remote.name || name });
  });

  routes.patch('/api/v1/dns/domains/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const body = await input(c);
    const fields: string[] = [];
    const args: (string | number | null)[] = [];
    if (body.remark !== undefined) {
      const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) : '';
      fields.push('remark=?'); args.push(remark || null);
    }
    if (body.hidden !== undefined) { fields.push('hidden=?'); args.push(body.hidden === true ? 1 : 0); }
    if (body.notice !== undefined) { fields.push('notice=?'); args.push(body.notice === true ? 1 : 0); }
    if (fields.length === 0) throw new AppError(400, '没有需要修改的字段', 'EMPTY_UPDATE');
    fields.push('updated_at=?'); args.push(nowSeconds());
    await db(c).execute(`UPDATE dns_domains SET ${fields.join(',')} WHERE id=?`, [...args, domainId]);
    await audit(c, 'domain.update', c.req.param('id'), fields.join(','));
    return c.json({ code: 0 });
  });

  routes.get('/api/v1/dns/domains/:id', requireSession, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const { domain, account: owner } = await domainRow(c, domainId);
    return c.json({
      code: 0,
      domain: {
        id: domain.id, name: domain.name, accountId: domain.account_id, accountName: owner.name,
        accountType: owner.type, thirdId: domain.third_id, remark: domain.remark, recordCount: domain.record_count,
      },
    });
  });

  routes.get('/api/v1/dns/domains/:id/records', requireSession, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    const { page, pageSize } = pageParams(c);
    const status = c.req.query('status');
    if (status !== undefined && status !== '0' && status !== '1') throw new AppError(400, '状态参数无效', 'INVALID_STATUS');
    try {
      const result = await provider.listRecords(toDnsDomain(domain), {
        page, pageSize,
        keyword: c.req.query('keyword')?.slice(0, 128),
        name: c.req.query('name')?.slice(0, 128),
        value: c.req.query('value')?.slice(0, 255),
        type: c.req.query('type')?.toUpperCase().slice(0, 16),
        line: c.req.query('line')?.slice(0, 64),
        status: status as '0' | '1' | undefined,
      });
      return c.json({ code: 0, page, pageSize, ...result });
    } catch (error) { providerError(error); }
  });

  routes.get('/api/v1/dns/domains/:id/lines', requireSession, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    try {
      const [lines, minTtl] = await Promise.all([
        provider.recordLines(toDnsDomain(domain)),
        provider.minTtl(toDnsDomain(domain)),
      ]);
      return c.json({ code: 0, lines, minTtl });
    } catch (error) { providerError(error); }
  });

  routes.post('/api/v1/dns/domains/:id/records', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 120, 60);
    const { domain, account: owner } = await domainRow(c, domainId);
    const inputData = recordInput(await input(c));
    const provider = await providerFor(c, owner);
    let recordId: string;
    try { recordId = await provider.addRecord(toDnsDomain(domain), inputData); } catch (error) { providerError(error); }
    await audit(c, 'record.create', domain.name, `${inputData.type} ${inputData.name} ${inputData.value}`.slice(0, 500));
    return c.json({ code: 0, id: recordId });
  });

  routes.put('/api/v1/dns/domains/:id/records/:recordId', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 120, 60);
    const { domain, account: owner } = await domainRow(c, domainId);
    const recordId = c.req.param('recordId');
    if (!/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    const inputData = recordInput(await input(c));
    const provider = await providerFor(c, owner);
    try { await provider.updateRecord(toDnsDomain(domain), recordId, inputData); } catch (error) { providerError(error); }
    await audit(c, 'record.update', domain.name, `${recordId} ${inputData.type} ${inputData.name}`);
    return c.json({ code: 0 });
  });

  routes.delete('/api/v1/dns/domains/:id/records/:recordId', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 120, 60);
    const { domain, account: owner } = await domainRow(c, domainId);
    const recordId = c.req.param('recordId');
    if (!/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    const provider = await providerFor(c, owner);
    try { await provider.deleteRecord(toDnsDomain(domain), recordId); } catch (error) { providerError(error); }
    await audit(c, 'record.delete', domain.name, recordId);
    return c.json({ code: 0 });
  });

  routes.post('/api/v1/dns/domains/:id/records/:recordId/status', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    const { domain, account: owner } = await domainRow(c, domainId);
    const recordId = c.req.param('recordId');
    if (!/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    const body = await input(c);
    if (typeof body.enabled !== 'boolean') throw new AppError(400, '状态参数无效', 'INVALID_STATUS');
    const provider = await providerFor(c, owner);
    try { await provider.setRecordStatus(toDnsDomain(domain), recordId, body.enabled); } catch (error) { providerError(error); }
    await audit(c, 'record.status', domain.name, `${recordId} ${body.enabled ? 'enable' : 'disable'}`);
    return c.json({ code: 0 });
  });

  routes.post('/api/v1/dns/domains/:id/records/:recordId/remark', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    const { domain, account: owner } = await domainRow(c, domainId);
    const recordId = c.req.param('recordId');
    if (!/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    const body = await input(c);
    const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) : '';
    const provider = await providerFor(c, owner);
    try { await provider.setRecordRemark(toDnsDomain(domain), recordId, remark || null); } catch (error) { providerError(error); }
    await audit(c, 'record.remark', domain.name, `${recordId} ${remark}`.slice(0, 500));
    return c.json({ code: 0 });
  });

  return routes;
}
