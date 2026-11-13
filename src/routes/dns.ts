import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireSession, requireCsrf, requireAdmin, requireDomain, requireLegacyApi, requireLegacyApiDomain, nowSeconds, consumeRateLimit } from '../security/auth';
import { md5 } from 'js-md5';
import { decrypt, encrypt, randomToken, sha256 } from '../security/crypto';
import { DnsError, isRecordType, type DnsDomain, type DnsProvider, type DnsRecord, type DnsRecordInput, type RecordQuery } from '../dns/types';
import { createProvider, providerCatalog, providerMeta, validateProviderConfig } from '../dns/registry';
import { lookupDomainExpiration } from '../dns/expiration';
import { checkDnsRecordValue, isDnsCheckType, lookupPublicDnsRecords } from '../dns/record-check';
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
  category_name?: string | null;
}

interface LegacyDomainRow extends Record<string, unknown> {
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
  notice_attempted_at: number | null;
  check_status: number;
  created_at: number;
  account_type: string;
  account_remark: string | null;
  category_name: string | null;
}

interface LegacyDomainDetailRow extends DomainRow {
  created_at: number;
  notice_attempted_at: number | null;
  owner_id: number;
  owner_type: string;
  owner_name: string;
  owner_config_cipher: string;
  owner_remark: string | null;
  owner_created_at: number;
  owner_updated_at: number;
}

interface LegacyRecordDomainRow extends Record<string, unknown> {
  id: number;
  account_id: number;
  name: string;
  third_id: string | null;
  owner_id: number;
  owner_type: string;
  owner_name: string;
  owner_config_cipher: string;
  owner_remark: string | null;
  owner_created_at: number;
  owner_updated_at: number;
}

const LEGACY_PROVIDER_NAMES: Record<string, string> = {
  aliyun: '阿里云', dnspod: '腾讯云', huawei: '华为云', baidu: '百度云', west: '西部数码',
  huoshan: '火山引擎', jdcloud: '京东云', dnsla: 'DNSLA', qingcloud: '青云', bt: '宝塔域名',
  cloudflare: 'Cloudflare', aws: 'AWS Route 53', namesilo: 'NameSilo', henet: 'HE DNS', spaceship: 'Spaceship',
  powerdns: 'PowerDNS', technitium: 'Technitium', aliyunesa: '阿里云ESA', tencenteo: '腾讯云EO',
  dnsmgr: '同系统对接', goedge: 'GoEdge智能DNS', dynv6: 'dynv6',
};
const LEGACY_PROVIDER_ICONS: Record<string, string> = {
  aliyun: 'aliyun.png', dnspod: 'dnspod.ico', huawei: 'huawei.ico', baidu: 'baidu.ico', west: 'west.ico',
  huoshan: 'huoshan.ico', jdcloud: 'jdcloud.ico', dnsla: 'dnsla.ico', qingcloud: 'qingcloud.ico', bt: 'bt.png',
  cloudflare: 'cloudflare.ico', aws: 'aws.png', namesilo: 'namesilo.ico', henet: 'he.ico', spaceship: 'spaceship.ico',
  powerdns: 'powerdns.ico', technitium: 'technitium.png', aliyunesa: 'aliyun.png', tencenteo: 'tencent.png',
  dnsmgr: 'logo.png', goedge: 'logo.png', dynv6: 'dynv6.ico',
};
const LEGACY_ALIAS_RECORD_TYPES = new Set(['aliyun', 'henet', 'powerdns', 'spaceship']);
// GoEdge 读取线路需要 1 次 AccessToken 请求加 5 次线路请求，超出 ESA 单请求 4 次 fetch 上限。
const LEGACY_ESA_DETAIL_UNSUPPORTED_PROVIDERS = new Set(['goedge']);
const LEGACY_CLIENT_PAGINATION_PROVIDERS = new Set(['aws', 'baidu', 'henet', 'namesilo', 'powerdns', 'technitium']);
const LEGACY_RECORD_SORT_COLUMNS = new Set(['Name', 'Type', 'LineName', 'Value', 'UpdateTime']);
const LEGACY_QUICKLOGIN_SECONDS = 300;
const LEGACY_RECORD_SORT_MAX = 2000;
const LEGACY_RECORD_SORT_MAX_ESA = 300;

function legacyText(body: Record<string, unknown>, key: string, maxLength = 256): string {
  const value = body[key];
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    throw new AppError(400, `${key} 格式无效`, 'INVALID_LEGACY_API_PARAMETER');
  }
  return String(value).trim().slice(0, maxLength);
}

function legacyInteger(value: string, key: string, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new AppError(400, `${key} 格式无效`, 'INVALID_LEGACY_API_PARAMETER');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(400, `${key} 超出允许范围`, 'INVALID_LEGACY_API_PARAMETER');
  }
  return parsed;
}

function legacyDateTime(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date((value + 8 * 60 * 60) * 1000).toISOString();
  return `${date.slice(0, 10)} ${date.slice(11, 19)}`;
}

function legacyProviderName(type: string): string {
  return LEGACY_PROVIDER_NAMES[type] ?? (type || '未知');
}

const DOMAIN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SUBDOMAIN_NAME = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
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

async function legacyRecordDomain(c: Context<AppEnv>, domainId: number): Promise<LegacyRecordDomainRow> {
  const principal = c.get('principal');
  const permission = principal.user.level === 2 ? '' : `AND EXISTS (
    SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT)
  )`;
  const args: (string | number)[] = [domainId];
  if (permission) args.push(principal.user.id);
  const rows = await db(c).query<LegacyRecordDomainRow>(
    `SELECT d.id, d.account_id, d.name, d.third_id, a.id AS owner_id, a.type AS owner_type,
      a.name AS owner_name, a.config_cipher AS owner_config_cipher, a.remark AS owner_remark,
      a.created_at AS owner_created_at, a.updated_at AS owner_updated_at
     FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id
     WHERE d.id=? ${permission}`,
    args,
  );
  if (!rows[0]) throw new AppError(404, '域名不存在或无权访问', 'DOMAIN_NOT_FOUND');
  return rows[0];
}

function legacyOwner(domain: LegacyRecordDomainRow): AccountRow {
  return {
    id: domain.owner_id, type: domain.owner_type, name: domain.owner_name,
    config_cipher: domain.owner_config_cipher, remark: domain.owner_remark,
    created_at: domain.owner_created_at, updated_at: domain.owner_updated_at,
  };
}

async function account(c: Context<AppEnv>, accountId: number): Promise<AccountRow> {
  const rows = await db(c).query<AccountRow>('SELECT * FROM dns_accounts WHERE id = ?', [accountId]);
  const row = rows[0];
  if (!row) throw new AppError(404, 'DNS 账户不存在', 'ACCOUNT_NOT_FOUND');
  return row;
}

async function domainRow(c: Context<AppEnv>, domainId: number): Promise<{ domain: DomainRow; account: AccountRow }> {
  const rows = await db(c).query<DomainRow>(
    `SELECT d.*, cc.name AS category_name FROM dns_domains d
     LEFT JOIN dns_domain_categories cc ON cc.id = d.category_id WHERE d.id = ?`, [domainId],
  );
  const domain = rows[0];
  if (!domain) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
  return { domain, account: await account(c, domain.account_id) };
}

function idsFrom(body: Record<string, unknown>, max: number): number[] {
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = [...new Set(raw.map((value) => Number(value)))];
  if (ids.length === 0 || ids.length > max) throw new AppError(400, `一次需选择 1–${max} 项`, 'INVALID_IDS');
  if (ids.some((value) => !Number.isSafeInteger(value) || value < 1)) throw new AppError(400, '编号无效', 'INVALID_ID');
  return ids;
}

function categoryIdOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AppError(400, '分类编号无效', 'INVALID_CATEGORY');
  return parsed;
}

