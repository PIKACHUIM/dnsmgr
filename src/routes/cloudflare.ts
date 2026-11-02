import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import { decrypt } from '../security/crypto';
import { asArray, asRecord } from '../dns/http';
import { DnsError } from '../dns/types';
import {
  cloudflareApi, hostnameRow, isValidCidr, normalizeHostname, validateOrigin,
  HOSTNAME_PATTERN, DNS_NAME_PATTERN, type CloudflareApiConfig,
} from '../cloudflare/api';

interface AccountRow extends Record<string, unknown> {
  id: number;
  type: string;
  name: string;
  config_cipher: string;
  remark: string | null;
}

interface DomainRow extends Record<string, unknown> {
  id: number;
  account_id: number;
  name: string;
  third_id: string | null;
}

interface DomainContext {
  domain: DomainRow;
  account: AccountRow;
  zoneId: string;
  api: ReturnType<typeof cloudflareApi>;
}

function cfError(error: unknown): never {
  if (error instanceof DnsError) {
    const status = [400, 401, 403, 404, 409, 429].includes(error.status)
      ? error.status as 400 | 401 | 403 | 404 | 409 | 429 : 503;
    throw new AppError(status, error.message, error.code);
  }
  throw error;
}

function requireSqlDatabase(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持 DNS 业务表，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

async function audit(c: Context<AppEnv>, action: string, target: string, detail: string): Promise<void> {
  await c.get('db').execute(
    'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
    [c.get('principal').user.id, action, target.slice(0, 255), detail.slice(0, 500), nowSeconds()],
  );
}

async function accountRow(c: Context<AppEnv>, accountId: number): Promise<AccountRow> {
  const rows = await c.get('db').query<AccountRow>('SELECT * FROM dns_accounts WHERE id = ?', [accountId]);
  const row = rows[0];
  if (!row) throw new AppError(404, 'DNS 账户不存在', 'ACCOUNT_NOT_FOUND');
  if (row.type !== 'cloudflare') throw new AppError(400, '仅支持 Cloudflare 账户', 'CF_ACCOUNT_REQUIRED');
  return row;
}

async function apiFor(c: Context<AppEnv>, account: AccountRow): Promise<ReturnType<typeof cloudflareApi>> {
  let config: CloudflareApiConfig;
  try {
    config = JSON.parse(await decrypt(account.config_cipher, c.env.APP_KEY, `dns-account/${account.id}`)) as CloudflareApiConfig;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'Cloudflare 账户凭据损坏，无法解密', 'ACCOUNT_CORRUPTED');
  }
  if (!config || typeof config.apikey !== 'string' || !config.apikey) {
    throw new AppError(400, 'Cloudflare 账户缺少 API 凭据', 'CF_CREDENTIALS_MISSING');
  }
  return cloudflareApi(config, c.env.BUDGET?.fetch ?? fetch);
}

async function domainContext(c: Context<AppEnv>, domainId: number): Promise<DomainContext> {
  const rows = await c.get('db').query<DomainRow>(
    `SELECT d.id, d.account_id, d.name, d.third_id FROM dns_domains d
     JOIN dns_accounts a ON a.id = d.account_id WHERE d.id = ?`, [domainId],
  );
  const domain = rows[0];
  if (!domain) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
  const account = await accountRow(c, domain.account_id);
  if (!domain.third_id) throw new AppError(409, '当前域名缺少 Cloudflare Zone ID，请重新同步域名', 'CF_ZONE_MISSING');
  return { domain, account, zoneId: domain.third_id, api: await apiFor(c, account) };
}

async function tunnelContext(c: Context<AppEnv>, accountId: number): Promise<{ account: AccountRow; cfAccountId: string; api: ReturnType<typeof cloudflareApi> }> {
  const account = await accountRow(c, accountId);
  const api = await apiFor(c, account);
  if (!api.tokenAuth) {
    throw new AppError(400, 'Cloudflare Tunnels 仅支持 API 令牌认证，请将当前账户的认证方式切换为 API 令牌', 'CF_TOKEN_REQUIRED');
  }
  let cfAccountId: string;
  try { cfAccountId = await api.accountId(); } catch (error) { cfError(error); }
  return { account, cfAccountId, api };
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

function hostnameId(value: string): string {
  if (!ID.test(value)) throw new AppError(400, '主机名编号无效', 'INVALID_ID');
  return value;
}

function tunnelIdOf(value: string): string {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(value)) throw new AppError(400, 'Tunnel 编号无效', 'INVALID_ID');
  return value;
}

