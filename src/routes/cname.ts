import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input } from '../core/request';
import { nowSeconds, requireAdmin, requireCertificateSession, requireCsrf } from '../security/auth';

interface ProxyRow extends Record<string, unknown> {
  id: number;
  domain: string;
  target: string;
  dns_domain_id: number;
  zone_name: string;
  enabled: number;
  remark: string | null;
  created_at: number;
  updated_at: number;
}

interface ZoneRow extends Record<string, unknown> {
  id: number;
  name: string;
  third_id: string | null;
}

const FQDN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const TARGET_FQDN = /^(?=.{1,253}$)(?!-)[a-z0-9_-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9_-]{1,63}(?<!-))+$/;

function normalizeFqdn(value: unknown, label: string, reason: string, target = false): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.$/, '') : '';
  if (!(target ? TARGET_FQDN : FQDN).test(normalized)) throw new AppError(400, `${label}格式无效`, reason);
  return normalized;
}

function proxyId(value: unknown): number {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new AppError(400, 'CNAME 代理编号无效', 'INVALID_CNAME_ID');
  }
  return Number(raw);
}

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, 'CNAME 代理目前仅支持 DB_FORMAT=sql', 'CERT_STORAGE_UNSUPPORTED');
  }
}

/** 选择覆盖 target 且已同步到本系统的最长 DNS Zone。 */
async function resolveZone(c: Context<AppEnv>, target: string): Promise<ZoneRow> {
  const zones = await c.get('db').query<ZoneRow>(
    `SELECT d.id,d.name,d.third_id FROM dns_domains d WHERE d.third_id IS NOT NULL AND d.third_id<>''
      AND (d.name=? OR ? LIKE '%.' || d.name) ORDER BY length(d.name) DESC LIMIT 1`, [target, target],
  );
  const zone = zones[0];
  if (!zone) throw new AppError(400, 'CNAME 目标必须位于已同步的 DNS Zone 内', 'CNAME_TARGET_ZONE_NOT_FOUND');
  return zone;
}

async function loadProxies(c: Context<AppEnv>): Promise<ProxyRow[]> {
  return c.get('db').query<ProxyRow>(
    `SELECT p.id,p.domain,p.target,p.dns_domain_id,d.name AS zone_name,p.enabled,p.remark,p.created_at,p.updated_at
     FROM cert_cname_proxies p JOIN dns_domains d ON d.id=p.dns_domain_id
     ORDER BY p.id DESC`,
  );
}

function view(row: ProxyRow) {
  return {
    id: row.id, domain: row.domain, target: row.target, dnsDomainId: row.dns_domain_id,
    zoneName: row.zone_name, enabled: row.enabled === 1, remark: row.remark,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function certificateCnameRoutes() {
  const routes = new Hono<AppEnv>();

  routes.use('/api/v1/cert/cname*', async (c, next) => {
    requireSql(c);
    await next();
  });

  routes.get('/api/v1/cert/cname', requireCertificateSession, async (c) => {
    requireAdmin(c);
    return c.json({ code: 0, items: (await loadProxies(c)).map(view) });
  });

  routes.post('/api/v1/cert/cname', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const domain = normalizeFqdn(body.domain, '域名', 'INVALID_CNAME_DOMAIN');
    const target = normalizeFqdn(body.target, 'CNAME 目标', 'INVALID_CNAME_TARGET', true);
    const zone = await resolveZone(c, target);
    const existing = await c.get('db').query<{ id: number }>('SELECT id FROM cert_cname_proxies WHERE domain=?', [domain]);
    if (existing[0]) throw new AppError(409, '该域名已配置 CNAME 代理', 'CNAME_DOMAIN_EXISTS');
    const now = nowSeconds();
    const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 200) || null : null;
    const result = await c.get('db').execute(
      `INSERT INTO cert_cname_proxies (domain,target,dns_domain_id,enabled,remark,created_by,created_at,updated_at)
       VALUES (?,?,?,1,?,?,?,?) RETURNING id`,
      [domain, target, zone.id, remark, c.get('principal').user.id, now, now],
    );
    const created = result.rows[0] as { id: number } | undefined;
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.cname.create', domain, `${domain} -> ${target} (${zone.name})`, now],
    );
    return c.json({ code: 0, id: created?.id ?? 0, dnsDomainId: zone.id, zoneName: zone.name });
  });

  routes.patch('/api/v1/cert/cname/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const cnameId = proxyId(c.req.param('id'));
    const body = await input(c);
    const rows = await c.get('db').query<ProxyRow>(
      `SELECT p.id,p.domain,p.target,p.dns_domain_id,d.name AS zone_name,p.enabled,p.remark,p.created_at,p.updated_at
       FROM cert_cname_proxies p JOIN dns_domains d ON d.id=p.dns_domain_id WHERE p.id=?`, [cnameId],
    );
    const current = rows[0];
    if (!current) throw new AppError(404, 'CNAME 代理不存在', 'CNAME_NOT_FOUND');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new AppError(400, '启用状态无效', 'INVALID_CNAME_STATUS');
    }
    let target = current.target;
    let dnsDomainId = current.dns_domain_id;
    if (body.target !== undefined) {
      target = normalizeFqdn(body.target, 'CNAME 目标', 'INVALID_CNAME_TARGET', true);
      dnsDomainId = (await resolveZone(c, target)).id;
    }
    const remark = body.remark === undefined
      ? current.remark
      : typeof body.remark === 'string' ? body.remark.trim().slice(0, 200) || null : null;
    const enabled = body.enabled === undefined ? current.enabled : body.enabled ? 1 : 0;
    await c.get('db').execute(
      'UPDATE cert_cname_proxies SET target=?,dns_domain_id=?,enabled=?,remark=?,updated_at=? WHERE id=?',
      [target, dnsDomainId, enabled, remark, nowSeconds(), cnameId],
    );
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.cname.update', current.domain, `enabled=${enabled} target=${target}`, nowSeconds()],
    );
    return c.json({ code: 0, id: cnameId, enabled: enabled === 1, target });
  });

  routes.delete('/api/v1/cert/cname/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const cnameId = proxyId(c.req.param('id'));
    const rows = await c.get('db').query<{ domain: string }>('SELECT domain FROM cert_cname_proxies WHERE id=?', [cnameId]);
    if (!rows[0]) throw new AppError(404, 'CNAME 代理不存在', 'CNAME_NOT_FOUND');
    await c.get('db').execute('DELETE FROM cert_cname_proxies WHERE id=?', [cnameId]);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.cname.delete', rows[0].domain, String(cnameId), nowSeconds()],
    );
    return c.json({ code: 0 });
  });

  return routes;
}