async function requireCategory(c: Context<AppEnv>, categoryId: number | null): Promise<void> {
  if (categoryId === null) return;
  const rows = await db(c).query<{ id: number }>('SELECT id FROM dns_domain_categories WHERE id = ?', [categoryId]);
  if (!rows[0]) throw new AppError(404, '分类不存在', 'CATEGORY_NOT_FOUND');
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

async function replaceAliases(c: Context<AppEnv>, domainId: number, remote: { id: string; name: string }[]): Promise<{ id: string; name: string; remoteId: string }[]> {
  await db(c).execute('DELETE FROM dns_domain_aliases WHERE domain_id = ?', [domainId]);
  const now = nowSeconds();
  for (const item of remote) {
    await db(c).execute(
      'INSERT INTO dns_domain_aliases (domain_id, name, remote_id, created_at) VALUES (?,?,?,?)',
      [domainId, item.name.toLowerCase(), item.id, now],
    );
  }
  const rows = await db(c).query<{ id: number; name: string; remote_id: string }>(
    'SELECT id, name, remote_id FROM dns_domain_aliases WHERE domain_id = ? ORDER BY id', [domainId],
  );
  return rows.map((row) => ({ id: String(row.id), name: row.name, remoteId: row.remote_id }));
}

function recordIdsFrom(body: Record<string, unknown>): string[] {
  const raw = Array.isArray(body.recordIds) ? body.recordIds : [];
  const ids = [...new Set(raw.map((value) => String(value)))];
  if (ids.length === 0 || ids.length > 100) throw new AppError(400, '一次需选择 1–100 条记录', 'INVALID_RECORD_IDS');
  if (ids.some((value) => !/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(value))) {
    throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
  }
  return ids;
}

function guessRecordType(value: string): string {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return 'A';
  if (value.includes(':') && /^[0-9a-f:.]+$/i.test(value)) return 'AAAA';
  return 'CNAME';
}

async function collectLegacyRecords(
  provider: DnsProvider, domain: DnsDomain,
  query: Omit<RecordQuery, 'page' | 'pageSize'>, maxRecords: number,
): Promise<{ items: DnsRecord[]; total: number }> {
  const pageSize = 100;
  const items: DnsRecord[] = [];
  let total = 0;
  for (let page = 1; page <= Math.ceil(maxRecords / pageSize); page++) {
    const result = await provider.listRecords(domain, { ...query, page, pageSize });
    total = result.total;
    items.push(...result.items);
    if (result.items.length < pageSize || items.length >= total) break;
  }
  return { items, total };
}

function sortLegacyRecords(records: DnsRecord[], column: string, order: 'asc' | 'desc'): DnsRecord[] {
  const direction = order === 'desc' ? -1 : 1;
  const value = (record: DnsRecord) => column === 'Name' ? record.name
    : column === 'Type' ? record.type
      : column === 'LineName' ? record.line
        : column === 'Value' ? record.value
          : record.updatedAt ?? '';
  return [...records].sort((first, second) => direction * String(value(first)).localeCompare(
    String(value(second)), 'zh-CN', { numeric: true, sensitivity: 'base' },
  ));
}

export function dnsRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/dns/providers', requireSession, (c) => c.json({ code: 0, ...providerCatalog() }));

  routes.get('/api/v1/dns/categories', requireSession, async (c) => {
    requireSql(c);
    const rows = await db(c).query<{ id: number; name: string; sort: number; domain_count: number }>(
      `SELECT cc.id, cc.name, cc.sort,
        (SELECT COUNT(*) FROM dns_domains d WHERE d.category_id = cc.id) AS domain_count
       FROM dns_domain_categories cc ORDER BY cc.sort ASC, cc.id DESC`,
    );
    return c.json({
      code: 0,
      items: rows.map((row) => ({ id: row.id, name: row.name, sort: row.sort, domainCount: Number(row.domain_count) })),
    });
  });

  routes.post('/api/v1/dns/categories', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const name = text(body, 'name', 50).trim();
    if (!name) throw new AppError(400, '分类名称不能为空', 'INVALID_CATEGORY_NAME');
    const sortRaw = body.sort === undefined || body.sort === null || body.sort === '' ? 0 : Number(body.sort);
    if (!Number.isSafeInteger(sortRaw) || Math.abs(sortRaw) > 1_000_000) throw new AppError(400, '排序值无效', 'INVALID_SORT');
    const result = await db(c).execute(
      'INSERT INTO dns_domain_categories (name, sort, created_at) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING RETURNING id',
      [name, sortRaw, nowSeconds()],
    );
    if (result.changes !== 1) throw new AppError(409, '分类名称已存在', 'CATEGORY_EXISTS');
    await audit(c, 'category.create', name, `sort=${sortRaw}`);
    return c.json({ code: 0, id: Number(result.rows[0]?.id) });
  });

  routes.put('/api/v1/dns/categories/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const categoryId = id(c.req.param('id'));
    await requireCategory(c, categoryId);
    const body = await input(c);
    const fields: string[] = [];
    const args: (string | number)[] = [];
    if (body.name !== undefined) {
      const name = text(body, 'name', 50).trim();
      if (!name) throw new AppError(400, '分类名称不能为空', 'INVALID_CATEGORY_NAME');
      const duplicate = await db(c).query<{ id: number }>(
        'SELECT id FROM dns_domain_categories WHERE name = ? AND id <> ?', [name, categoryId],
      );
      if (duplicate[0]) throw new AppError(409, '分类名称已存在', 'CATEGORY_EXISTS');
      fields.push('name=?'); args.push(name);
    }
    if (body.sort !== undefined) {
      const sortRaw = Number(body.sort);
      if (!Number.isSafeInteger(sortRaw) || Math.abs(sortRaw) > 1_000_000) throw new AppError(400, '排序值无效', 'INVALID_SORT');
      fields.push('sort=?'); args.push(sortRaw);
    }
    if (fields.length === 0) throw new AppError(400, '没有需要修改的字段', 'EMPTY_UPDATE');
    await db(c).execute(`UPDATE dns_domain_categories SET ${fields.join(',')} WHERE id=?`, [...args, categoryId]);
    await audit(c, 'category.update', String(categoryId), fields.join(','));
    return c.json({ code: 0 });
  });

  routes.delete('/api/v1/dns/categories/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const categoryId = id(c.req.param('id'));
    await requireCategory(c, categoryId);
    const used = await db(c).query<{ n: number }>('SELECT COUNT(*) AS n FROM dns_domains WHERE category_id = ?', [categoryId]);
    if (Number(used[0]?.n ?? 0) > 0) throw new AppError(409, '该分类下仍有域名，无法删除', 'CATEGORY_NOT_EMPTY');
    await db(c).execute('DELETE FROM dns_domain_categories WHERE id = ?', [categoryId]);
    await audit(c, 'category.delete', String(categoryId), '');
    return c.json({ code: 0 });
  });

  routes.get('/api/v1/dns/logs', requireSession, async (c) => {
    requireSql(c);
    const { page, pageSize } = pageParams(c);
    const principal = c.get('principal');
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (principal.user.level !== 2) {
      where.push('user_id = ?'); args.push(principal.user.id);
    } else {
      const uid = c.req.query('uid');
      if (uid !== undefined && uid !== '') {
        if (!/^[1-9]\d{0,9}$/.test(uid)) throw new AppError(400, '用户编号无效', 'INVALID_ID');
        where.push('user_id = ?'); args.push(Number(uid));
      }
    }
    const domain = c.req.query('domain')?.trim().slice(0, 253);
    if (domain) { where.push('target = ?'); args.push(domain); }
    const keyword = c.req.query('keyword')?.trim().slice(0, 64);
    if (keyword) {
      where.push('(action LIKE ? OR target LIKE ? OR detail LIKE ?)');
      args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    const clause = where.length ? where.join(' AND ') : '1=1';
    const rows = await db(c).query<{ id: number; user_id: number; action: string; target: string | null; detail: string | null; created_at: number }>(
      `SELECT id, user_id, action, target, detail, created_at FROM audit_logs
       WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize],
    );
    const total = await db(c).query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${clause}`, args);
    return c.json({
      code: 0, page, pageSize, total: Number(total[0]?.n ?? 0),
      items: rows.map((row) => ({
        id: row.id, userId: row.user_id, action: row.action, target: row.target,
        detail: row.detail, createdAt: row.created_at,
      })),
    });
  });

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

  routes.post('/api/domain/:id', requireLegacyApi, async (c) => {
    requireSql(c);
    const principal = c.get('principal');
    const domainId = id(c.req.param('id'));
    const permission = principal.user.level === 2 ? '' : `AND EXISTS (
      SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT)
    )`;
    const args: (string | number)[] = [domainId];
    if (permission) args.push(principal.user.id);
    const rows = await db(c).query<LegacyDomainDetailRow>(
      `SELECT d.*, a.id AS owner_id, a.type AS owner_type, a.name AS owner_name,
        a.config_cipher AS owner_config_cipher, a.remark AS owner_remark,
        a.created_at AS owner_created_at, a.updated_at AS owner_updated_at
       FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id
       WHERE d.id=? ${permission}`,
      args,
    );
    const row = rows[0];
    if (!row) throw new AppError(404, '域名不存在或无权访问', 'DOMAIN_NOT_FOUND');
    if (c.env.RUNTIME.platform === 'esa' && LEGACY_ESA_DETAIL_UNSUPPORTED_PROVIDERS.has(row.owner_type)) {
      throw new AppError(501, 'ESA 单请求 4 次 fetch 上限无法读取 GoEdge 完整线路，请在支持更多子请求的平台或服务商面板查看', 'LEGACY_DETAIL_BUDGET_UNSUPPORTED');
    }

    const owner: AccountRow = {
      id: row.owner_id, type: row.owner_type, name: row.owner_name,
      config_cipher: row.owner_config_cipher, remark: row.owner_remark,
      created_at: row.owner_created_at, updated_at: row.owner_updated_at,
    };
    let recordLine: { id: string; name: string; parent: string | null }[];
    let minTTL: number;
    try {
      const provider = await providerFor(c, owner);
      const target = toDnsDomain(row);
      recordLine = (await provider.recordLines(target) ?? []).map((line) => ({
        id: String(line.id), name: line.name, parent: line.parent,
      }));
      minTTL = (await provider.minTtl(target)) || 1;
    } catch (error) { providerError(error); }

    let loginurl: string | undefined;
    if (legacyText(c.get('legacyApiBody'), 'loginurl') === '1') {
      const token = randomToken();
      const now = nowSeconds();
      await db(c).execute('DELETE FROM quick_tokens WHERE expires_at <= ?', [now]);
      await db(c).execute(
        'INSERT INTO quick_tokens (token_hash, user_id, domain_id, expires_at) VALUES (?,?,?,?)',
        [await sha256(token), principal.user.id, String(row.id), now + LEGACY_QUICKLOGIN_SECONDS],
      );
      const timestamp = String(now);
      const sign = md5(`${c.env.APP_KEY}${row.name}${timestamp}${token}${c.env.APP_KEY}`);
      const origin = c.env.PUBLIC_ORIGIN ? new URL(c.env.PUBLIC_ORIGIN).origin : new URL(c.req.url).origin;
      loginurl = `${origin}/quicklogin?${new URLSearchParams({ domain: row.name, timestamp, token, sign })}`;
    }

    return c.json({ code: 0, data: {
      id: row.id, aid: row.account_id, cid: row.category_id ?? 0, name: row.name, thirdid: row.third_id,
      addtime: legacyDateTime(row.created_at), is_hide: row.hidden, is_sso: 0, recordcount: row.record_count,
      remark: row.remark, is_notice: row.notice, regtime: null,
      expiretime: legacyDateTime(row.expires_at), checktime: legacyDateTime(row.checked_at),
      noticetime: legacyDateTime(row.notice_attempted_at), checkstatus: row.check_status,
      config: {
        type: row.owner_type, name: legacyProviderName(row.owner_type),
        alias: LEGACY_ALIAS_RECORD_TYPES.has(row.owner_type),
      },
      recordLine, minTTL,
      ...(loginurl ? { loginurl } : {}),
    } });
  });

  routes.post('/api/record/remark/:id', requireLegacyApi, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    const principal = c.get('principal');
    if (principal.user.level !== 2 && principal.user.level < 1) {
      throw new AppError(403, '只读 API 用户无法修改解析备注', 'PERMISSION_DENIED');
    }
    const permission = principal.user.level === 2 ? '' : `AND EXISTS (
      SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT)
    )`;
    const args: (string | number)[] = [domainId];
    if (permission) args.push(principal.user.id);
    const rows = await db(c).query<LegacyRecordDomainRow>(
      `SELECT d.id, d.account_id, d.name, d.third_id, a.id AS owner_id, a.type AS owner_type,
        a.name AS owner_name, a.config_cipher AS owner_config_cipher, a.remark AS owner_remark,
        a.created_at AS owner_created_at, a.updated_at AS owner_updated_at
       FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id
       WHERE d.id=? ${permission}`,
      args,
    );
    const domain = rows[0];
    if (!domain) throw new AppError(404, '域名不存在或无权访问', 'DOMAIN_NOT_FOUND');

    const body = c.get('legacyApiBody');
    const recordId = typeof body.recordid === 'string' ? body.recordid.trim() : '';
    if (!/^[A-Za-z0-9_.|@:*\\-]{1,255}$/.test(recordId)) {
      throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    }
    if (body.remark !== undefined && body.remark !== null && typeof body.remark !== 'string') {
      throw new AppError(400, '备注格式无效', 'INVALID_REMARK');
    }
    const remark = typeof body.remark === 'string' ? body.remark.trim() : '';
    if (remark.length > 100) throw new AppError(400, '备注最多 100 字', 'INVALID_REMARK');
    const owner: AccountRow = {
      id: domain.owner_id, type: domain.owner_type, name: domain.owner_name,
      config_cipher: domain.owner_config_cipher, remark: domain.owner_remark,
      created_at: domain.owner_created_at, updated_at: domain.owner_updated_at,
    };
    const provider = await providerFor(c, owner);
    try {
      await provider.setRecordRemark(toDnsDomain(domain), recordId, remark || null);
    } catch (error) {
      if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
      if (error instanceof DnsError && [400, 401, 403, 404, 409, 429, 501].includes(error.status)) providerError(error);
      throw new AppError(503, 'DNS 备注更新结果未知，请核对服务商记录后重试', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    try {
      await audit(c, 'record.remark', domain.name, `${recordId} ${remark}`.slice(0, 500));
    } catch {
      throw new AppError(503, 'DNS 备注已提交服务商，但审计记录未确认；请核对当前备注', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    return c.json({ code: 0, msg: '操作成功！' });
  });

  routes.post('/api/record/delete/:id', requireLegacyApi, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    const principal = c.get('principal');
    if (principal.user.level !== 2 && principal.user.level < 1) {
      throw new AppError(403, '只读 API 用户无法删除解析记录', 'PERMISSION_DENIED');
    }
    const permission = principal.user.level === 2 ? '' : `AND EXISTS (
      SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT)
    )`;
    const args: (string | number)[] = [domainId];
    if (permission) args.push(principal.user.id);
    const rows = await db(c).query<LegacyRecordDomainRow>(
      `SELECT d.id, d.account_id, d.name, d.third_id, a.id AS owner_id, a.type AS owner_type,
        a.name AS owner_name, a.config_cipher AS owner_config_cipher, a.remark AS owner_remark,
        a.created_at AS owner_created_at, a.updated_at AS owner_updated_at
       FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id
       WHERE d.id=? ${permission}`,
      args,
    );
    const domain = rows[0];
    if (!domain) throw new AppError(404, '域名不存在或无权访问', 'DOMAIN_NOT_FOUND');
    const body = c.get('legacyApiBody');
    const recordId = typeof body.recordid === 'string' ? body.recordid.trim() : '';
    if (!/^[A-Za-z0-9_.|@:*\\-]{1,255}$/.test(recordId)) {
      throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    }

    const owner: AccountRow = {
      id: domain.owner_id, type: domain.owner_type, name: domain.owner_name,
      config_cipher: domain.owner_config_cipher, remark: domain.owner_remark,
      created_at: domain.owner_created_at, updated_at: domain.owner_updated_at,
    };
    const provider = await providerFor(c, owner);
    try {
      await provider.deleteRecord(toDnsDomain(domain), recordId);
    } catch (error) {
      if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
      if (error instanceof DnsError && [400, 401, 403, 404, 409, 429, 501].includes(error.status)) providerError(error);
      throw new AppError(503, 'DNS 删除结果未知，请核对服务商记录后重试', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    try {
      await audit(c, 'record.delete', domain.name, recordId);
    } catch {
      throw new AppError(503, 'DNS 记录已提交删除，但审计记录未确认；请核对服务商当前记录', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    return c.json({ code: 0, msg: '删除解析记录成功！' });
  });

  routes.post('/api/record/status/:id', requireLegacyApiDomain, async (c) => {
    requireSql(c);
    const principal = c.get('principal');
    const domain = c.get('legacyApiDomain') as LegacyRecordDomainRow;
    const body = c.get('legacyApiBody');
    const recordId = typeof body.recordid === 'string' ? body.recordid.trim() : '';
    if (!/^[A-Za-z0-9_.|@:*\\-]{1,255}$/.test(recordId)) {
      throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    }
    const status = typeof body.status === 'string' ? body.status.trim() : '';
    if (status !== '0' && status !== '1') throw new AppError(400, '状态参数无效', 'INVALID_STATUS');
    const owner: AccountRow = {
      id: domain.owner_id, type: domain.owner_type, name: domain.owner_name,
      config_cipher: domain.owner_config_cipher, remark: domain.owner_remark,
      created_at: domain.owner_created_at, updated_at: domain.owner_updated_at,
    };
    const provider = await providerFor(c, owner);
    try {
      await provider.setRecordStatus(toDnsDomain(domain), recordId, status === '1');
    } catch (error) {
      if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
      if (error instanceof DnsError && [400, 401, 403, 404, 409, 429, 501].includes(error.status)) providerError(error);
      throw new AppError(503, 'DNS 状态切换结果未知，请核对服务商记录后重试', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    const action = status === '1' ? 'enable' : 'disable';
    try {
      await audit(c, 'record.status', domain.name, `${recordId} ${action}`);
    } catch {
      throw new AppError(503, 'DNS 状态已提交服务商，但审计记录未确认；请核对服务商当前记录', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    return c.json({ code: 0, msg: '操作成功！' });
  });

  routes.post('/api/record/update/:id', requireLegacyApi, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    const principal = c.get('principal');
    if (principal.user.level !== 2 && principal.user.level < 1) {
      throw new AppError(403, '只读 API 用户无法修改解析', 'PERMISSION_DENIED');
    }
    const permission = principal.user.level === 2 ? '' : `AND EXISTS (
      SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT)
    )`;
    const args: (string | number)[] = [domainId];
    if (permission) args.push(principal.user.id);
    const rows = await db(c).query<LegacyRecordDomainRow>(
      `SELECT d.id, d.account_id, d.name, d.third_id, a.id AS owner_id, a.type AS owner_type,
        a.name AS owner_name, a.config_cipher AS owner_config_cipher, a.remark AS owner_remark,
        a.created_at AS owner_created_at, a.updated_at AS owner_updated_at
       FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id
       WHERE d.id=? ${permission}`,
      args,
    );
    const domain = rows[0];
    if (!domain) throw new AppError(404, '域名不存在或无权访问', 'DOMAIN_NOT_FOUND');

    const body = c.get('legacyApiBody');
    const recordId = typeof body.recordid === 'string' ? body.recordid.trim() : '';
    if (!/^[A-Za-z0-9_.|@:*\\-]{1,255}$/.test(recordId)) {
      throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    }
    const inputData = recordInput({
      ...body,
      ttl: body.ttl === undefined ? 600 : body.ttl,
      mx: body.mx === undefined || body.mx === '' ? 1 : body.mx,
      weight: body.weight === undefined || body.weight === '' ? 0 : body.weight,
    });
    const owner: AccountRow = {
      id: domain.owner_id, type: domain.owner_type, name: domain.owner_name,
      config_cipher: domain.owner_config_cipher, remark: domain.owner_remark,
      created_at: domain.owner_created_at, updated_at: domain.owner_updated_at,
    };
    const provider = await providerFor(c, owner);
    try {
      await provider.updateRecord(toDnsDomain(domain), recordId, inputData, { clearRemark: inputData.remark === null });
    } catch (error) {
      if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
      if (error instanceof DnsError && [400, 401, 403, 404, 409, 429, 501].includes(error.status)) providerError(error);
      throw new AppError(503, 'DNS 更新结果未知，请核对服务商记录后重试', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    try {
      await audit(c, 'record.update', domain.name, `${recordId} ${inputData.type} ${inputData.name}`);
    } catch {
      throw new AppError(503, 'DNS 记录已提交更新，但审计记录未确认；请核对服务商当前记录', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    return c.json({ code: 0, msg: '修改解析记录成功！' });
  });

  routes.post('/api/record/add/:id', requireLegacyApi, async (c) => {
    requireSql(c);
    const principal = c.get('principal');
    if (principal.user.level !== 2 && principal.user.level < 1) {
      throw new AppError(403, '只读 API 用户无法添加解析', 'PERMISSION_DENIED');
    }
    const domain = await legacyRecordDomain(c, id(c.req.param('id')));
    const body = c.get('legacyApiBody');
    const inputData = recordInput({
      ...body,
      ttl: body.ttl === undefined || body.ttl === '' ? 600 : body.ttl,
      mx: body.mx === undefined || body.mx === '' ? 1 : body.mx,
      weight: body.weight === undefined || body.weight === '' ? 0 : body.weight,
    });
    const provider = await providerFor(c, legacyOwner(domain));
    let recordId: string;
    try {
      recordId = await provider.addRecord(toDnsDomain(domain), inputData);
    } catch (error) {
      if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
      if (error instanceof DnsError && [400, 401, 403, 404, 409, 429, 501].includes(error.status)) providerError(error);
      throw new AppError(503, 'DNS 新增结果未知，请核对服务商记录后重试', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    try {
      await audit(c, 'record.create', domain.name, `${inputData.type} ${inputData.name} ${inputData.value}`.slice(0, 500));
    } catch {
      throw new AppError(503, 'DNS 记录已提交新增，但审计记录未确认；请核对服务商当前记录', 'DNS_WRITE_OUTCOME_UNKNOWN');
    }
    return c.json({ code: 0, msg: '添加解析记录成功！', id: recordId });
  });

  routes.post('/api/record/batch/:id', requireLegacyApi, async (c) => {
    requireSql(c);
    const principal = c.get('principal');
    if (principal.user.level !== 2 && principal.user.level < 1) {
      throw new AppError(403, '只读 API 用户无法批量修改解析', 'PERMISSION_DENIED');
    }
    const domain = await legacyRecordDomain(c, id(c.req.param('id')));
    const body = c.get('legacyApiBody');
    const action = legacyText(body, 'action', 20);
    if (!action) throw new AppError(400, '缺少批量操作类型', 'INVALID_BATCH_ACTION');
    if (!['open', 'pause', 'delete', 'remark', 'group'].includes(action)) {
      throw new AppError(400, '不支持的批量操作', 'INVALID_BATCH_ACTION');
    }
    let recordinfo: unknown = body.recordinfo;
    if (typeof recordinfo === 'string') {
      try { recordinfo = JSON.parse(recordinfo); } catch { recordinfo = null; }
    }
    if (!Array.isArray(recordinfo) || recordinfo.length === 0 || recordinfo.length > 100) {
      throw new AppError(400, 'recordinfo 需为 1–100 条记录数组', 'INVALID_LEGACY_API_PARAMETER');
    }
    if (action === 'group') {
      const groupId = legacyText(body, 'groupid', 20);
      if (groupId && !/^\d{1,20}$/.test(groupId)) throw new AppError(400, '分组编号无效', 'INVALID_GROUP_ID');
      const recordIds: string[] = [];
      for (const entry of recordinfo) {
        const record = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : null;
        const recordId = record && (typeof record.RecordId === 'string' || typeof record.RecordId === 'number')
          ? String(record.RecordId).trim()
          : '';
        if (recordId && /^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) recordIds.push(recordId);
      }
      if (recordIds.length === 0) {
        throw new AppError(400, 'recordinfo 中没有有效的记录编号', 'INVALID_LEGACY_API_PARAMETER');
      }
      const provider = await providerFor(c, legacyOwner(domain));
      if (!provider.changeRecordGroup) {
        throw new AppError(501, '该 DNS 类型不支持分组', 'DNS_GROUP_UNSUPPORTED');
      }
      try {
        await provider.changeRecordGroup(toDnsDomain(domain), recordIds, groupId);
      } catch (error) {
        if (error instanceof DnsError) {
          throw new AppError(error.status === 400 ? 400 : 502, `修改分组失败，${error.message}`, error.code);
        }
        throw error;
      }
      await audit(c, 'record.batch.group', domain.name, `${recordIds.length} 条 → 分组 ${groupId || '默认'}`.slice(0, 500));
      return c.json({
        code: 0, success: recordIds.length, failed: recordinfo.length - recordIds.length,
        msg: `成功修改${recordIds.length}条记录的分组`,
      });
    }
    const remarkRaw = typeof body.remark === 'string' ? body.remark.trim() : '';
    if (remarkRaw.length > 100) throw new AppError(400, '备注最多 100 字', 'INVALID_REMARK');
    const remark = remarkRaw || null;
    const provider = await providerFor(c, legacyOwner(domain));
    const target = toDnsDomain(domain);
    let success = 0;
    let failed = 0;
    for (const entry of recordinfo) {
      const record = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : null;
      const recordId = record && typeof record.RecordId === 'string' ? record.RecordId.trim() : '';
      if (!recordId || !/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) {
        failed++;
        continue;
      }
      try {
        if (action === 'open' || action === 'pause') {
          await provider.setRecordStatus(target, recordId, action === 'open');
        } else if (action === 'delete') {
          await provider.deleteRecord(target, recordId);
        } else {
          await provider.setRecordRemark(target, recordId, remark);
        }
        success++;
      } catch {
        failed++;
      }
    }
    if (success > 0 || action === 'remark') {
      await audit(c, `record.batch.${action}`, domain.name, `${success} ok, ${failed} failed`);
    }
    const verbs: Record<string, string> = { open: '启用', pause: '暂停', delete: '删除', remark: '修改备注' };
    return c.json({
      code: 0,
      success,
      failed,
      msg: action === 'remark' ? `批量修改备注，成功${success}条，失败${failed}条` : `成功${verbs[action]}${success}条解析记录`,
    });
  });

  routes.post('/api/record/data/:id', requireLegacyApi, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    const principal = c.get('principal');
    const permission = principal.user.level === 2 ? '' : `AND EXISTS (
      SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT)
    )`;
    const args: (string | number)[] = [domainId];
    if (permission) args.push(principal.user.id);
    const domains = await db(c).query<LegacyRecordDomainRow>(
      `SELECT d.id, d.account_id, d.name, d.third_id, a.id AS owner_id, a.type AS owner_type,
        a.name AS owner_name, a.config_cipher AS owner_config_cipher, a.remark AS owner_remark,
        a.created_at AS owner_created_at, a.updated_at AS owner_updated_at
       FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id
       WHERE d.id=? ${permission}`,
      args,
    );
    const domain = domains[0];
    if (!domain) return c.json({ total: 0, rows: [] });

    const body = c.get('legacyApiBody');
    const offset = legacyInteger(legacyText(body, 'offset', 16), 'offset', 0, 0, 1_000_000);
    const pageSize = legacyInteger(legacyText(body, 'limit', 16), 'limit', 10, 1, 100);
    if (offset % pageSize !== 0) throw new AppError(400, 'offset 必须是 limit 的整数倍', 'INVALID_LEGACY_API_PARAMETER');
    const sortName = legacyText(body, 'sortName', 32);
    if (sortName && !LEGACY_RECORD_SORT_COLUMNS.has(sortName)) {
      throw new AppError(400, '排序字段无效', 'INVALID_LEGACY_API_PARAMETER');
    }
    const sortOrder = legacyText(body, 'sortOrder', 8).toLowerCase() === 'desc' ? 'desc' : 'asc';

    const keyword = legacyText(body, 'keyword', 128);
    const name = legacyText(body, 'subdomain', 128);
    const value = legacyText(body, 'value', 255);
    const type = legacyText(body, 'type', 16).toUpperCase();
    const line = legacyText(body, 'line', 64);
    const status = legacyText(body, 'status', 8);
    if (status && status !== '0' && status !== '1') {
      throw new AppError(400, 'status 格式无效', 'INVALID_LEGACY_API_PARAMETER');
    }
    const clientPaged = LEGACY_CLIENT_PAGINATION_PROVIDERS.has(domain.owner_type);
    if (status === '0' && domain.owner_type === 'cloudflare') {
      return clientPaged ? c.json([]) : c.json({ total: 0, rows: [] });
    }

    const owner: AccountRow = {
      id: domain.owner_id, type: domain.owner_type, name: domain.owner_name,
      config_cipher: domain.owner_config_cipher, remark: domain.owner_remark,
      created_at: domain.owner_created_at, updated_at: domain.owner_updated_at,
    };
    const provider = await providerFor(c, owner).catch((error) => providerError(error));
    const target = toDnsDomain(domain);
    const query: Omit<RecordQuery, 'page' | 'pageSize'> = {
      ...(keyword ? { keyword } : {}), ...(name ? { name } : {}), ...(value ? { value } : {}),
      ...(type ? { type } : {}), ...(line ? { line } : {}),
      ...(status && domain.owner_type !== 'cloudflare' ? { status: status as '0' | '1' } : {}),
    };
    let items: DnsRecord[] = [];
    let total = 0;
    let hostRows: Record<string, unknown>[] | null = null;
    try {
      if (!name && provider.listRecordHosts) {
        const result = await provider.listRecordHosts(target, { ...query, page: offset / pageSize + 1, pageSize });
        total = result.total;
        hostRows = result.items.map((host) => ({
          RecordId: host.id, Domain: domain.name, Name: host.name, Type: null, Value: null,
          Line: null, LineName: null, TTL: null, MX: null, Weight: null,
          Remark: host.remark, Status: host.status, UpdateTime: host.updatedAt, Count: host.count,
        }));
      } else if (sortName) {
        const collected = await collectLegacyRecords(
          provider, target, query,
          c.env.RUNTIME.platform === 'esa' ? LEGACY_RECORD_SORT_MAX_ESA : LEGACY_RECORD_SORT_MAX,
        );
        items = sortLegacyRecords(collected.items, sortName, sortOrder).slice(offset, offset + pageSize);
        total = collected.total;
      } else {
        const result = await provider.listRecords(target, { ...query, page: offset / pageSize + 1, pageSize });
        items = result.items;
        total = result.total;
      }
    } catch (error) { providerError(error); }

    const rows = hostRows ?? items.map((record) => ({
      RecordId: record.id, Domain: domain.name, Name: record.name, Type: record.type, Value: record.value,
      Line: record.line, LineName: record.line, TTL: record.ttl, MX: record.mx, Weight: record.weight,
      Remark: record.remark, Status: record.status, UpdateTime: record.updatedAt,
    }));
    return clientPaged ? c.json(rows) : c.json({ total: Number(total), rows });
  });

  routes.post('/api/domain', requireLegacyApi, async (c) => {
    requireSql(c);
    const principal = c.get('principal');
    if (principal.user.level !== 1 && principal.user.level !== 2) return c.json({ total: 0, rows: [] });
    const body = c.get('legacyApiBody');
    const idValue = legacyText(body, 'id', 20);
    const domainId = idValue && idValue !== '0' ? legacyInteger(idValue, 'id', 0, 1, 9_999_999_999) : null;
    const keyword = legacyText(body, 'kw', 255);
    const accountValue = legacyText(body, 'aid', 20);
    const accountId = accountValue && accountValue !== '0' ? legacyInteger(accountValue, 'aid', 0, 1, 9_999_999_999) : null;
    const type = legacyText(body, 'type', 32);
    const categoryValue = legacyText(body, 'cid', 20);
    const categoryId = categoryValue ? legacyInteger(categoryValue, 'cid', 0, 0, 9_999_999_999) : null;
    const status = legacyText(body, 'status', 8);
    const offset = legacyInteger(legacyText(body, 'offset', 16), 'offset', 0, 0, 1_000_000);
    const limit = legacyInteger(legacyText(body, 'limit', 16), 'limit', 10, 1, 100);
    const sortName = legacyText(body, 'sortName', 32);
    const sortOrder = legacyText(body, 'sortOrder', 8).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortColumns: Record<string, string> = {
      id: 'd.id', name: 'd.name', recordcount: 'd.record_count', addtime: 'd.created_at',
      regtime: 'd.id', expiretime: 'd.expires_at', is_notice: 'd.notice',
      is_hide: 'd.hidden', is_sso: 'd.id', typename: 'a.type', category_name: 'd.category_id', remark: 'd.remark',
    };
    const sortColumn = Object.prototype.hasOwnProperty.call(sortColumns, sortName) ? sortColumns[sortName]! : 'd.id';
    const where = ['1=1'];
    const args: (string | number)[] = [];
    if (domainId !== null) { where.push('d.id=?'); args.push(domainId); }
    else if (keyword) {
      where.push("(d.name LIKE ? ESCAPE '\\' OR COALESCE(d.remark,'') LIKE ? ESCAPE '\\')");
      const pattern = `%${keyword.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      args.push(pattern, pattern);
    }
    if (accountId !== null) { where.push('d.account_id=?'); args.push(accountId); }
    if (type) { where.push('a.type LIKE ?'); args.push(`%${type}%`); }
    if (categoryId !== null) {
      if (categoryId === 0) where.push('(d.category_id IS NULL OR d.category_id=0)');
      else { where.push('d.category_id=?'); args.push(categoryId); }
    }
    if (principal.user.level === 1) {
      where.push('d.hidden=0');
      where.push('EXISTS (SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT))');
      args.push(principal.user.id);
    }
    const now = nowSeconds();
    if (status === '1') { where.push('d.expires_at>? AND d.expires_at<=?'); args.push(now, now + 30 * 86_400); }
    else if (status === '2') { where.push('d.expires_at IS NOT NULL AND d.expires_at<=?'); args.push(now); }
    const from = `FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id LEFT JOIN dns_domain_categories cc ON cc.id=d.category_id WHERE ${where.join(' AND ')}`;
    const totals = await db(c).query<{ total: number }>(`SELECT COUNT(*) AS total ${from}`, args);
    const rows = await db(c).query<LegacyDomainRow>(
      `SELECT d.*, a.type AS account_type, a.remark AS account_remark, cc.name AS category_name ${from}
       ORDER BY ${sortColumn} ${sortOrder}${sortColumn === 'd.id' ? '' : ', d.id DESC'} LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    return c.json({
      total: Number(totals[0]?.total ?? 0),
      rows: rows.map((row) => ({
        id: row.id, aid: row.account_id, cid: row.category_id ?? 0, name: row.name, thirdid: row.third_id,
        addtime: legacyDateTime(row.created_at), is_hide: row.hidden, is_sso: 0, recordcount: row.record_count,
        remark: row.remark, is_notice: row.notice, regtime: null, expiretime: legacyDateTime(row.expires_at),
        checktime: legacyDateTime(row.checked_at), noticetime: legacyDateTime(row.notice_attempted_at),
        checkstatus: row.check_status, type: row.account_type, aremark: row.account_remark,
        typename: legacyProviderName(row.account_type), icon: LEGACY_PROVIDER_ICONS[row.account_type] ?? '',
        category_name: row.category_name ?? '',
      })),
    });
  });

  routes.get('/api/v1/dns/domains', requireSession, async (c) => {
    requireSql(c);
    const { page, pageSize } = pageParams(c);
    const keyword = c.req.query('keyword')?.trim().slice(0, 64) ?? '';
    const principal = c.get('principal');
    const where = ['1=1'];
    const args: (string | number)[] = [];
    if (keyword) { where.push('d.name LIKE ?'); args.push(`%${keyword}%`); }
    const accountFilter = c.req.query('accountId');
    if (accountFilter) {
      if (!/^[1-9]\d{0,9}$/.test(accountFilter)) throw new AppError(400, '账户编号无效', 'INVALID_ID');
      where.push('d.account_id = ?'); args.push(Number(accountFilter));
    }
    const categoryFilter = c.req.query('categoryId');
    if (categoryFilter !== undefined) {
      const categoryId = categoryIdOf(categoryFilter);
      if (categoryId === null) where.push('d.category_id IS NULL');
      else { where.push('d.category_id = ?'); args.push(categoryId); }
    }
    const hiddenFilter = c.req.query('hidden');
    if (hiddenFilter !== undefined && hiddenFilter !== '0' && hiddenFilter !== '1') {
      throw new AppError(400, '隐藏状态参数无效', 'INVALID_HIDDEN');
    }
    if (principal.user.level !== 2) {
      where.push('EXISTS (SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT))');
      args.push(principal.user.id);
      where.push('d.hidden = 0');
    } else if (hiddenFilter !== undefined) {
      where.push('d.hidden = ?'); args.push(Number(hiddenFilter));
    }
    const rows = await db(c).query<DomainRow & { account_name: string; account_type: string }>(
      `SELECT d.*, a.name AS account_name, a.type AS account_type, cc.name AS category_name
       FROM dns_domains d
       JOIN dns_accounts a ON a.id = d.account_id
       LEFT JOIN dns_domain_categories cc ON cc.id = d.category_id
       WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
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
        categoryId: row.category_id, categoryName: row.category_name ?? null,
        expiresAt: row.expires_at, checkStatus: row.check_status,
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
    requireAdmin(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const body = await input(c);
    const fields: string[] = [];
    const args: (string | number | null)[] = [];
    if (body.remark !== undefined) {
      const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) : '';
      fields.push('remark=?'); args.push(remark || null);
    }
    if (body.categoryId !== undefined) {
      const categoryId = categoryIdOf(body.categoryId);
      await requireCategory(c, categoryId);
      fields.push('category_id=?'); args.push(categoryId);
    }
    if (body.hidden !== undefined) { fields.push('hidden=?'); args.push(body.hidden === true ? 1 : 0); }
    if (body.notice !== undefined) { fields.push('notice=?'); args.push(body.notice === true ? 1 : 0); }
    if (fields.length === 0) throw new AppError(400, '没有需要修改的字段', 'EMPTY_UPDATE');
    fields.push('updated_at=?'); args.push(nowSeconds());
    await db(c).execute(`UPDATE dns_domains SET ${fields.join(',')} WHERE id=?`, [...args, domainId]);
    await audit(c, 'domain.update', c.req.param('id'), fields.join(','));
    return c.json({ code: 0 });
  });

  routes.delete('/api/v1/dns/domains/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const domainId = id(c.req.param('id'));
    const { domain } = await domainRow(c, domainId);
    await db(c).execute('DELETE FROM dns_domains WHERE id = ?', [domainId]);
    await audit(c, 'domain.delete', domain.name, `id=${domainId}`);
    return c.json({ code: 0 });
  });

  routes.post('/api/v1/dns/domains/batch', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const ids = idsFrom(body, 200);
    const action = text(body, 'action', 20);
    const placeholders = ids.map(() => '?').join(',');
    let affected = 0;
    if (action === 'delete') {
      const result = await db(c).execute(`DELETE FROM dns_domains WHERE id IN (${placeholders})`, ids);
      affected = Number(result.changes) || 0;
    } else if (action === 'remark') {
      const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) : '';
      const result = await db(c).execute(
        `UPDATE dns_domains SET remark=?, updated_at=? WHERE id IN (${placeholders})`,
        [remark || null, nowSeconds(), ...ids],
      );
      affected = Number(result.changes) || 0;
    } else if (action === 'notice' || action === 'hidden') {
      if (typeof body.value !== 'boolean') throw new AppError(400, '状态参数无效', 'INVALID_STATUS');
      const column = action === 'notice' ? 'notice' : 'hidden';
      const result = await db(c).execute(
        `UPDATE dns_domains SET ${column}=?, updated_at=? WHERE id IN (${placeholders})`,
        [body.value ? 1 : 0, nowSeconds(), ...ids],
      );
      affected = Number(result.changes) || 0;
    } else if (action === 'category') {
      const categoryId = categoryIdOf(body.categoryId);
      await requireCategory(c, categoryId);
      const result = await db(c).execute(
        `UPDATE dns_domains SET category_id=?, updated_at=? WHERE id IN (${placeholders})`,
        [categoryId, nowSeconds(), ...ids],
      );
      affected = Number(result.changes) || 0;
    } else if (action === 'expiration-refresh') {
      const result = await db(c).execute(
        `UPDATE dns_domains SET check_status=0, checked_at=NULL, updated_at=? WHERE id IN (${placeholders}) AND check_status <> 3`,
        [nowSeconds(), ...ids],
      );
      affected = Number(result.changes) || 0;
    } else {
      throw new AppError(400, '不支持的批量操作', 'INVALID_BATCH_ACTION');
    }
    await audit(c, `domain.batch.${action}`, `${ids.length} ids`, `affected=${affected}`);
    return c.json({ code: 0, affected, requested: ids.length });
  });

  routes.post('/api/v1/dns/domains/:id/expiration/refresh', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `domain:expiration:${c.get('principal').user.id}`, 10, 60);
    const { domain } = await domainRow(c, domainId);
    const checkedAt = nowSeconds();
    let expiresAt: number;
    try {
      expiresAt = await lookupDomainExpiration(domain.name, providerFetch(c));
    } catch (error) {
      if (
        (error instanceof AppError && (error.reason === 'REQUEST_BUDGET_EXCEEDED' || error.reason === 'REQUEST_TIMEOUT'))
        || c.env.BUDGET?.remainingMs() === 0
      ) throw error;
      await db(c).execute(
        'UPDATE dns_domains SET checked_at=?, check_status=2, updated_at=? WHERE id=?',
        [checkedAt, checkedAt, domainId],
      );
      await audit(c, 'domain.expiration.refresh', domain.name, 'status=failed');
      throw new AppError(503, '无法查询域名到期时间，请稍后重试', 'EXPIRATION_LOOKUP_FAILED');
    }
    await db(c).execute(
      'UPDATE dns_domains SET expires_at=?, checked_at=?, check_status=1, updated_at=? WHERE id=?',
      [expiresAt, checkedAt, checkedAt, domainId],
    );
    await audit(c, 'domain.expiration.refresh', domain.name, 'status=success');
    return c.json({ code: 0, expiresAt, checkedAt, checkStatus: 1 });
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
        hidden: domain.hidden === 1, notice: domain.notice === 1,
        categoryId: domain.category_id, categoryName: domain.category_name ?? null,
        expiresAt: domain.expires_at, checkStatus: domain.check_status,
      },
    });
  });

  routes.post('/api/v1/dns/domains/:id/records/check', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const body = await input(c);
    const recordName = text(body, 'name', 128).trim();
    if (!RECORD_NAME.test(recordName)) throw new AppError(400, '主机记录格式无效', 'INVALID_RECORD_NAME');
    const type = text(body, 'type', 16).trim().toUpperCase();
    if (!isDnsCheckType(type)) throw new AppError(400, '该记录类型暂不支持检测', 'UNSUPPORTED_DNS_CHECK_TYPE');
    const expectedValue = text(body, 'value', 2048).trim();
    if (!expectedValue) throw new AppError(400, '记录值不能为空', 'INVALID_RECORD_VALUE');
    const domains = await db(c).query<{ name: string }>('SELECT name FROM dns_domains WHERE id = ?', [domainId]);
    const domain = domains[0];
    if (!domain) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    await consumeRateLimit(c, `dns:record-check:${c.get('principal').user.id}`, 20, 60);
    const queryName = recordName === '@' ? domain.name : `${recordName}.${domain.name}`;
    const answers = await lookupPublicDnsRecords(queryName, type, providerFetch(c));
    return c.json({ code: 0, data: checkDnsRecordValue(expectedValue, answers, type) });
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
      return c.json({
        code: 0, lines, minTtl,
        groups: typeof provider.listRecordGroups === 'function',
        weightConfig: typeof provider.listWeightSubdomains === 'function',
      });
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

  routes.post('/api/v1/dns/domains/:id/records/batch', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 120, 60);
    const body = await input(c);
    const action = text(body, 'action', 20);
    const recordIds = recordIdsFrom(body);
    const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) : '';
    if (action === 'remark' && body.remark !== undefined && remark.length > 100) {
      throw new AppError(400, '备注最多 100 字', 'INVALID_REMARK');
    }
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    const target = toDnsDomain(domain);
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const recordId of recordIds) {
      try {
        if (action === 'enable' || action === 'disable') {
          await provider.setRecordStatus(target, recordId, action === 'enable');
        } else if (action === 'delete') {
          await provider.deleteRecord(target, recordId);
        } else if (action === 'remark') {
          await provider.setRecordRemark(target, recordId, remark || null);
        } else {
          throw new AppError(400, '不支持的批量操作', 'INVALID_BATCH_ACTION');
        }
        success++;
      } catch (error) {
        failed++;
        if (errors.length < 5) errors.push(error instanceof Error ? error.message : '未知错误');
      }
    }
    if (success > 0 || action === 'remark') {
      await audit(c, `record.batch.${action}`, domain.name, `${success} ok, ${failed} failed`.slice(0, 500));
    }
    return c.json({ code: 0, success, failed, errors });
  });

  routes.post('/api/v1/dns/domains/:id/records/batch-add', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 60, 60);
    const body = await input(c);
    const records = Array.isArray(body.records) ? body.records : [];
    if (records.length === 0 || records.length > 100) throw new AppError(400, '一次需提交 1–100 条记录', 'INVALID_RECORDS');
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    const target = toDnsDomain(domain);
    let added = 0;
    let failed = 0;
    const errors: string[] = [];
    const results: { index: number; ok: boolean; uncertain?: boolean; error?: string }[] = [];
    for (const [index, entry] of records.entries()) {
      let candidate: Record<string, unknown> | null = null;
      let rowError: string | null = null;
      if (typeof entry === 'string') {
        const parts = entry.trim().split(/\s+/);
        if (parts.length < 2) rowError = `无法解析：${entry.slice(0, 50)}`;
        else candidate = { name: parts[0], value: parts.slice(1).join(' ') };
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        candidate = { ...(entry as Record<string, unknown>) };
      } else {
        rowError = '记录格式无效';
      }
      if (!candidate) {
        const message = rowError ?? '记录格式无效';
        failed++;
        if (errors.length < 5) errors.push(message);
        results.push({ index, ok: false, error: message });
        continue;
      }
      if (candidate.type === undefined || candidate.type === '') {
        candidate.type = body.type ?? guessRecordType(String(candidate.value ?? ''));
      }
      if (candidate.line === undefined) candidate.line = body.line ?? 'default';
      if (candidate.ttl === undefined) candidate.ttl = body.ttl ?? 600;
      let data: DnsRecordInput;
      try {
        data = recordInput(candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 200) : '未知错误';
        failed++;
        if (errors.length < 5) errors.push(message);
        results.push({ index, ok: false, error: message });
        continue;
      }
      try {
        await provider.addRecord(target, data);
        added++;
        results.push({ index, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 200) : '未知错误';
        failed++;
        if (errors.length < 5) errors.push(message);
        results.push({ index, ok: false, uncertain: true, error: message });
      }
    }
    if (added > 0) await audit(c, 'record.batch.add', domain.name, `${added} ok, ${failed} failed`);
    return c.json({ code: 0, added, failed, errors, results });
  });

  routes.post('/api/v1/dns/domains/:id/records/batch-edit', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 120, 60);
    const body = await input(c);
    const action = text(body, 'action', 16).trim();
    if (action !== 'value' && action !== 'line') throw new AppError(400, '不支持的批量修改类型', 'INVALID_BATCH_EDIT_ACTION');
    const newType = action === 'value' ? text(body, 'type', 16).trim().toUpperCase() : '';
    if (newType && !isRecordType(newType)) throw new AppError(400, '不支持的记录类型', 'INVALID_RECORD_TYPE');
    const newValue = action === 'value' ? text(body, 'value', 2048).trim() : '';
    if (action === 'value' && !newValue) throw new AppError(400, '记录值不能为空', 'INVALID_RECORD_VALUE');
    const newLine = action === 'line' ? text(body, 'line', 64).trim() : '';
    if (action === 'line' && !newLine) throw new AppError(400, '线路不能为空', 'INVALID_LINE');
    const records = Array.isArray(body.recordinfo) ? body.recordinfo : [];
    if (records.length === 0 || records.length > 100) {
      throw new AppError(400, 'recordinfo 需为 1–100 条记录数组', 'INVALID_RECORDS');
    }
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    const target = toDnsDomain(domain);
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const entry of records) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        failed++;
        if (errors.length < 5) errors.push('记录格式无效');
        continue;
      }
      const row = entry as Record<string, unknown>;
      const recordId = typeof row.RecordId === 'string' ? row.RecordId.trim() : '';
      if (!/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) {
        failed++;
        if (errors.length < 5) errors.push('记录编号无效');
        continue;
      }
      let data: DnsRecordInput;
      try {
        data = recordInput({
          name: row.Name,
          type: action === 'value' ? newType : row.Type,
          value: action === 'value' ? newValue : row.Value,
          line: action === 'line' ? newLine : row.Line ?? 'default',
          ttl: row.TTL ?? 600,
          mx: row.MX ?? null,
          weight: row.Weight ?? null,
          remark: row.Remark ?? null,
        });
      } catch (error) {
        failed++;
        if (errors.length < 5) errors.push(error instanceof Error ? error.message.slice(0, 200) : '记录格式无效');
        continue;
      }
      try {
        await provider.updateRecord(target, recordId, data, { clearRemark: data.remark === null });
        success++;
      } catch (error) {
        failed++;
        if (errors.length < 5) errors.push(error instanceof Error ? error.message.slice(0, 200) : '未知错误');
      }
    }
    if (success > 0) {
      await audit(c, `record.batch.${action}`, domain.name, `${success} ok, ${failed} failed`.slice(0, 500));
    }
    return c.json({ code: 0, success, failed, errors });
  });

  routes.get('/api/v1/dns/domains/:id/record-logs', requireSession, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.recordLogs) return c.json({ code: 0, supported: false, total: 0, items: [] });
    const { page, pageSize } = pageParams(c);
    try {
      const result = await provider.recordLogs(toDnsDomain(domain), { page, pageSize });
      return c.json({ code: 0, supported: true, ...result });
    } catch (error) { providerError(error); }
  });

  routes.get('/api/v1/dns/domains/:id/record-groups', requireSession, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.listRecordGroups) {
      throw new AppError(501, '当前服务商不支持解析记录分组', 'DNS_GROUP_UNSUPPORTED');
    }
    try {
      const items = await provider.listRecordGroups(toDnsDomain(domain));
      return c.json({ code: 0, items });
    } catch (error) { providerError(error); }
  });

  routes.post('/api/v1/dns/domains/:id/records/group', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 120, 60);
    const body = await input(c);
    const recordIds = recordIdsFrom(body);
    const raw = body.groupId;
    if (raw !== undefined && typeof raw !== 'string' && typeof raw !== 'number') {
      throw new AppError(400, '分组编号无效', 'INVALID_GROUP_ID');
    }
    const groupId = raw === undefined || raw === null ? '' : String(raw).trim();
    if (groupId && !/^\d{1,20}$/.test(groupId)) throw new AppError(400, '分组编号无效', 'INVALID_GROUP_ID');
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.changeRecordGroup) {
      throw new AppError(501, '当前服务商不支持解析记录分组', 'DNS_GROUP_UNSUPPORTED');
    }
    try {
      await provider.changeRecordGroup(toDnsDomain(domain), recordIds, groupId);
    } catch (error) { providerError(error); }
    await audit(c, 'record.group', domain.name, `${recordIds.length} 条记录 → 分组 ${groupId || '默认'}`.slice(0, 500));
    return c.json({ code: 0, moved: recordIds.length });
  });

  routes.get('/api/v1/dns/domains/:id/weight-subdomains', requireSession, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.listWeightSubdomains) {
      throw new AppError(501, '当前服务商不支持权重配置', 'DNS_WEIGHT_UNSUPPORTED');
    }
    const { page, pageSize } = pageParams(c);
    const keyword = c.req.query('keyword')?.slice(0, 128);
    try {
      const result = await provider.listWeightSubdomains(toDnsDomain(domain), { page, pageSize, ...(keyword ? { keyword } : {}) });
      return c.json({ code: 0, page, pageSize, ...result });
    } catch (error) { providerError(error); }
  });

  routes.post('/api/v1/dns/domains/:id/weights', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    await consumeRateLimit(c, `dns:write:${c.get('principal').user.id}`, 120, 60);
    const body = await input(c);
    const action = text(body, 'action', 16).trim();
    if (action !== 'status' && action !== 'update') throw new AppError(400, '不支持的权重操作', 'INVALID_WEIGHT_ACTION');
    const subdomain = text(body, 'subdomain', 253).trim().toLowerCase();
    if (!SUBDOMAIN_NAME.test(subdomain)) throw new AppError(400, '子域名格式无效', 'INVALID_SUBDOMAIN');
    const type = text(body, 'type', 16).trim().toUpperCase();
    const line = text(body, 'line', 64).trim();
    const rawEnabled = body.enabled;
    if (rawEnabled !== undefined && typeof rawEnabled !== 'boolean' && typeof rawEnabled !== 'string' && typeof rawEnabled !== 'number') {
      throw new AppError(400, '权重开关参数无效', 'INVALID_WEIGHT');
    }
    const enabled = !(rawEnabled === false || rawEnabled === 0 || rawEnabled === '0');
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.setWeightStatus) throw new AppError(501, '当前服务商不支持权重配置', 'DNS_WEIGHT_UNSUPPORTED');
    const target = toDnsDomain(domain);
    try {
      if (type !== 'CNAME') {
        await provider.setWeightStatus(target, {
          subdomain, enabled, ...(type ? { type } : {}), ...(line ? { line } : {}),
        });
      }
      let updated = 0;
      if (action === 'update' && enabled) {
        if (!provider.updateRecordWeight) throw new AppError(501, '当前服务商不支持修改权重', 'DNS_WEIGHT_UNSUPPORTED');
        const weights = body.weights && typeof body.weights === 'object' && !Array.isArray(body.weights)
          ? body.weights as Record<string, unknown>
          : {};
        const entries = Object.entries(weights);
        if (entries.length === 0) throw new AppError(400, '权重参数不能为空', 'INVALID_WEIGHT');
        if (entries.length > 100) throw new AppError(400, '一次最多修改 100 条权重', 'INVALID_WEIGHT');
        for (const [recordId, value] of entries) {
          if (!/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordId)) throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
          const weight = Number(value);
          if (!Number.isSafeInteger(weight) || weight < 0 || weight > 100) {
            throw new AppError(400, '权重必须在 0–100 之间', 'INVALID_WEIGHT');
          }
          await provider.updateRecordWeight(target, recordId, weight);
          updated++;
        }
      }
      await audit(c, action === 'status' ? 'record.weight.status' : 'record.weight.update', domain.name,
        `${subdomain} ${type || '-'} ${line || '-'} ${enabled ? 'on' : 'off'} ${updated} 条`.slice(0, 500));
      return c.json({ code: 0, updated });
    } catch (error) { providerError(error); }
  });

  routes.get('/api/v1/dns/domains/:id/aliases', requireSession, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId);
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.listDomainAliases) throw new AppError(501, '当前服务商不支持域名别名', 'DNS_ALIAS_UNSUPPORTED');
    try {
      const remote = await provider.listDomainAliases(toDnsDomain(domain));
      return c.json({ code: 0, items: await replaceAliases(c, domainId, remote) });
    } catch (error) { providerError(error); }
  });

  routes.post('/api/v1/dns/domains/:id/aliases', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    const body = await input(c);
    const alias = text(body, 'alias', 253).trim().toLowerCase();
    if (!DOMAIN_NAME.test(alias)) throw new AppError(400, '别名域名格式无效', 'INVALID_DOMAIN_NAME');
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.listDomainAliases || !provider.addDomainAlias) {
      throw new AppError(501, '当前服务商不支持域名别名', 'DNS_ALIAS_UNSUPPORTED');
    }
    try {
      await provider.addDomainAlias(toDnsDomain(domain), alias);
      const remote = await provider.listDomainAliases(toDnsDomain(domain));
      const items = await replaceAliases(c, domainId, remote);
      await audit(c, 'alias.create', domain.name, alias);
      return c.json({ code: 0, items });
    } catch (error) { providerError(error); }
  });

  routes.delete('/api/v1/dns/domains/:id/aliases/:aliasId', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    const domainId = id(c.req.param('id'));
    await requireDomain(c, domainId, true);
    const aliasId = id(c.req.param('aliasId'));
    const rows = await db(c).query<{ id: number; name: string; remote_id: string }>(
      'SELECT id, name, remote_id FROM dns_domain_aliases WHERE id = ? AND domain_id = ?', [aliasId, domainId],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, '别名不存在', 'ALIAS_NOT_FOUND');
    const { domain, account: owner } = await domainRow(c, domainId);
    const provider = await providerFor(c, owner);
    if (!provider.deleteDomainAlias) throw new AppError(501, '当前服务商不支持域名别名', 'DNS_ALIAS_UNSUPPORTED');
    try {
      await provider.deleteDomainAlias(toDnsDomain(domain), row.remote_id);
      await db(c).execute('DELETE FROM dns_domain_aliases WHERE id = ?', [aliasId]);
      await audit(c, 'alias.delete', domain.name, row.name);
      return c.json({ code: 0 });
    } catch (error) { providerError(error); }
  });

  return routes;
}