function hostnamesFrom(value: unknown): string[] {
  const raw = typeof value === 'string' ? value.split(/\r?\n/) : Array.isArray(value) ? value : [];
  const list = [...new Set(raw.map((item) => normalizeHostname(String(item))).filter(Boolean))];
  if (list.length === 0 || list.length > 50) throw new AppError(400, '一次需提交 1–50 个主机名', 'INVALID_HOSTNAMES');
  for (const hostname of list) {
    if (!HOSTNAME_PATTERN.test(hostname)) throw new AppError(400, `主机名格式无效：${hostname}`, 'CF_INVALID_HOSTNAME');
  }
  return list;
}

function sslOptions(body: Record<string, unknown>, current?: Record<string, unknown>): { method: string; minTlsVersion: string } {
  const method = body.sslMethod === undefined ? String(current?.method ?? 'txt') : String(body.sslMethod);
  if (method !== 'txt' && method !== 'http') throw new AppError(400, '验证方式只能是 txt 或 http', 'CF_INVALID_SSL_METHOD');
  const minTlsVersion = body.minTlsVersion === undefined
    ? String(asRecord(current?.settings ?? {}).min_tls_version ?? '1.2')
    : String(body.minTlsVersion);
  if (!['1.0', '1.1', '1.2', '1.3'].includes(minTlsVersion)) throw new AppError(400, '最低 TLS 版本无效', 'CF_INVALID_TLS');
  return { method, minTlsVersion };
}

function originField(body: Record<string, unknown>): string | null | undefined {
  if (body.customOriginServer === undefined) return undefined;
  const value = typeof body.customOriginServer === 'string' ? body.customOriginServer : '';
  return value.trim() ? validateOrigin(value) : null;
}

async function createHostname(api: ReturnType<typeof cloudflareApi>, zoneId: string, hostname: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ssl = sslOptions(body);
  const origin = originField(body);
  const payload: Record<string, unknown> = {
    hostname,
    ssl: { method: ssl.method, type: 'dv', settings: { min_tls_version: ssl.minTlsVersion } },
  };
  if (origin) payload.custom_origin_server = origin;
  return hostnameRow(await api.call('POST', `/zones/${zoneId}/custom_hostnames`, payload));
}

async function updateHostname(api: ReturnType<typeof cloudflareApi>, zoneId: string, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = asRecord(await api.call('GET', `/zones/${zoneId}/custom_hostnames/${id}`));
  const ssl = asRecord(current.ssl ?? {});
  const options = sslOptions(body, ssl);
  const payload: Record<string, unknown> = {
    ssl: { method: options.method, type: String(ssl.type ?? 'dv'), settings: { ...asRecord(ssl.settings ?? {}), min_tls_version: options.minTlsVersion } },
  };
  const origin = originField(body);
  if (origin !== undefined) payload.custom_origin_server = origin;
  await api.call('PATCH', `/zones/${zoneId}/custom_hostnames/${id}`, payload);
  return hostnameRow(await api.call('GET', `/zones/${zoneId}/custom_hostnames/${id}`));
}

function ingressOf(config: unknown): Record<string, unknown>[] {
  return asArray(asRecord(asRecord(config).config ?? {}).ingress).map(asRecord);
}

function ensureFallback(rules: Record<string, unknown>[]): Record<string, unknown>[] {
  const output = rules.filter((rule) => !(Object.keys(rule).length === 1 && rule.service === 'http_status:404'));
  output.push({ service: 'http_status:404' });
  return output;
}

async function matchingDomain(c: Context<AppEnv>, accountId: number, hostname: string): Promise<{ name: string; zoneId: string } | null> {
  const rows = await c.get('db').query<{ name: string; third_id: string }>(
    'SELECT name, third_id FROM dns_domains WHERE account_id = ? AND third_id IS NOT NULL', [accountId],
  );
  const target = hostname.replace(/^\*\./, '').toLowerCase();
  const matches = rows.filter((row) => target === row.name.toLowerCase() || target.endsWith(`.${row.name.toLowerCase()}`));
  matches.sort((left, right) => right.name.length - left.name.length);
  return matches[0] ? { name: matches[0].name, zoneId: matches[0].third_id } : null;
}

async function cnameRecord(api: ReturnType<typeof cloudflareApi>, zoneId: string, hostname: string) {
  const rows = asArray(await api.call('GET', `/zones/${zoneId}/dns_records?per_page=100&name=${encodeURIComponent(hostname)}`)).map(asRecord);
  return rows;
}

async function syncTunnelCname(api: ReturnType<typeof cloudflareApi>, zoneId: string, hostname: string, tunnel: string): Promise<string> {
  const target = `${tunnel}.cfargotunnel.com`;
  const records = await cnameRecord(api, zoneId, hostname);
  const cname = records.find((row) => String(row.type).toUpperCase() === 'CNAME');
  if (!cname) {
    const other = records[0];
    if (other) throw new DnsError(`主机名已存在非 CNAME 记录（${String(other.type)}），无法同步 Tunnel CNAME`, 409, 'CF_DNS_CONFLICT');
    await api.call('POST', `/zones/${zoneId}/dns_records`, { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 });
    return 'created';
  }
  if (String(cname.content) === target && cname.proxied === true) return 'unchanged';
  await api.call('PATCH', `/zones/${zoneId}/dns_records/${encodeURIComponent(String(cname.id))}`, {
    type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1,
  });
  return 'updated';
}

async function removeTunnelCname(api: ReturnType<typeof cloudflareApi>, zoneId: string, hostname: string, tunnel: string): Promise<boolean> {
  const target = `${tunnel}.cfargotunnel.com`;
  const records = await cnameRecord(api, zoneId, hostname);
  const cname = records.find((row) => String(row.type).toUpperCase() === 'CNAME' && String(row.content) === target);
  if (!cname) return false;
  await api.call('DELETE', `/zones/${zoneId}/dns_records/${encodeURIComponent(String(cname.id))}`);
  return true;
}

export function cloudflareRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/cloudflare/domains/:domainId/hostnames', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    try {
      const rows = asArray(await api.call('GET', `/zones/${zoneId}/custom_hostnames?page=1&per_page=100`)).map(hostnameRow);
      return c.json({ code: 0, total: rows.length, items: rows });
    } catch (error) { cfError(error); }
  });

  routes.post('/api/v1/cloudflare/domains/:domainId/hostnames', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const body = await input(c);
    const hostname = normalizeHostname(text(body, 'hostname', 253));
    if (!HOSTNAME_PATTERN.test(hostname)) throw new AppError(400, '主机名格式无效', 'CF_INVALID_HOSTNAME');
    try {
      const created = await createHostname(api, zoneId, hostname, body);
      await audit(c, 'cf.hostname.create', domain.name, hostname);
      return c.json({ code: 0, hostname: created });
    } catch (error) { cfError(error); }
  });

  routes.patch('/api/v1/cloudflare/domains/:domainId/hostnames/:hostnameId', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const id = hostnameId(c.req.param('hostnameId'));
    const body = await input(c);
    try {
      const updated = await updateHostname(api, zoneId, id, body);
      await audit(c, 'cf.hostname.update', domain.name, `${id} ${String(updated.hostname ?? '')}`);
      return c.json({ code: 0, hostname: updated });
    } catch (error) { cfError(error); }
  });

  routes.post('/api/v1/cloudflare/domains/:domainId/hostnames/:hostnameId/refresh', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const id = hostnameId(c.req.param('hostnameId'));
    try {
      const current = asRecord(await api.call('GET', `/zones/${zoneId}/custom_hostnames/${id}`));
      const ssl = asRecord(current.ssl ?? {});
      if (!ssl.method) throw new DnsError('该主机名没有可刷新的 SSL 验证配置', 409, 'CF_SSL_MISSING');
      await api.call('PATCH', `/zones/${zoneId}/custom_hostnames/${id}`, { ssl });
      await audit(c, 'cf.hostname.refresh', domain.name, String(current.hostname ?? id));
      return c.json({ code: 0, msg: '已向 Cloudflare 重新发起验证' });
    } catch (error) { cfError(error); }
  });

  routes.delete('/api/v1/cloudflare/domains/:domainId/hostnames/:hostnameId', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const id = hostnameId(c.req.param('hostnameId'));
    try {
      await api.call('DELETE', `/zones/${zoneId}/custom_hostnames/${id}`);
      await audit(c, 'cf.hostname.delete', domain.name, id);
      return c.json({ code: 0 });
    } catch (error) { cfError(error); }
  });

  routes.post('/api/v1/cloudflare/domains/:domainId/hostnames/batch-add', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const body = await input(c);
    const hostnames = hostnamesFrom(body.hostnames);
    let added = 0;
    const errors: string[] = [];
    for (const hostname of hostnames) {
      try { await createHostname(api, zoneId, hostname, body); added++; }
      catch (error) { if (errors.length < 20) errors.push(`${hostname}：${error instanceof Error ? error.message : '未知错误'}`); }
    }
    await audit(c, 'cf.hostname.batchadd', domain.name, `${added}/${hostnames.length}`);
    return c.json({ code: 0, added, failed: hostnames.length - added, errors });
  });

  routes.post('/api/v1/cloudflare/domains/:domainId/hostnames/batch-update', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const body = await input(c);
    const ids = asArray(body.ids).map((value) => hostnameId(String(value)));
    if (ids.length === 0 || ids.length > 50) throw new AppError(400, '一次需选择 1–50 项', 'INVALID_IDS');
    let updated = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try { await updateHostname(api, zoneId, id, body); updated++; }
      catch (error) { if (errors.length < 20) errors.push(`${id}：${error instanceof Error ? error.message : '未知错误'}`); }
    }
    await audit(c, 'cf.hostname.batchupdate', domain.name, `${updated}/${ids.length}`);
    return c.json({ code: 0, updated, failed: ids.length - updated, errors });
  });

  routes.post('/api/v1/cloudflare/domains/:domainId/hostnames/batch-delete', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const body = await input(c);
    const ids = asArray(body.ids).map((value) => hostnameId(String(value)));
    if (ids.length === 0 || ids.length > 50) throw new AppError(400, '一次需选择 1–50 项', 'INVALID_IDS');
    let deleted = 0;
    for (const id of ids) {
      try { await api.call('DELETE', `/zones/${zoneId}/custom_hostnames/${id}`); deleted++; } catch { /* 旧版同样忽略单条失败 */ }
    }
    await audit(c, 'cf.hostname.batchdelete', domain.name, `${deleted}/${ids.length}`);
    return c.json({ code: 0, deleted, failed: ids.length - deleted });
  });

  routes.get('/api/v1/cloudflare/domains/:domainId/fallback-origin', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    try {
      const result = await api.call('GET', `/zones/${zoneId}/custom_hostnames/fallback_origin`, undefined, true);
      return c.json({ code: 0, origin: String(asRecord(result ?? {}).origin ?? '') });
    } catch (error) { cfError(error); }
  });

  routes.put('/api/v1/cloudflare/domains/:domainId/fallback-origin', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    const body = await input(c);
    let origin: string;
    try { origin = validateOrigin(typeof body.origin === 'string' ? body.origin : ''); } catch (error) { cfError(error); }
    if (!origin) throw new AppError(400, 'Fallback Origin 不能为空', 'CF_INVALID_ORIGIN');
    try {
      await api.call('PUT', `/zones/${zoneId}/custom_hostnames/fallback_origin`, { origin });
      await audit(c, 'cf.fallback.set', domain.name, origin);
      return c.json({ code: 0, origin });
    } catch (error) { cfError(error); }
  });

  routes.delete('/api/v1/cloudflare/domains/:domainId/fallback-origin', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { domain, api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    try {
      await api.call('DELETE', `/zones/${zoneId}/custom_hostnames/fallback_origin`, undefined, true);
      await audit(c, 'cf.fallback.delete', domain.name, '');
      return c.json({ code: 0 });
    } catch (error) { cfError(error); }
  });

  routes.get('/api/v1/cloudflare/domains/:domainId/dcv-uuid', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { api, zoneId } = await domainContext(c, Number(c.req.param('domainId')));
    try {
      const result = await api.call('GET', `/zones/${zoneId}/dcv_delegation/uuid`, undefined, true);
      return c.json({ code: 0, uuid: String(asRecord(result ?? {}).uuid ?? '') });
    } catch (error) { cfError(error); }
  });

  routes.get('/api/v1/cloudflare/accounts/:accountId/tunnels', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    try {
      const rows = asArray(await api.call('GET', `/accounts/${cfAccountId}/cfd_tunnel?is_deleted=false&page=1&per_page=100`)).map((raw) => {
        const row = asRecord(raw);
        return {
          id: String(row.id ?? ''), name: String(row.name ?? ''), status: String(row.status ?? ''),
          connections: asArray(row.connections).length,
          createdAt: typeof row.created_at === 'string' ? row.created_at : null,
        };
      });
      return c.json({ code: 0, accountId: cfAccountId, items: rows });
    } catch (error) { cfError(error); }
  });

  routes.post('/api/v1/cloudflare/accounts/:accountId/tunnels', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const body = await input(c);
    const name = text(body, 'name', 64).trim();
    if (!name) throw new AppError(400, 'Tunnel 名称不能为空', 'INVALID_NAME');
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    try {
      const result = asRecord(await api.call('POST', `/accounts/${cfAccountId}/cfd_tunnel`, { name, tunnel_secret: secret }));
      await audit(c, 'cf.tunnel.create', account.name, `${name} ${String(result.id ?? '')}`);
      return c.json({ code: 0, tunnel: { id: String(result.id ?? ''), name: String(result.name ?? name) } });
    } catch (error) { cfError(error); }
  });

  routes.delete('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    try {
      await api.call('DELETE', `/accounts/${cfAccountId}/cfd_tunnel/${tunnelId}`);
      await audit(c, 'cf.tunnel.delete', account.name, tunnelId);
      return c.json({ code: 0 });
    } catch (error) { cfError(error); }
  });

  routes.get('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/token', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    try {
      const result = await api.call('GET', `/accounts/${cfAccountId}/cfd_tunnel/${tunnelId}/token`);
      return c.json({ code: 0, token: typeof result === 'string' ? result : String(asRecord(result).token ?? '') });
    } catch (error) { cfError(error); }
  });

  async function configuration(c: Context<AppEnv>, cfAccountId: string, tunnelId: string, api: ReturnType<typeof cloudflareApi>): Promise<{ config: Record<string, unknown>; ingress: Record<string, unknown>[] }> {
    const result = await api.call('GET', `/accounts/${cfAccountId}/cfd_tunnel/${tunnelId}/configurations`, undefined, true);
    const config = asRecord(asRecord(result ?? {}).config ?? {});
    return { config, ingress: asArray(config.ingress).map(asRecord) };
  }

  async function saveConfiguration(cfAccountId: string, tunnelId: string, api: ReturnType<typeof cloudflareApi>, config: Record<string, unknown>, ingress: Record<string, unknown>[]): Promise<void> {
    await api.call('PUT', `/accounts/${cfAccountId}/cfd_tunnel/${tunnelId}/configurations`, {
      config: { ...config, ingress: ensureFallback(ingress) },
    });
  }

  routes.get('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/public-hostnames', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    try {
      const { ingress } = await configuration(c, cfAccountId, tunnelId, api);
      const rows = [];
      for (const rule of ingress) {
        if (!rule.hostname) continue;
        const match = await matchingDomain(c, account.id, String(rule.hostname));
        rows.push({
          hostname: String(rule.hostname), service: String(rule.service ?? ''),
          path: String(rule.path ?? ''), zoneName: match?.name ?? null, zoneId: match?.zoneId ?? null,
        });
      }
      return c.json({ code: 0, items: rows });
    } catch (error) { cfError(error); }
  });

  routes.put('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/public-hostnames', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    const body = await input(c);
    const hostname = normalizeHostname(text(body, 'hostname', 253));
    if (!DNS_NAME_PATTERN.test(hostname)) throw new AppError(400, '主机名格式无效', 'CF_INVALID_HOSTNAME');
    const service = text(body, 'service', 255).trim();
    if (!service) throw new AppError(400, '服务地址不能为空', 'INVALID_SERVICE');
    const path = typeof body.path === 'string' ? body.path.trim().slice(0, 255) : '';
    const match = await matchingDomain(c, account.id, hostname);
    if (!match) throw new AppError(400, '未找到匹配的本地域名，请先在当前 Cloudflare 账户下导入该主机名所属主域', 'CF_DOMAIN_MISSING');
    try {
      const { config, ingress } = await configuration(c, cfAccountId, tunnelId, api);
      const rule: Record<string, unknown> = { hostname, service };
      if (path) rule.path = path;
      const index = ingress.findIndex((item) => item.hostname === hostname && String(item.path ?? '') === path);
      if (index >= 0) ingress[index] = rule;
      else {
        const fallback = ingress.findIndex((item) => item.hostname === undefined);
        if (fallback >= 0) ingress.splice(fallback, 0, rule); else ingress.push(rule);
      }
      await saveConfiguration(cfAccountId, tunnelId, api, config, ingress);
      try {
        const dns = await syncTunnelCname(api, match.zoneId, hostname, tunnelId);
        await audit(c, 'cf.tunnel.public.save', account.name, `${hostname} ${service} dns=${dns}`);
        return c.json({ code: 0, dns });
      } catch (error) {
        await saveConfiguration(cfAccountId, tunnelId, api, config, asArray(config.ingress).map(asRecord)).catch(() => {});
        const message = error instanceof Error ? error.message : '未知错误';
        throw new DnsError(`Public Hostname 已回滚：${message}`, error instanceof DnsError ? error.status : 502, 'CF_TUNNEL_ROLLBACK');
      }
    } catch (error) { cfError(error); }
  });

  routes.delete('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/public-hostnames', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    const hostname = normalizeHostname(c.req.query('hostname') ?? '');
    const path = (c.req.query('path') ?? '').slice(0, 255);
    if (!DNS_NAME_PATTERN.test(hostname)) throw new AppError(400, '主机名格式无效', 'CF_INVALID_HOSTNAME');
    const match = await matchingDomain(c, account.id, hostname);
    try {
      const { config, ingress } = await configuration(c, cfAccountId, tunnelId, api);
      const next = ingress.filter((rule) => !(rule.hostname === hostname && String(rule.path ?? '') === path));
      await saveConfiguration(cfAccountId, tunnelId, api, config, next);
      if (match) {
        try { await removeTunnelCname(api, match.zoneId, hostname, tunnelId); }
        catch (error) {
          await saveConfiguration(cfAccountId, tunnelId, api, config, ingress).catch(() => {});
          const message = error instanceof Error ? error.message : '未知错误';
          throw new DnsError(`Public Hostname 删除已回滚：${message}`, 502, 'CF_TUNNEL_ROLLBACK');
        }
      }
      await audit(c, 'cf.tunnel.public.delete', account.name, `${hostname}${path ? ` ${path}` : ''}`);
      return c.json({ code: 0 });
    } catch (error) { cfError(error); }
  });

  routes.get('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/cidr-routes', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    try {
      const rows = asArray(await api.call('GET', `/accounts/${cfAccountId}/teamnet/routes?is_deleted=false&tunnel_id=${tunnelId}`)).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.id ?? ''), network: String(row.network ?? ''), comment: row.comment ?? null };
      }).filter((row) => row.id && row.network);
      return c.json({ code: 0, items: rows });
    } catch (error) { cfError(error); }
  });

  routes.post('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/cidr-routes', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    const body = await input(c);
    const network = text(body, 'network', 64).trim();
    if (!isValidCidr(network)) throw new AppError(400, 'CIDR 格式无效', 'INVALID_CIDR');
    try {
      const result = asRecord(await api.call('POST', `/accounts/${cfAccountId}/teamnet/routes`, {
        network, tunnel_id: tunnelId, ...(body.comment ? { comment: String(body.comment).slice(0, 100) } : {}),
      }));
      await audit(c, 'cf.tunnel.cidr.add', account.name, `${network} ${tunnelId}`);
      return c.json({ code: 0, id: String(result.id ?? '') });
    } catch (error) { cfError(error); }
  });

  routes.delete('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/cidr-routes/:routeId', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    const routeId = hostnameId(c.req.param('routeId'));
    try {
      const rows = asArray(await api.call('GET', `/accounts/${cfAccountId}/teamnet/routes?is_deleted=false&tunnel_id=${tunnelId}`)).map(asRecord);
      if (!rows.some((row) => String(row.id) === routeId)) throw new DnsError('CIDR 路由不存在或不属于当前 Tunnel', 404, 'CF_ROUTE_NOT_FOUND');
      await api.call('DELETE', `/accounts/${cfAccountId}/teamnet/routes/${routeId}`);
      await audit(c, 'cf.tunnel.cidr.delete', account.name, `${routeId} ${tunnelId}`);
      return c.json({ code: 0 });
    } catch (error) { cfError(error); }
  });

  routes.get('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/hostname-routes', requireSession, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    try {
      const rows = asArray(await api.call('GET', `/accounts/${cfAccountId}/zerotrust/routes/hostname?is_deleted=false&tunnel_id=${tunnelId}`)).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.id ?? ''), hostname: String(row.hostname ?? ''), comment: row.comment ?? null };
      });
      return c.json({ code: 0, items: rows });
    } catch (error) { cfError(error); }
  });

  routes.post('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/hostname-routes', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    const body = await input(c);
    const hostname = normalizeHostname(text(body, 'hostname', 253));
    if (!DNS_NAME_PATTERN.test(hostname)) throw new AppError(400, '主机名格式无效', 'CF_INVALID_HOSTNAME');
    try {
      const result = asRecord(await api.call('POST', `/accounts/${cfAccountId}/zerotrust/routes/hostname`, {
        hostname, tunnel_id: tunnelId, ...(body.comment ? { comment: String(body.comment).slice(0, 100) } : {}),
      }));
      await audit(c, 'cf.tunnel.hostroute.add', account.name, `${hostname} ${tunnelId}`);
      return c.json({ code: 0, id: String(result.id ?? '') });
    } catch (error) { cfError(error); }
  });

  routes.delete('/api/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/hostname-routes/:routeId', requireSession, requireCsrf, async (c) => {
    requireSqlDatabase(c);
    requireAdmin(c);
    const { account, cfAccountId, api } = await tunnelContext(c, Number(c.req.param('accountId')));
    const tunnelId = tunnelIdOf(c.req.param('tunnelId'));
    const routeId = hostnameId(c.req.param('routeId'));
    try {
      const rows = asArray(await api.call('GET', `/accounts/${cfAccountId}/zerotrust/routes/hostname?is_deleted=false&tunnel_id=${tunnelId}`)).map(asRecord);
      if (!rows.some((row) => String(row.id) === routeId)) throw new DnsError('主机名路由不存在或不属于当前 Tunnel', 404, 'CF_ROUTE_NOT_FOUND');
      await api.call('DELETE', `/accounts/${cfAccountId}/zerotrust/routes/hostname/${routeId}`);
      await audit(c, 'cf.tunnel.hostroute.delete', account.name, `${routeId} ${tunnelId}`);
      return c.json({ code: 0 });
    } catch (error) { cfError(error); }
  });

  return routes;
}
