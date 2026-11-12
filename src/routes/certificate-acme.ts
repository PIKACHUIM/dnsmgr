import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import type { SqlValue } from '../storage/sql';
import type { DnsDomain, DnsRecordInput } from '../dns/types';
import { createProvider } from '../dns/registry';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { nowSeconds, requireAdmin, requireCertificateSession, requireCsrf } from '../security/auth';
import { decrypt, encrypt } from '../security/crypto';
import { normalizeCertificateDomains, inspectCertificate } from '../certificates';
import { certificateEventContent, notificationStatement } from '../notify/certificate';
import {
  AcmeProtocolError, acmeDirectoryUrl, createAcmeAccountKey, createCertificateKeyAndCsr, dns01Value,
  acmeCaCatalog, externalAccountBinding, fetchAcmeNonce, isAcmeCa, loadAcmeDirectory, postAcmeJws,
  validateAcmeDirectoryUrl, validateAcmeUrlFrom,
  type AcmeDirectory, type AcmeEnvironment, type AcmeJwsResponse,
} from '../certificates/acme';

interface AccountRow extends Record<string, unknown> {
  id: number;
  directory: AcmeEnvironment;
  directory_url: string;
  directory_json: string | null;
  email: string;
  kid: string | null;
  replay_nonce: string | null;
  claimed_nonce: string | null;
  claimed_at: number | null;
  account_key_cipher: string;
  ca: string;
  eab_kid: string | null;
  eab_hmac_cipher: string | null;
  status: 'pending_directory' | 'pending_registration' | 'registration_unknown' | 'ready' | 'disabled';
  created_by: number;
  created_at: number;
  updated_at: number;
}

interface IssuanceRow extends Record<string, unknown> {
  id: number;
  account_id: number;
  dns_domain_id: number;
  dns_account_id: number;
  created_by: number;
  directory: AcmeEnvironment;
  directory_json: string;
  account_kid: string;
  account_key_cipher: string;
  replay_nonce: string | null;
  claimed_nonce: string | null;
  claimed_at: number | null;
  domains_json: string;
  authorization_state_json: string;
  authorization_index: number;
  status: string;
  remote_order_url: string | null;
  finalize_url: string | null;
  certificate_url: string | null;
  csr_der: string;
  private_key_cipher: string;
  cert_order_id: number | null;
  renewal_of: number | null;
  ca: string;
  challenge_map_json: string;
  dns_config_cipher: string;
  dns_type: string;
  dns_zone_name: string;
  dns_zone_remote_id: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface AuthorizationState {
  url: string;
  status: 'pending' | 'valid';
  identifier?: string;
  wildcard?: boolean;
  challengeUrl?: string;
  txtName?: string;
  txtValue?: string;
  dnsRecordId?: string;
  challengeStatus?: 'ready' | 'adding' | 'present' | 'unknown' | 'triggering' | 'submitted' | 'valid' | 'cleaning';
}

function id(value: unknown, field: string): number {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw new AppError(400, `${field} 编号无效`, 'INVALID_CERT_ID');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new AppError(400, `${field} 编号无效`, 'INVALID_CERT_ID');
  return parsed;
}

function randomId(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return Number(value & BigInt(Number.MAX_SAFE_INTEGER)) || 1;
}

function directory(row: { directory: AcmeEnvironment; directory_json: string | null }): AcmeDirectory {
  if (!row.directory_json) throw new AppError(409, '请先读取 ACME Directory', 'ACME_DIRECTORY_REQUIRED');
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
    ...(typeof value.keyChange === 'string' ? { keyChange: validateAcmeUrlFrom(origin, value.keyChange) } : {}),
    ...(value.meta && typeof value.meta === 'object' && !Array.isArray(value.meta)
      ? { meta: value.meta as AcmeDirectory['meta'] } : {}),
  };
}

function acmeOrigin(row: { directory: AcmeEnvironment; directory_json: string | null }): string {
  return new URL(directory(row).newNonce).origin;
}

function jsonObject(value: unknown, errorReason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(502, 'ACME 响应格式无效', errorReason);
  return value as Record<string, unknown>;
}

function authorizationStates(value: string): AuthorizationState[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new AppError(503, 'ACME 授权状态损坏', 'ACME_STATE_CORRUPT'); }
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.url !== 'string')) {
    throw new AppError(503, 'ACME 授权状态损坏', 'ACME_STATE_CORRUPT');
  }
  return parsed as AuthorizationState[];
}

function domainsFrom(row: { domains_json: string }): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(row.domains_json); } catch { throw new AppError(503, '证书域名状态损坏', 'ACME_STATE_CORRUPT'); }
  return normalizeCertificateDomains(parsed);
}

function activeAuthorization(row: IssuanceRow): { states: AuthorizationState[]; state: AuthorizationState } {
  const states = authorizationStates(row.authorization_state_json);
  const state = states[row.authorization_index];
  if (!state) throw new AppError(409, '没有待处理的 ACME 授权', 'ACME_NO_PENDING_AUTHORIZATION');
  return { states, state };
}

function requireAffected(changes: number, reason: string): void {
  if (changes !== 1) throw new AppError(409, '证书状态已改变，请刷新后重试', reason);
}

function acmeFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AcmeProtocolError) {
    if (error.status === 429) return new AppError(429, 'CA 请求被限流，请稍后再试', 'ACME_RATE_LIMITED');
    return new AppError(502, `CA 请求未完成（HTTP ${error.status}）`, error.problemType?.includes('badNonce') ? 'ACME_NONCE_REJECTED' : 'ACME_CA_REJECTED');
  }
  return new AppError(503, '无法确认 CA 请求结果；请先检查订单状态，不要盲目重试', 'ACME_OUTCOME_UNKNOWN');
}

function validateRemoteNonce(response: AcmeJwsResponse): string | null {
  if (response.replayNonce === null) return null;
  if (response.replayNonce.length > 512) throw new AppError(502, 'CA 返回的 Replay-Nonce 无效', 'ACME_NONCE_INVALID');
  return response.replayNonce;
}

async function accountById(c: Context<AppEnv>, accountId: number): Promise<AccountRow> {
  const rows = await c.get('db').query<AccountRow>('SELECT * FROM cert_acme_accounts WHERE id=?', [accountId]);
  if (!rows[0]) throw new AppError(404, 'ACME 账户不存在', 'ACME_ACCOUNT_NOT_FOUND');
  return rows[0];
}

const ISSUANCE_SELECT = `SELECT o.*, a.config_cipher AS dns_config_cipher, a.type AS dns_type,
      d.name AS dns_zone_name, d.third_id AS dns_zone_remote_id
     FROM cert_acme_orders o
     JOIN dns_accounts a ON a.id=o.dns_account_id
     JOIN dns_domains d ON d.id=o.dns_domain_id`;

async function issuanceById(c: Context<AppEnv>, orderId: number): Promise<IssuanceRow> {
  const rows = await c.get('db').query<IssuanceRow>(`${ISSUANCE_SELECT} WHERE o.id=?`, [orderId]);
  if (!rows[0]) throw new AppError(404, '证书签发任务不存在', 'ACME_ORDER_NOT_FOUND');
  return rows[0];
}

async function claimIssuance(
  c: Context<AppEnv>, orderId: number, claimSql: string, message: string, reason: string,
): Promise<IssuanceRow> {
  const [claimed, loaded] = await c.get('db').batch([
    { sql: claimSql, args: [nowSeconds(), orderId] },
    { sql: `${ISSUANCE_SELECT} WHERE o.id=?`, args: [orderId] },
  ]);
  const row = loaded?.rows[0] as IssuanceRow | undefined;
  if ((claimed?.changes ?? 0) !== 1 || !row) throw new AppError(409, message, reason);
  return row;
}

async function reserveAccountNonce(c: Context<AppEnv>, accountId: number, status: string, nextStatus = status): Promise<AccountRow> {
  const result = await c.get('db').execute(
    `UPDATE cert_acme_accounts SET claimed_nonce=replay_nonce,replay_nonce=NULL,status=?,claimed_at=?,updated_at=?
     WHERE id=? AND status=? AND replay_nonce IS NOT NULL
      AND (claimed_nonce IS NULL OR claimed_at<=?) RETURNING *`, [nextStatus, nowSeconds(), nowSeconds(), accountId, status, nowSeconds() - 60],
  );
  const row = result.rows[0] as AccountRow | undefined;
  if (!row) throw new AppError(409, '账户没有可用的一次性 CA nonce；请先获取新的 nonce', 'ACME_NONCE_REQUIRED');
  return row;
}

async function reserveOrderNonce(c: Context<AppEnv>, orderId: number, allowedStatuses: string[], nextStatus?: string): Promise<IssuanceRow> {
  const placeholders = allowedStatuses.map(() => '?').join(',');
  const result = await c.get('db').execute(
    `UPDATE cert_acme_orders SET claimed_nonce=replay_nonce,replay_nonce=NULL,status=COALESCE(?,status),claimed_at=?,updated_at=?
     WHERE id=? AND status IN (${placeholders}) AND replay_nonce IS NOT NULL
       AND (claimed_nonce IS NULL OR claimed_at<=?) RETURNING *`,
    [nextStatus ?? null, nowSeconds(), nowSeconds(), orderId, ...allowedStatuses, nowSeconds() - 60],
  );
  const row = result.rows[0] as IssuanceRow | undefined;
  if (!row) throw new AppError(409, '订单状态不允许此操作，或没有可用的一次性 CA nonce', 'ACME_STEP_NOT_AVAILABLE');
  return row;
}

async function releaseAccountNonce(c: Context<AppEnv>, accountId: number, claimedNonce: string, nextNonce: string | null, status?: string): Promise<void> {
  const result = await c.get('db').execute(
    `UPDATE cert_acme_accounts SET replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,status=COALESCE(?,status),updated_at=?
     WHERE id=? AND claimed_nonce=?`, [nextNonce, status ?? null, nowSeconds(), accountId, claimedNonce],
  );
  requireAffected(result.changes, 'ACME_ACCOUNT_NONCE_RELEASE_FAILED');
}

async function updateOrder(c: Context<AppEnv>, _idValue: number, currentStatus: string, sql: string, args: SqlValue[]): Promise<void> {
  const result = await c.get('db').execute(sql, args);
  requireAffected(result.changes, `ACME_STATUS_${currentStatus.toUpperCase()}`);
}

async function readDirectory(row: AccountRow): Promise<AcmeDirectory> {
  return directory(row);
}

async function signedPost(c: Context<AppEnv>, row: Pick<IssuanceRow, 'directory' | 'directory_json' | 'account_key_cipher' | 'account_id' | 'account_kid' | 'claimed_nonce'>, url: string, payload: unknown): Promise<AcmeJwsResponse> {
  if (!row.claimed_nonce) throw new AppError(409, '请先获取新的 ACME nonce', 'ACME_NONCE_REQUIRED');
  const apiDirectory = directory({ directory: row.directory, directory_json: row.directory_json });
  const origin = new URL(apiDirectory.newNonce).origin;
  let accountKey: string;
  try { accountKey = await decrypt(row.account_key_cipher, c.env.APP_KEY, `cert-acme-account/${row.account_id}/key`); }
  catch { throw new AppError(503, 'ACME 账户密钥无法解密', 'ACME_ACCOUNT_KEY_UNAVAILABLE'); }
  return postAcmeJws(c.env.BUDGET.fetch, {
    environment: row.directory, origin, privateKeyPem: accountKey, nonce: row.claimed_nonce,
    url: validateAcmeUrlFrom(origin, url), payload, kid: row.account_kid,
  });
}

function handleAcmeError(error: unknown): never {
  throw acmeFailure(error);
}

function normalizeTxtValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1');
}

function relativeTxtName(fullName: string, zoneName: string): string {
  const full = fullName.toLowerCase().replace(/\.$/, '');
  const zone = zoneName.toLowerCase().replace(/\.$/, '');
  if (full === zone) return '@';
  const suffix = `.${zone}`;
  if (!full.endsWith(suffix)) throw new AppError(400, 'DNS challenge 不属于选定的 DNS Zone', 'ACME_DNS_ZONE_MISMATCH');
  return full.slice(0, -suffix.length);
}

function coversZone(domain: string, zone: string): boolean {
  const normalized = domain.replace(/^\*\./, '').toLowerCase();
  const suffix = zone.toLowerCase();
  return normalized === suffix || normalized.endsWith(`.${suffix}`);
}

function challengeMapFrom(row: { challenge_map_json: string | null }): Record<string, string> {
  if (!row.challenge_map_json) return {};
  try {
    const parsed: unknown = JSON.parse(row.challenge_map_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

interface ChallengeZone {
  id: number; name: string; remoteId: string; accountId: number; type: string; configCipher: string;
}

interface ProxyRow extends Record<string, unknown> {
  domain: string;
  target: string;
  zone_id: number;
  zone_name: string;
  zone_third_id: string | null;
  account_id: number;
  account_type: string;
  config_cipher: string;
}

/**
 * 计算每个域名对应的 challenge FQDN。
 * 不在所选 Zone 内的域名必须有启用的 CNAME 代理，且所有域名最终写入同一个 Zone。
 */
async function resolveChallengeZone(
  c: Context<AppEnv>, selected: ChallengeZone, domains: string[],
): Promise<{ map: Record<string, string>; zone: ChallengeZone }> {
  const identifiers = [...new Set(domains.map((domain) => domain.replace(/^\*\./, '')))];
  const missing = identifiers.filter((identifier) => !coversZone(`_acme-challenge.${identifier}`, selected.name));
  const proxies = missing.length === 0 ? [] : await c.get('db').query<ProxyRow>(
    `SELECT p.domain,p.target,d.id AS zone_id,d.name AS zone_name,d.third_id AS zone_third_id,
       d.account_id,a.type AS account_type,a.config_cipher
     FROM cert_cname_proxies p
     JOIN dns_domains d ON d.id=p.dns_domain_id
     JOIN dns_accounts a ON a.id=d.account_id
     WHERE p.enabled=1 AND p.domain IN (${missing.map(() => '?').join(',')})`, [...missing],
  );
  const byDomain = new Map(proxies.map((row) => [row.domain, row]));
  const map: Record<string, string> = {};
  const zones = new Map<number, ChallengeZone>();
  for (const identifier of identifiers) {
    const challenge = `_acme-challenge.${identifier}`;
    if (coversZone(challenge, selected.name)) {
      map[identifier] = challenge;
      zones.set(selected.id, selected);
      continue;
    }
    const proxy = byDomain.get(identifier);
    if (!proxy) {
      throw new AppError(400, `${identifier} 未在所选 DNS Zone 内，也没有启用的 CNAME 代理`, 'ACME_DNS_ZONE_MISMATCH');
    }
    if (!proxy.zone_third_id) {
      throw new AppError(400, 'CNAME 代理 Zone 尚未同步到本系统', 'ACME_DNS_ZONE_UNSYNCED');
    }
    const target = proxy.target.toLowerCase().replace(/\.$/, '');
    if (!coversZone(target, proxy.zone_name)) {
      throw new AppError(400, 'CNAME 代理目标不在其 DNS Zone 内', 'CNAME_TARGET_ZONE_NOT_FOUND');
    }
    map[identifier] = target;
    zones.set(proxy.zone_id, {
      id: proxy.zone_id, name: proxy.zone_name, remoteId: proxy.zone_third_id,
      accountId: proxy.account_id, type: proxy.account_type, configCipher: proxy.config_cipher,
    });
  }
  if (zones.size > 1) {
    throw new AppError(400, '证书域名分散在多个 DNS Zone，请为它们配置同一个 CNAME 代理 Zone', 'ACME_MULTI_ZONE_UNSUPPORTED');
  }
  const [zone] = [...zones.values()];
  return { map, zone: zone ?? selected };
}

function certificateCovers(requested: string, certificateNames: string[]): boolean {
  return certificateNames.some((name) => {
    if (name === requested) return true;
    if (!name.startsWith('*.') || requested.startsWith('*.')) return false;
    const suffix = name.slice(2);
    const requestedLabels = requested.split('.');
    const suffixLabels = suffix.split('.');
    return requestedLabels.length === suffixLabels.length + 1 && requested.endsWith(`.${suffix}`);
  });
}

function nextAuthorizationStatus(states: AuthorizationState[], index: number, expectedDomains: string[]): 'authorizing' | 'ready_to_finalize' {
  if (index < states.length) return 'authorizing';
  const authorized = states.map((state) => state.identifier).filter((value): value is string => typeof value === 'string');
  if (authorized.length !== expectedDomains.length || new Set(authorized).size !== authorized.length
    || expectedDomains.some((domain) => !authorized.includes(domain))) {
    throw new AppError(502, 'CA 授权列表与请求域名不一致', 'ACME_AUTHORIZATION_MISMATCH');
  }
  return 'ready_to_finalize';
}

function outputOrder(row: Pick<IssuanceRow, 'id' | 'directory' | 'ca' | 'status' | 'domains_json' | 'authorization_state_json' | 'cert_order_id' | 'last_error' | 'remote_order_url' | 'replay_nonce' | 'claimed_nonce' | 'claimed_at' | 'created_at' | 'updated_at'>) {
  const states = authorizationStates(row.authorization_state_json);
  return {
    id: row.id, environment: row.directory, ca: row.ca, status: row.status, domains: domainsFrom(row),
    certificateOrderId: row.cert_order_id, lastError: row.last_error,
    canPoll: row.remote_order_url !== null,
    nonceReady: row.replay_nonce !== null,
    requestInFlight: row.claimed_nonce !== null && (row.claimed_at ?? 0) > nowSeconds() - 60,
    needsDnsCleanup: states.some((state) => Boolean(state.dnsRecordId)),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function certificateAcmeRoutes() {
  const routes = new Hono<AppEnv>();
  routes.use('/api/v1/cert/acme/*', async (c, next) => {
    if (c.get('storage').config.format !== 'sql') throw new AppError(501, '证书签发当前仅支持 DB_FORMAT=sql', 'CERT_STORAGE_UNSUPPORTED');
    await next();
  });

  routes.get('/api/v1/cert/acme/accounts', requireCertificateSession, async (c) => {
    requireAdmin(c);
    const rows = await c.get('db').query<AccountRow>(
      `SELECT id,directory,directory_url,directory_json,email,kid,status,replay_nonce,claimed_nonce,claimed_at,created_at,updated_at,ca
       FROM cert_acme_accounts ORDER BY created_at DESC,id DESC`,
    );
    return c.json({ code: 0, items: rows.map((row) => ({
      id: row.id, environment: row.directory, ca: row.ca, email: row.email, status: row.status,
      nonceReady: row.replay_nonce !== null,
      requestInFlight: row.claimed_nonce !== null && (row.claimed_at ?? 0) > nowSeconds() - 60,
      termsOfService: row.directory_json ? directory(row).meta?.termsOfService ?? null : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })) });
  });

  routes.post('/api/v1/cert/acme/accounts', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const email = text(body, 'email', 254).trim().toLowerCase();
    const [localPart, domainPart, extra] = email.split('@');
    const domainLabels = (domainPart ?? '').split('.');
    if (extra !== undefined || !localPart || !/^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+$/i.test(localPart)
      || domainLabels.length < 2 || domainLabels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      || domainLabels.at(-1)!.length < 2) {
      throw new AppError(400, '联系邮箱格式无效', 'INVALID_ACME_EMAIL');
    }
    const ca = body.ca === undefined ? 'letsencrypt' : isAcmeCa(body.ca) ? body.ca : null;
    if (!ca) throw new AppError(400, '不支持的 ACME 服务商', 'INVALID_ACME_CA');
    const catalogEntry = acmeCaCatalog[ca];
    const environment = body.environment === 'production' ? 'production' : body.environment === 'staging' ? 'staging' : null;
    if (!environment) throw new AppError(400, '请选择 ACME 环境', 'INVALID_ACME_ENVIRONMENT');
    const directoryUrl = ca === 'customacme'
      ? validateAcmeDirectoryUrl(typeof body.directoryUrl === 'string' ? body.directoryUrl.trim() : '')
      : catalogEntry[environment];
    if (!directoryUrl) throw new AppError(400, '该 CA 不支持所选环境', 'INVALID_ACME_ENVIRONMENT');
    if (environment === 'production' && body.confirmProduction !== true) {
      throw new AppError(400, '生产 CA 需要显式确认', 'ACME_PRODUCTION_CONFIRMATION_REQUIRED');
    }
    const eabKid = typeof body.eabKid === 'string' ? body.eabKid.trim() : '';
    const eabHmac = typeof body.eabHmacKey === 'string' ? body.eabHmacKey.trim() : '';
    if ((eabKid === '') !== (eabHmac === '')) throw new AppError(400, 'EAB KID 与 HMAC Key 必须同时提供', 'INVALID_ACME_EAB');
    if (catalogEntry.eab && !eabKid) throw new AppError(400, '该 CA 需要 EAB KID 与 HMAC Key', 'ACME_EAB_REQUIRED');
    if (eabKid && (eabKid.length > 256 || !/^[A-Za-z0-9_-]{16,512}$/.test(eabHmac))) {
      throw new AppError(400, 'EAB KID 或 HMAC Key 格式无效', 'INVALID_ACME_EAB');
    }
    const idValue = randomId();
    const now = nowSeconds();
    const keyCipher = await encrypt(createAcmeAccountKey(), c.env.APP_KEY, `cert-acme-account/${idValue}/key`);
    const eabCipher = eabHmac ? await encrypt(eabHmac, c.env.APP_KEY, `cert-acme-account/${idValue}/eab`) : null;
    await c.get('db').batch([
      {
        sql: `INSERT INTO cert_acme_accounts
          (id,directory,directory_url,email,account_key_cipher,status,created_by,created_at,updated_at,ca,eab_kid,eab_hmac_cipher)
          VALUES (?,?,?,?,?,'pending_directory',?,?,?,?,?,?)`,
        args: [idValue, environment, directoryUrl, email, keyCipher, c.get('principal').user.id, now, now,
          ca, eabKid || null, eabCipher],
      },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
        args: [c.get('principal').user.id, 'cert.acme.account.create', String(idValue), `${ca} ${environment} ACME account`, now],
      },
    ]);
    return c.json({ code: 0, id: idValue, ca, environment, status: 'pending_directory' });
  });

  routes.post('/api/v1/cert/acme/accounts/:id/directory', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const accountId = id(c.req.param('id'), 'ACME 账户');
    const account = await accountById(c, accountId);
    if (account.status === 'disabled') throw new AppError(409, 'ACME 账户已停用', 'ACME_ACCOUNT_DISABLED');
    if (account.claimed_nonce && (account.claimed_at ?? 0) > nowSeconds() - 60) {
      throw new AppError(409, 'ACME 账户请求仍在处理中，暂不能更改 Directory', 'ACME_REQUEST_IN_FLIGHT');
    }
    const loaded = await loadAcmeDirectory(c.env.BUDGET.fetch, account.directory_url);
    const directoryJson = JSON.stringify(loaded);
    const result = await c.get('db').execute(
      `UPDATE cert_acme_accounts SET directory_json=?,status=CASE WHEN kid IS NULL THEN 'pending_registration' ELSE status END,updated_at=?
       WHERE id=? AND (claimed_at IS NULL OR claimed_at<=?)`,
      [directoryJson, nowSeconds(), accountId, nowSeconds() - 60],
    );
    requireAffected(result.changes, 'ACME_DIRECTORY_SAVE_FAILED');
    return c.json({ code: 0, id: accountId, status: account.kid ? account.status : 'pending_registration', termsOfService: loaded.meta?.termsOfService ?? null });
  });

  routes.post('/api/v1/cert/acme/accounts/:id/prepare-nonce', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const accountId = id(c.req.param('id'), 'ACME 账户');
    const account = await accountById(c, accountId);
    const currentTime = nowSeconds();
    if (account.claimed_nonce !== null && (account.claimed_at ?? 0) > currentTime - 60) {
      throw new AppError(409, 'ACME 账户请求仍在处理中，暂不能刷新 nonce', 'ACME_REQUEST_IN_FLIGHT');
    }
    const loaded = await readDirectory(account);
    const nonce = await fetchAcmeNonce(c.env.BUDGET.fetch, account.directory, loaded.newNonce);
    const result = await c.get('db').execute(
      `UPDATE cert_acme_accounts SET replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,
        status=CASE WHEN status='registration_unknown' THEN 'pending_registration' ELSE status END,updated_at=?
        WHERE id=? AND status IN ('pending_registration','registration_unknown','ready') AND (claimed_at IS NULL OR claimed_at<=?)`,
      [nonce, currentTime, accountId, currentTime - 60],
    );
    requireAffected(result.changes, 'ACME_NONCE_SAVE_FAILED');
    return c.json({ code: 0, id: accountId, nonceReady: true });
  });

  routes.post('/api/v1/cert/acme/accounts/:id/register', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const accountId = id(c.req.param('id'), 'ACME 账户');
    const body = await input(c);
    if (body.agreeToTerms !== true) throw new AppError(400, '必须先同意 CA 服务条款', 'ACME_TERMS_NOT_ACCEPTED');
    const account = await reserveAccountNonce(c, accountId, 'pending_registration', 'registration_unknown');
    if (account.kid !== null) {
      await releaseAccountNonce(c, accountId, account.claimed_nonce!, account.claimed_nonce, 'ready');
      throw new AppError(409, 'ACME 账户已注册', 'ACME_ACCOUNT_ALREADY_REGISTERED');
    }
    const apiDirectory = await readDirectory(account);
    let accountKey: string;
    try { accountKey = await decrypt(account.account_key_cipher, c.env.APP_KEY, `cert-acme-account/${accountId}/key`); }
    catch { throw new AppError(503, 'ACME 账户密钥无法解密', 'ACME_ACCOUNT_KEY_UNAVAILABLE'); }
    let response: AcmeJwsResponse;
    try {
      const eab = account.eab_kid && account.eab_hmac_cipher
        ? await externalAccountBinding(
          accountKey, account.eab_kid,
          await decrypt(account.eab_hmac_cipher, c.env.APP_KEY, `cert-acme-account/${accountId}/eab`),
          apiDirectory.newAccount,
        )
        : undefined;
      response = await postAcmeJws(c.env.BUDGET.fetch, {
        environment: account.directory, origin: acmeOrigin(account), privateKeyPem: accountKey, nonce: account.claimed_nonce!,
        url: apiDirectory.newAccount,
        payload: { termsOfServiceAgreed: true, contact: [`mailto:${account.email}`], ...(eab ? { externalAccountBinding: eab } : {}) },
      });
    } catch (error) {
      if (error instanceof AcmeProtocolError) {
        const notFound = error.problemType?.includes('accountDoesNotExist') === true;
        const badNonce = error.problemType?.includes('badNonce') === true;
        const retryable = notFound || badNonce || error.status === 429;
        await releaseAccountNonce(c, accountId, account.claimed_nonce!, error.replayNonce, retryable ? 'pending_registration' : 'registration_unknown');
        if (notFound || badNonce || error.status === 429) handleAcmeError(error);
      } else {
        await releaseAccountNonce(c, accountId, account.claimed_nonce!, null, 'registration_unknown');
      }
      handleAcmeError(error);
    }
    if (!response.location) {
      await releaseAccountNonce(c, accountId, account.claimed_nonce!, validateRemoteNonce(response), 'registration_unknown');
      throw new AppError(503, 'CA 未返回账户标识，结果未知；请执行账户核对', 'ACME_ACCOUNT_OUTCOME_UNKNOWN');
    }
    let kid: string;
    try { kid = validateAcmeUrlFrom(acmeOrigin(account), response.location); }
    catch {
      await releaseAccountNonce(c, accountId, account.claimed_nonce!, validateRemoteNonce(response), 'registration_unknown');
      throw new AppError(503, 'CA 返回的账户地址无效，结果未知；请执行账户核对', 'ACME_ACCOUNT_OUTCOME_UNKNOWN');
    }
    const registration = await c.get('db').batch([
      {
        sql: `UPDATE cert_acme_accounts SET kid=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,status='ready',updated_at=? WHERE id=? AND status='registration_unknown'`,
        args: [kid, validateRemoteNonce(response), nowSeconds(), accountId],
      },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
        args: [c.get('principal').user.id, 'cert.acme.account.register', String(accountId), `${account.directory} account registered`, nowSeconds()],
      },
    ]);
    requireAffected(registration[0]?.changes ?? 0, 'ACME_ACCOUNT_REGISTER_SAVE_FAILED');
    return c.json({ code: 0, id: accountId, environment: account.directory, status: 'ready', nonceReady: response.replayNonce !== null });
  });

  routes.get('/api/v1/cert/acme/orders', requireCertificateSession, async (c) => {
    requireAdmin(c);
    const rows = await c.get('db').query<IssuanceRow>(
      `SELECT id,directory,ca,status,domains_json,authorization_state_json,cert_order_id,last_error,remote_order_url,replay_nonce,claimed_nonce,claimed_at,created_at,updated_at
       FROM cert_acme_orders ORDER BY created_at DESC,id DESC LIMIT 100`,
    );
    return c.json({ code: 0, items: rows.map(outputOrder) });
  });

  routes.post('/api/v1/cert/acme/accounts/:id/recover-registration', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const accountId = id(c.req.param('id'), 'ACME 账户');
    const account = await reserveAccountNonce(c, accountId, 'registration_unknown');
    const apiDirectory = await readDirectory(account);
    let accountKey: string;
    try { accountKey = await decrypt(account.account_key_cipher, c.env.APP_KEY, `cert-acme-account/${accountId}/key`); }
    catch { throw new AppError(503, 'ACME 账户密钥无法解密', 'ACME_ACCOUNT_KEY_UNAVAILABLE'); }
    let response: AcmeJwsResponse;
    try {
      response = await postAcmeJws(c.env.BUDGET.fetch, {
        environment: account.directory, origin: acmeOrigin(account), privateKeyPem: accountKey, nonce: account.claimed_nonce!,
        url: apiDirectory.newAccount, payload: { onlyReturnExisting: true },
      });
    } catch (error) {
      if (error instanceof AcmeProtocolError) {
        const notFound = error.problemType?.includes('accountDoesNotExist') === true;
        await c.get('db').execute(
          `UPDATE cert_acme_accounts SET replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,status=?,updated_at=?
           WHERE id=? AND status='registration_unknown'`,
          [error.replayNonce, notFound ? 'pending_registration' : 'registration_unknown', nowSeconds(), accountId],
        );
        if (notFound) return c.json({ code: 0, id: accountId, status: 'pending_registration', nonceReady: error.replayNonce !== null });
      }
      handleAcmeError(error);
    }
    if (!response.location) throw new AppError(503, 'CA 未返回已注册账户标识，结果仍未知', 'ACME_ACCOUNT_OUTCOME_UNKNOWN');
    const kid = validateAcmeUrlFrom(acmeOrigin(account), response.location);
    const now = nowSeconds();
    const results = await c.get('db').batch([
      {
        sql: `UPDATE cert_acme_accounts SET kid=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,status='ready',updated_at=?
          WHERE id=? AND status='registration_unknown'`,
        args: [kid, validateRemoteNonce(response), now, accountId],
      },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
        args: [c.get('principal').user.id, 'cert.acme.account.recover', String(accountId), `${account.directory} account registration reconciled`, now],
      },
    ]);
    requireAffected(results[0]?.changes ?? 0, 'ACME_ACCOUNT_RECOVERY_FAILED');
    return c.json({ code: 0, id: accountId, environment: account.directory, status: 'ready', nonceReady: response.replayNonce !== null });
  });

  routes.post('/api/v1/cert/acme/orders', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const accountId = id(body.accountId, 'ACME 账户');
    const dnsDomainId = id(body.dnsDomainId, 'DNS 域名');
    const domains = normalizeCertificateDomains(body.domains);
    const matches = await c.get('db').query<AccountRow & {
      acme_id: number; acme_directory: AcmeEnvironment; acme_directory_json: string; acme_kid: string;
      acme_key_cipher: string; acme_status: string; acme_replay_nonce: string | null; acme_claimed_nonce: string | null;
      acme_ca: string;
      dns_id: number; dns_name: string; dns_third_id: string; dns_account_id: number; dns_type: string; dns_config_cipher: string;
    }>(
      `SELECT ca.id AS acme_id,ca.directory AS acme_directory,ca.directory_json AS acme_directory_json,
        ca.kid AS acme_kid,ca.account_key_cipher AS acme_key_cipher,ca.status AS acme_status,
        ca.replay_nonce AS acme_replay_nonce,ca.claimed_nonce AS acme_claimed_nonce,ca.ca AS acme_ca,
        d.id AS dns_id,d.name AS dns_name,d.third_id AS dns_third_id,d.account_id AS dns_account_id,
        da.type AS dns_type,da.config_cipher AS dns_config_cipher
       FROM cert_acme_accounts ca JOIN dns_domains d ON d.id=? JOIN dns_accounts da ON da.id=d.account_id
       WHERE ca.id=?`, [dnsDomainId, accountId],
    );
    const source = matches[0];
    if (!source || source.acme_status !== 'ready' || !source.acme_directory_json || !source.acme_kid) {
      throw new AppError(404, '已注册的 ACME 账户或 DNS 域名不存在', 'ACME_SOURCE_NOT_FOUND');
    }
    if (source.acme_claimed_nonce !== null || source.acme_replay_nonce === null) {
      throw new AppError(409, '请先为 ACME 账户准备新的 nonce', 'ACME_NONCE_REQUIRED');
    }
    if (!source.dns_third_id) {
      throw new AppError(400, '请选择已同步到本系统的 DNS 域名', 'ACME_DNS_ZONE_UNSYNCED');
    }
    const challenge = await resolveChallengeZone(c, {
      id: source.dns_id, name: source.dns_name, remoteId: source.dns_third_id,
      accountId: source.dns_account_id, type: source.dns_type, configCipher: source.dns_config_cipher,
    }, domains);
    const idValue = randomId();
    const claimed = await c.get('db').execute(
      `UPDATE cert_acme_accounts SET claimed_nonce=replay_nonce,replay_nonce=NULL,claimed_at=?,updated_at=?
       WHERE id=? AND status='ready' AND replay_nonce IS NOT NULL AND claimed_nonce IS NULL
        AND (claimed_at IS NULL OR claimed_at<=?) RETURNING replay_nonce,claimed_nonce`,
      [nowSeconds(), nowSeconds(), accountId, nowSeconds() - 60],
    );
    const accountNonce = claimed.rows[0] as { replay_nonce: string | null; claimed_nonce: string } | undefined;
    if (!accountNonce) throw new AppError(409, 'ACME 账户正在处理另一项请求或需重新准备 nonce', 'ACME_NONCE_REQUIRED');
    let generated: ReturnType<typeof createCertificateKeyAndCsr>;
    let privateKeyCipher: string;
    let now: number;
    try {
      generated = createCertificateKeyAndCsr(domains);
      privateKeyCipher = await encrypt(generated.privateKey, c.env.APP_KEY, `cert-acme-order/${idValue}/private-key`);
      now = nowSeconds();
    } catch (error) {
      await releaseAccountNonce(c, accountId, accountNonce.claimed_nonce, accountNonce.claimed_nonce);
      throw error;
    }
    const insertedOrder = await c.get('db').batch([
      {
        sql: `INSERT INTO cert_acme_orders
          (id,account_id,dns_domain_id,dns_account_id,dns_config_cipher,dns_zone_name,dns_zone_remote_id,
           created_by,directory,directory_json,account_kid,account_key_cipher,replay_nonce,claimed_nonce,claimed_at,domains_json,
           challenge_map_json,authorization_state_json,authorization_index,status,csr_der,private_key_cipher,created_at,updated_at,ca)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',0,'draft',?,?,?,?,?)`,
        args: [idValue, source.acme_id, challenge.zone.id, challenge.zone.accountId, challenge.zone.configCipher,
          challenge.zone.name, challenge.zone.remoteId, c.get('principal').user.id, source.acme_directory,
          source.acme_directory_json, source.acme_kid, source.acme_key_cipher, accountNonce.claimed_nonce, null, null, JSON.stringify(domains),
          JSON.stringify(challenge.map), generated.csrDer, privateKeyCipher, now, now, source.acme_ca],
      },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
        args: [c.get('principal').user.id, 'cert.acme.order.create', String(idValue),
          `${source.acme_directory} DNS-01 order · ${domains.length} identifiers · zone ${challenge.zone.name}`, now],
      },
      {
        sql: `UPDATE cert_acme_accounts SET claimed_nonce=NULL,claimed_at=NULL,updated_at=?
          WHERE id=? AND status='ready' AND claimed_nonce=?`,
        args: [now, accountId, accountNonce.claimed_nonce],
      },
    ]);
    requireAffected(insertedOrder[0]?.changes ?? 0, 'ACME_ORDER_CREATE_FAILED');
    requireAffected(insertedOrder[2]?.changes ?? 0, 'ACME_ACCOUNT_NONCE_RELEASE_FAILED');
    return c.json({ code: 0, id: idValue, environment: source.acme_directory, status: 'draft', domains, nonceReady: true });
  });

  routes.post('/api/v1/cert/acme/orders/:id/prepare-nonce', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const orderId = id(c.req.param('id'), '签发任务');
    const row = await issuanceById(c, orderId);
    if (['issued','failed','cancelled'].includes(row.status)) throw new AppError(409, '当前签发任务不能继续', 'ACME_ORDER_TERMINAL');
    const nonce = await fetchAcmeNonce(c.env.BUDGET.fetch, row.directory, directory(row).newNonce);
    const now = nowSeconds();
    const savedOrder = await c.get('db').execute(
      'UPDATE cert_acme_orders SET replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status=? AND (claimed_at IS NULL OR claimed_at<=?)',
      [nonce, now, orderId, row.status, now - 60],
    );
    requireAffected(savedOrder.changes, 'ACME_NONCE_SAVE_FAILED');
    return c.json({ code: 0, id: orderId, nonceReady: true });
  });

  routes.post('/api/v1/cert/acme/orders/:id/place', requireCertificateSession, requireCsrf, stepPlaceOrder);

  routes.post('/api/v1/cert/acme/orders/:id/authorize', requireCertificateSession, requireCsrf, stepAuthorize);

  routes.post('/api/v1/cert/acme/orders/:id/add-dns', requireCertificateSession, requireCsrf, stepAddDns);

  routes.post('/api/v1/cert/acme/orders/:id/reconcile-dns', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const orderId = id(c.req.param('id'), '签发任务');
    const row = await issuanceById(c, orderId);
    const staleDnsAction = ['dns_adding','dns_cleaning'].includes(row.status) && row.updated_at <= nowSeconds() - 60;
    if (row.status !== 'dns_outcome_unknown' && !staleDnsAction) {
      throw new AppError(409, '订单没有可核对的 DNS challenge；活动写操作需先完成或超时', 'ACME_DNS_RECONCILE_NOT_AVAILABLE');
    }
    const reconcileClaim = await c.get('db').execute(
      `UPDATE cert_acme_orders SET status=CASE WHEN last_error='DNS_CHALLENGE_DELETE_OUTCOME_UNKNOWN' OR status='dns_cleaning' THEN 'dns_cleaning' ELSE 'dns_adding' END,updated_at=?
       WHERE id=? AND status=? AND updated_at=? RETURNING id`, [nowSeconds(), orderId, row.status, row.updated_at],
    );
    if (!reconcileClaim.rows[0]) throw new AppError(409, 'DNS challenge 核对已被其他请求领取', 'ACME_DNS_RECONCILE_IN_FLIGHT');
    const { states, state } = activeAuthorization(row);
    const cleanupUnknown = row.status === 'dns_cleaning' || row.last_error === 'DNS_CHALLENGE_DELETE_OUTCOME_UNKNOWN';
    if (!state.txtName || !state.txtValue) throw new AppError(503, 'DNS challenge 状态损坏', 'ACME_STATE_CORRUPT');
    let config: Record<string, string>;
    try { config = JSON.parse(await decrypt(row.dns_config_cipher, c.env.APP_KEY, `dns-account/${row.dns_account_id}`)) as Record<string, string>; }
    catch { throw new AppError(503, 'DNS 账户凭据不可用', 'DNS_ACCOUNT_CONFIG_UNAVAILABLE'); }
    const provider = createProvider(row.dns_type, config, c.env.BUDGET.fetch);
    const zone: DnsDomain = { id: row.dns_zone_remote_id, name: row.dns_zone_name, recordCount: 0 };
    const records = await provider.listRecords(zone, { page: 1, pageSize: 100, type: 'TXT', name: relativeTxtName(state.txtName, row.dns_zone_name) });
    const found = records.items.find((record) => record.type === 'TXT' && normalizeTxtValue(record.value) === state.txtValue);
    const allowedStatuses = "('dns_outcome_unknown','dns_adding','dns_cleaning')";
    if (cleanupUnknown) {
      if (found) {
        states[row.authorization_index] = { ...state, dnsRecordId: found.id, challengeStatus: 'valid' };
        await updateOrder(c, orderId, 'reconcile-dns',
          `UPDATE cert_acme_orders SET status='authorization_valid',authorization_state_json=?,last_error=NULL,updated_at=? WHERE id=? AND status IN ${allowedStatuses}`,
          [JSON.stringify(states), nowSeconds(), orderId]);
        return c.json({ code: 0, id: orderId, status: 'authorization_valid', found: true, cleanupRequired: true });
      }
      states[row.authorization_index] = { ...state, dnsRecordId: undefined, challengeStatus: 'valid' };
      const nextIndex = row.authorization_index + 1;
      const nextStatus = nextAuthorizationStatus(states, nextIndex, domainsFrom(row));
      await updateOrder(c, orderId, 'reconcile-dns',
        `UPDATE cert_acme_orders SET status=?,authorization_index=?,authorization_state_json=?,last_error=NULL,updated_at=? WHERE id=? AND status IN ${allowedStatuses}`,
        [nextStatus, nextIndex, JSON.stringify(states), nowSeconds(), orderId]);
      return c.json({ code: 0, id: orderId, status: nextStatus, found: false, cleanupComplete: true });
    }
    if (found) {
      states[row.authorization_index] = { ...state, dnsRecordId: found.id, challengeStatus: 'present' };
      await updateOrder(c, orderId, 'reconcile-dns',
        `UPDATE cert_acme_orders SET status='dns_present',authorization_state_json=?,last_error=NULL,updated_at=? WHERE id=? AND status IN ${allowedStatuses}`,
        [JSON.stringify(states), nowSeconds(), orderId]);
      return c.json({ code: 0, id: orderId, status: 'dns_present', found: true });
    }
    states[row.authorization_index] = { ...state, challengeStatus: 'ready' };
    await updateOrder(c, orderId, 'reconcile-dns',
      `UPDATE cert_acme_orders SET status='challenge_ready',authorization_state_json=?,last_error=NULL,updated_at=? WHERE id=? AND status IN ${allowedStatuses}`,
      [JSON.stringify(states), nowSeconds(), orderId]);
    return c.json({ code: 0, id: orderId, status: 'challenge_ready', found: false });
  });

  routes.post('/api/v1/cert/acme/orders/:id/trigger', requireCertificateSession, requireCsrf, stepTrigger);

  routes.post('/api/v1/cert/acme/orders/:id/poll-authorization', requireCertificateSession, requireCsrf, stepPollAuthorization);

  routes.post('/api/v1/cert/acme/orders/:id/cleanup-dns', requireCertificateSession, requireCsrf, stepCleanupDns);

  routes.post('/api/v1/cert/acme/orders/:id/finalize', requireCertificateSession, requireCsrf, stepFinalize);

  routes.post('/api/v1/cert/acme/orders/:id/poll-order', requireCertificateSession, requireCsrf, stepPollOrder);

  routes.post('/api/v1/cert/acme/orders/:id/fetch-certificate', requireCertificateSession, requireCsrf, stepFetchCertificate);


  routes.post('/api/v1/cert/acme/orders/:id/cancel', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const orderId = id(c.req.param('id'), '签发任务');
    const rows = await c.get('db').query<{ id: number; status: string; authorization_state_json: string }>(
      'SELECT id,status,authorization_state_json FROM cert_acme_orders WHERE id=?', [orderId],
    );
    const row = rows[0];
    if (!row || !['draft','outcome_unknown','failed'].includes(row.status)) {
      throw new AppError(409, '该状态不能本地取消；CA 侧订单可能仍然存在', 'ACME_CANCEL_NOT_AVAILABLE');
    }
    if (authorizationStates(row.authorization_state_json).some((state) => Boolean(state.dnsRecordId))) {
      throw new AppError(409, '请先清理 DNS challenge TXT 记录，再取消本地任务', 'ACME_DNS_CLEANUP_REQUIRED');
    }
    const now = nowSeconds();
    const result = await c.get('db').batch([
      {
        sql: `UPDATE cert_acme_orders SET status='cancelled',replay_nonce=NULL,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=?
          WHERE id=? AND status IN ('draft','outcome_unknown','failed')`, 
        args: ['CANCELLED_BY_ADMIN', now, orderId],
      },
      {
        sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
        args: [c.get('principal').user.id, 'cert.acme.order.cancel', String(orderId), 'local issuance job cancelled; remote order may remain', now],
      },
    ]);
    requireAffected(result[0]?.changes ?? 0, 'ACME_CANCEL_NOT_AVAILABLE');
    return c.json({ code: 0, id: orderId, status: 'cancelled' });
  });

  return routes;
}

export async function stepPlaceOrder(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const reserved = await reserveOrderNonce(c, orderId, ['draft'], 'placing');
  const domains = domainsFrom(reserved);
  let response: AcmeJwsResponse;
  try {
    response = await signedPost(c, reserved, directory(reserved).newOrder, {
      identifiers: domains.map((value) => ({ type: 'dns', value })),
    });
  } catch (error) {
    const mapped = acmeFailure(error);
    const rejected = error instanceof AcmeProtocolError && error.status < 500;
    const retryable = error instanceof AcmeProtocolError && (error.problemType?.includes('badNonce') === true || error.status === 429);
    const state = retryable ? 'draft' : rejected ? 'failed' : 'outcome_unknown';
    const nonce = error instanceof AcmeProtocolError ? error.replayNonce : null;
    await c.get('db').execute(
      'UPDATE cert_acme_orders SET status=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status=\'placing\'',
      [state, nonce, mapped.reason, nowSeconds(), orderId],
    );
    throw retryable || rejected ? mapped : new AppError(503, 'CA 订单提交结果未知；请核对 CA 账户后再决定下一步', 'ACME_OUTCOME_UNKNOWN');
  }
  const location = response.location;
  let payload: Record<string, unknown>;
  try { payload = jsonObject(response.body, 'ACME_ORDER_RESPONSE_INVALID'); }
  catch {
    await c.get('db').execute(`UPDATE cert_acme_orders SET status='outcome_unknown',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='placing'`, [validateRemoteNonce(response), 'ACME_ORDER_RESPONSE_INVALID', nowSeconds(), orderId]);
    throw new AppError(503, 'CA 订单响应无效；请核对 CA 订单', 'ACME_OUTCOME_UNKNOWN');
  }
  if (!location || !Array.isArray(payload.authorizations) || typeof payload.finalize !== 'string') {
    await c.get('db').execute('UPDATE cert_acme_orders SET status=\'outcome_unknown\',replay_nonce=NULL,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=?', ['ACME_ORDER_RESPONSE_INVALID', nowSeconds(), orderId]);
    throw new AppError(503, 'CA 订单响应不完整；请核对 CA 账户后再决定下一步', 'ACME_OUTCOME_UNKNOWN');
  }
  const apiDirectory = directory(reserved);
  let remoteOrderUrl: string;
  let finalizeUrl: string;
  let authorizations: { url: string; status: 'pending' }[];
  try {
    remoteOrderUrl = validateAcmeUrlFrom(acmeOrigin(reserved), location);
    finalizeUrl = validateAcmeUrlFrom(acmeOrigin(reserved), payload.finalize);
    authorizations = payload.authorizations.map((value) => ({
      url: validateAcmeUrlFrom(acmeOrigin(reserved), String(value)), status: 'pending' as const,
    }));
  } catch {
    await c.get('db').execute(`UPDATE cert_acme_orders SET status='outcome_unknown',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='placing'`, [validateRemoteNonce(response), 'ACME_ORDER_URL_REJECTED', nowSeconds(), orderId]);
    throw new AppError(503, 'CA 订单返回的 URL 无效；请核对 CA 订单', 'ACME_OUTCOME_UNKNOWN');
  }
  if (authorizations.length !== domains.length) {
    await c.get('db').execute(
      `UPDATE cert_acme_orders SET status='outcome_unknown',replay_nonce=NULL,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='placing'`,
      ['ACME_AUTHORIZATION_COUNT_MISMATCH', nowSeconds(), orderId],
    );
    throw new AppError(503, 'CA 返回的授权数量与请求域名不符；请核对 CA 订单', 'ACME_OUTCOME_UNKNOWN');
  }
  const uniqueAuthorizationUrls = new Set(authorizations.map((authorization) => authorization.url));
  if (uniqueAuthorizationUrls.size !== authorizations.length) {
    await c.get('db').execute(
      `UPDATE cert_acme_orders SET status='outcome_unknown',replay_nonce=NULL,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='placing'`,
      ['ACME_AUTHORIZATION_DUPLICATE', nowSeconds(), orderId],
    );
    throw new AppError(503, 'CA 返回重复授权；请核对 CA 订单', 'ACME_OUTCOME_UNKNOWN');
  }
  if (new Set(domains).size !== domains.length) throw new AppError(400, '证书域名不能重复', 'INVALID_CERT_DOMAINS');
  const states = 'authorizations' in payload ? JSON.stringify(authorizations) : '[]';
  const result = await c.get('db').batch([
    {
      sql: `UPDATE cert_acme_orders SET status='authorizing',remote_order_url=?,finalize_url=?,
        authorization_state_json=?,authorization_index=0,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status='placing'`,
      args: [remoteOrderUrl, finalizeUrl, states, validateRemoteNonce(response), nowSeconds(), orderId],
    },
    {
      sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
      args: [c.get('principal').user.id, 'cert.acme.order.placed', String(orderId), `${domains.length} ACME authorizations`, nowSeconds()],
    },
  ]);
  requireAffected(result[0]?.changes ?? 0, 'ACME_ORDER_SAVE_FAILED');
  return c.json({ code: 0, id: orderId, status: 'authorizing', authorizationCount: authorizations.length,
    nonceReady: response.replayNonce !== null, termsOfService: apiDirectory.meta?.termsOfService ?? null });
}

export async function stepAuthorize(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const reserved = await reserveOrderNonce(c, orderId, ['authorizing']);
  const { states, state } = activeAuthorization(reserved);
  let response: AcmeJwsResponse;
  try { response = await signedPost(c, reserved, state.url, ''); }
  catch (error) { handleAcmeError(error); }
  const authz = jsonObject(response.body, 'ACME_AUTHORIZATION_RESPONSE_INVALID');
  const identifier = jsonObject(authz.identifier, 'ACME_AUTHORIZATION_RESPONSE_INVALID');
  if (identifier.type !== 'dns' || typeof identifier.value !== 'string') {
    await updateOrder(c, orderId, 'authorize',
      `UPDATE cert_acme_orders SET status='failed',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='authorizing'`,
      [validateRemoteNonce(response), 'ACME_AUTHORIZATION_INVALID', nowSeconds(), orderId]);
    throw new AppError(502, 'CA 授权标识无效', 'ACME_AUTHORIZATION_INVALID');
  }
  const wildcard = authz.wildcard === true;
  const domains = domainsFrom(reserved);
  const expectedDomain = domains[reserved.authorization_index];
  if (!expectedDomain || wildcard !== expectedDomain.startsWith('*.')) {
    await updateOrder(c, orderId, 'authorize',
      `UPDATE cert_acme_orders SET status='failed',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='authorizing'`,
      [validateRemoteNonce(response), 'ACME_AUTHORIZATION_MISMATCH', nowSeconds(), orderId]);
    throw new AppError(502, 'CA 返回的 wildcard authorization 与请求不符', 'ACME_AUTHORIZATION_MISMATCH');
  }
  const authorizedName = `${wildcard ? '*.' : ''}${identifier.value.toLowerCase().replace(/\.$/, '')}`;
  if (authorizedName !== expectedDomain || !domains.includes(authorizedName)) {
    await updateOrder(c, orderId, 'authorize',
      `UPDATE cert_acme_orders SET status='failed',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='authorizing'`,
      [validateRemoteNonce(response), 'ACME_AUTHORIZATION_MISMATCH', nowSeconds(), orderId]);
    throw new AppError(502, 'CA 返回了请求列表之外或次序不匹配的授权', 'ACME_AUTHORIZATION_MISMATCH');
  }
  if (authz.status === 'valid') {
    states[reserved.authorization_index] = { ...state, status: 'valid', identifier: authorizedName, wildcard };
    const index = reserved.authorization_index + 1;
    const status = nextAuthorizationStatus(states, index, domainsFrom(reserved));
    await updateOrder(c, orderId, 'authorize',
      `UPDATE cert_acme_orders SET authorization_state_json=?,authorization_index=?,status=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status='authorizing'`,
      [JSON.stringify(states), index, status, validateRemoteNonce(response), nowSeconds(), orderId]);
    return c.json({ code: 0, id: orderId, status, authorization: 'valid', nonceReady: response.replayNonce !== null });
  }
  if (authz.status !== 'pending' && authz.status !== 'processing') {
    await updateOrder(c, orderId, 'authorize',
      `UPDATE cert_acme_orders SET status='failed',last_error=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status='authorizing'`,
      ['ACME_AUTHORIZATION_FAILED', validateRemoteNonce(response), nowSeconds(), orderId]);
    throw new AppError(502, 'CA 授权失败', 'ACME_AUTHORIZATION_FAILED');
  }
  if (wildcard && !authorizedName.startsWith('*.')) throw new AppError(502, '通配符授权响应无效', 'ACME_AUTHORIZATION_INVALID');
  const challengeList = Array.isArray(authz.challenges) ? authz.challenges : [];
  const challenge = challengeList.map((entry) => jsonObject(entry, 'ACME_CHALLENGE_INVALID')).find((entry) => entry.type === 'dns-01');
  if (!challenge || typeof challenge.url !== 'string' || typeof challenge.token !== 'string') {
    await updateOrder(c, orderId, 'authorize',
      `UPDATE cert_acme_orders SET status='failed',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='authorizing'`,
      [validateRemoteNonce(response), 'ACME_DNS_CHALLENGE_UNAVAILABLE', nowSeconds(), orderId]);
    throw new AppError(501, '该 CA 授权未提供 DNS-01 challenge', 'ACME_DNS_CHALLENGE_UNAVAILABLE');
  }
  const domain = String(identifier.value).toLowerCase().replace(/\.$/, '');
  const txtName = challengeMapFrom(reserved)[domain] ?? `_acme-challenge.${domain}`;
  if (!coversZone(txtName, reserved.dns_zone_name)) {
    await updateOrder(c, orderId, 'authorize',
      `UPDATE cert_acme_orders SET status='failed',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='authorizing'`,
      [validateRemoteNonce(response), 'ACME_DNS_ZONE_MISMATCH', nowSeconds(), orderId]);
    throw new AppError(400, 'DNS challenge 超出关联的 DNS Zone', 'ACME_DNS_ZONE_MISMATCH');
  }
  const txtValue = await dns01Value(await decrypt(reserved.account_key_cipher, c.env.APP_KEY, `cert-acme-account/${reserved.account_id}/key`), challenge.token);
  states[reserved.authorization_index] = {
    ...state, status: 'pending', identifier: authorizedName, wildcard,
    challengeUrl: validateAcmeUrlFrom(acmeOrigin(reserved), challenge.url), txtName, txtValue, challengeStatus: 'ready',
  };
  await updateOrder(c, orderId, 'authorize',
    `UPDATE cert_acme_orders SET authorization_state_json=?,status='challenge_ready',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status='authorizing'`,
    [JSON.stringify(states), validateRemoteNonce(response), nowSeconds(), orderId]);
  return c.json({ code: 0, id: orderId, status: 'challenge_ready', authorization: authorizedName,
    txtName, nonceReady: response.replayNonce !== null });
}

export async function stepAddDns(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const row = await claimIssuance(
    c, orderId,
    `UPDATE cert_acme_orders SET status='dns_adding',updated_at=? WHERE id=? AND status='challenge_ready'`,
    '订单没有待创建的 DNS challenge', 'ACME_DNS_STEP_NOT_AVAILABLE',
  );
  const { states, state } = activeAuthorization(row);
  if (!state.txtName || !state.txtValue || !state.challengeUrl) throw new AppError(503, 'DNS challenge 状态损坏', 'ACME_STATE_CORRUPT');
  let config: Record<string, string>;
  try { config = JSON.parse(await decrypt(row.dns_config_cipher, c.env.APP_KEY, `dns-account/${row.dns_account_id}`)) as Record<string, string>; }
  catch { await c.get('db').execute('UPDATE cert_acme_orders SET status=\'failed\',last_error=?,updated_at=? WHERE id=?', ['DNS_ACCOUNT_CONFIG_UNAVAILABLE', nowSeconds(), orderId]); throw new AppError(503, 'DNS 账户凭据不可用', 'DNS_ACCOUNT_CONFIG_UNAVAILABLE'); }
  const provider = createProvider(row.dns_type, config, c.env.BUDGET.fetch);
  const zone: DnsDomain = { id: row.dns_zone_remote_id, name: row.dns_zone_name, recordCount: 0 };
  const name = relativeTxtName(state.txtName, row.dns_zone_name);
  const record: DnsRecordInput = { name, type: 'TXT', value: state.txtValue, line: '0', ttl: 120, mx: null, weight: null, remark: null };
  let recordId: string;
  try {
    recordId = await provider.addRecord(zone, record);
    if (!recordId.trim()) throw new Error('Missing remote record ID');
  } catch {
    states[row.authorization_index] = { ...state, challengeStatus: 'unknown' };
    await c.get('db').execute(
      `UPDATE cert_acme_orders SET status='dns_outcome_unknown',authorization_state_json=?,replay_nonce=NULL,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='dns_adding'`,
      [JSON.stringify(states), 'DNS_CHALLENGE_CREATE_OUTCOME_UNKNOWN', nowSeconds(), orderId],
    );
    throw new AppError(503, 'DNS challenge 创建结果未知；请先核对 DNS 服务商记录，勿直接重试', 'ACME_DNS_OUTCOME_UNKNOWN');
  }
  states[row.authorization_index] = { ...state, dnsRecordId: recordId, challengeStatus: 'present' };
  const audit = await c.get('db').batch([
    {
      sql: `UPDATE cert_acme_orders SET status='dns_present',authorization_state_json=?,last_error=NULL,updated_at=? WHERE id=? AND status='dns_adding'`,
      args: [JSON.stringify(states), nowSeconds(), orderId],
    },
    {
      sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
      args: [c.get('principal').user.id, 'cert.acme.dns.create', String(orderId), `TXT challenge ${state.identifier ?? ''}`.slice(0, 255), nowSeconds()],
    },
  ]);
  requireAffected(audit[0]?.changes ?? 0, 'ACME_DNS_STATE_SAVE_FAILED');
  return c.json({ code: 0, id: orderId, status: 'dns_present', authorization: state.identifier });
}

export async function stepTrigger(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const row = await reserveOrderNonce(c, orderId, ['dns_present'], 'triggering');
  const { states, state } = activeAuthorization(row);
  if (!state.challengeUrl) throw new AppError(503, 'ACME challenge URL 不存在', 'ACME_STATE_CORRUPT');
  let response: AcmeJwsResponse;
  try { response = await signedPost(c, row, state.challengeUrl, {}); }
  catch (error) {
    await c.get('db').execute(
      `UPDATE cert_acme_orders SET status='trigger_unknown',replay_nonce=NULL,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='triggering'`,
      ['ACME_CHALLENGE_TRIGGER_OUTCOME_UNKNOWN', nowSeconds(), orderId],
    );
    throw new AppError(503, 'CA challenge 触发结果未知；请轮询授权状态，不要重复触发', 'ACME_OUTCOME_UNKNOWN');
  }
  states[row.authorization_index] = { ...state, challengeStatus: 'submitted' };
  await updateOrder(c, orderId, 'trigger',
    `UPDATE cert_acme_orders SET status='submitted',authorization_state_json=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='triggering'`,
    [JSON.stringify(states), validateRemoteNonce(response), nowSeconds(), orderId]);
  return c.json({ code: 0, id: orderId, status: 'submitted', nonceReady: response.replayNonce !== null });
}

export async function stepPollAuthorization(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const row = await reserveOrderNonce(c, orderId, ['submitted','trigger_unknown','triggering']);
  const { states, state } = activeAuthorization(row);
  let response: AcmeJwsResponse;
  try { response = await signedPost(c, row, state.url, ''); }
  catch (error) { handleAcmeError(error); }
  const authz = jsonObject(response.body, 'ACME_AUTHORIZATION_RESPONSE_INVALID');
  if (authz.status === 'valid') {
    states[row.authorization_index] = { ...state, status: 'valid', challengeStatus: 'valid' };
    await updateOrder(c, orderId, 'poll-authorization',
      `UPDATE cert_acme_orders SET status='authorization_valid',authorization_state_json=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND status IN ('submitted','trigger_unknown','triggering')`,
      [JSON.stringify(states), validateRemoteNonce(response), nowSeconds(), orderId]);
    return c.json({ code: 0, id: orderId, authorization: 'valid', status: 'authorization_valid', nonceReady: response.replayNonce !== null });
  }
  if (authz.status === 'invalid') {
    await updateOrder(c, orderId, 'poll-authorization',
      `UPDATE cert_acme_orders SET status='failed',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status IN ('submitted','trigger_unknown','triggering')`,
      [validateRemoteNonce(response), 'ACME_AUTHORIZATION_FAILED', nowSeconds(), orderId]);
    throw new AppError(502, 'CA 域名授权失败', 'ACME_AUTHORIZATION_FAILED');
  }
  await updateOrder(c, orderId, 'poll-authorization',
    `UPDATE cert_acme_orders SET status='submitted',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status IN ('submitted','trigger_unknown','triggering')`,
    [validateRemoteNonce(response), nowSeconds(), orderId]);
  return c.json({ code: 0, id: orderId, authorization: 'pending', status: 'submitted', nonceReady: response.replayNonce !== null });
}

export async function stepCleanupDns(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const row = await claimIssuance(
    c, orderId,
    `UPDATE cert_acme_orders SET status='dns_cleaning',updated_at=? WHERE id=? AND status IN ('authorization_valid','failed')`,
    '没有待清理的 DNS challenge', 'ACME_DNS_CLEANUP_NOT_AVAILABLE',
  );
  const { states, state } = activeAuthorization(row);
  if (!state.dnsRecordId) {
    await c.get('db').execute(`UPDATE cert_acme_orders SET status='failed',last_error=COALESCE(last_error,'DNS_RECORD_ID_MISSING'),updated_at=? WHERE id=? AND status='dns_cleaning'`, [nowSeconds(), orderId]);
    throw new AppError(409, 'challenge 缺少 DNS 记录编号，需人工检查记录', 'ACME_DNS_RECORD_ID_MISSING');
  }
  let config: Record<string, string>;
  try { config = JSON.parse(await decrypt(row.dns_config_cipher, c.env.APP_KEY, `dns-account/${row.dns_account_id}`)) as Record<string, string>; }
  catch { throw new AppError(503, 'DNS 账户凭据不可用', 'DNS_ACCOUNT_CONFIG_UNAVAILABLE'); }
  const provider = createProvider(row.dns_type, config, c.env.BUDGET.fetch);
  const zone: DnsDomain = { id: row.dns_zone_remote_id, name: row.dns_zone_name, recordCount: 0 };
  try { await provider.deleteRecord(zone, state.dnsRecordId); }
  catch (error) {
    if (!(error instanceof Error && 'status' in error && error.status === 404)) {
      await c.get('db').execute(
        `UPDATE cert_acme_orders SET status='dns_outcome_unknown',last_error=?,updated_at=? WHERE id=? AND status='dns_cleaning'`,
        ['DNS_CHALLENGE_DELETE_OUTCOME_UNKNOWN', nowSeconds(), orderId],
      );
      throw new AppError(503, 'challenge 删除结果未知；请先核对 DNS 服务商记录', 'ACME_DNS_OUTCOME_UNKNOWN');
    }
  }
  states[row.authorization_index] = { ...state, dnsRecordId: undefined, challengeStatus: 'valid' };
  const failedBeforeCleanup = Boolean(row.last_error);
  const nextIndex = row.authorization_index + (failedBeforeCleanup ? 0 : 1);
  const nextStatus = failedBeforeCleanup ? 'failed' : nextAuthorizationStatus(states, nextIndex, domainsFrom(row));
  const results = await c.get('db').batch([
    {
      sql: `UPDATE cert_acme_orders SET status=?,authorization_index=?,authorization_state_json=?,last_error=?,updated_at=?
        WHERE id=? AND status='dns_cleaning'`,
      args: [nextStatus, nextIndex, JSON.stringify(states), failedBeforeCleanup ? row.last_error : null, nowSeconds(), orderId],
    },
    {
      sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
      args: [c.get('principal').user.id, 'cert.acme.dns.cleanup', String(orderId), `TXT challenge removed · ${state.identifier ?? ''}`.slice(0, 255), nowSeconds()],
    },
  ]);
  requireAffected(results[0]?.changes ?? 0, 'ACME_DNS_CLEANUP_SAVE_FAILED');
  return c.json({ code: 0, id: orderId, status: nextStatus, authorizationIndex: nextIndex });
}

export async function stepFinalize(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const row = await reserveOrderNonce(c, orderId, ['ready_to_finalize'], 'finalizing');
  if (!row.finalize_url) throw new AppError(503, 'CA finalize URL 不存在', 'ACME_STATE_CORRUPT');
  let response: AcmeJwsResponse;
  try { response = await signedPost(c, row, row.finalize_url, { csr: row.csr_der }); }
  catch (error) {
    const nonce = error instanceof AcmeProtocolError ? error.replayNonce : null;
    const retryable = error instanceof AcmeProtocolError
      && (error.problemType?.includes('badNonce') === true || error.problemType?.includes('orderNotReady') === true || error.status === 429);
    const status = retryable ? 'ready_to_finalize' : 'outcome_unknown';
    await c.get('db').execute(
      `UPDATE cert_acme_orders SET status=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='finalizing'`,
      [status, nonce, acmeFailure(error).reason, nowSeconds(), orderId],
    );
    if (retryable) handleAcmeError(error);
    throw new AppError(503, '证书 finalize 结果未知；请轮询远端订单，不要重复 finalize', 'ACME_OUTCOME_UNKNOWN');
  }
  const order = jsonObject(response.body, 'ACME_ORDER_RESPONSE_INVALID');
  const certUrl = typeof order.certificate === 'string' ? validateAcmeUrlFrom(acmeOrigin(row), order.certificate) : null;
  const status = certUrl ? 'certificate_ready' : 'processing';
  await updateOrder(c, orderId, 'finalize',
    `UPDATE cert_acme_orders SET status=?,certificate_url=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='finalizing'`,
    [status, certUrl, validateRemoteNonce(response), nowSeconds(), orderId]);
  return c.json({ code: 0, id: orderId, status, nonceReady: response.replayNonce !== null });
}

export async function stepPollOrder(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const row = await reserveOrderNonce(c, orderId, ['finalizing','processing','outcome_unknown']);
  if (!row.remote_order_url) throw new AppError(409, 'CA 订单 URL 尚未保存；该请求结果不能自动重试', 'ACME_ORDER_OUTCOME_UNKNOWN');
  let response: AcmeJwsResponse;
  try { response = await signedPost(c, row, row.remote_order_url, ''); }
  catch (error) { handleAcmeError(error); }
  const order = jsonObject(response.body, 'ACME_ORDER_RESPONSE_INVALID');
  let status: string;
  let certificateUrl: string | null = row.certificate_url;
  if (order.status === 'valid') {
    try { if (typeof order.certificate === 'string') certificateUrl = validateAcmeUrlFrom(acmeOrigin(row), order.certificate); }
    catch {
      await updateOrder(c, orderId, 'poll-order',
        `UPDATE cert_acme_orders SET status='outcome_unknown',replay_nonce=NULL,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status IN ('finalizing','processing','outcome_unknown')`,
        ['ACME_CERTIFICATE_URL_REJECTED', nowSeconds(), orderId]);
      throw new AppError(503, 'CA 返回的证书 URL 无效；请管理员检查 CA 订单', 'ACME_ORDER_OUTCOME_UNKNOWN');
    }
    status = certificateUrl ? 'certificate_ready' : 'processing';
  } else if (order.status === 'invalid') {
    status = 'failed';
  } else {
    status = 'processing';
  }
  await updateOrder(c, orderId, 'poll-order',
    `UPDATE cert_acme_orders SET status=?,certificate_url=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status IN ('finalizing','processing','outcome_unknown')`,
    [status, certificateUrl, validateRemoteNonce(response), status === 'failed' ? 'ACME_ORDER_FAILED' : null, nowSeconds(), orderId]);
  if (status === 'failed') throw new AppError(502, 'CA 证书签发失败', 'ACME_ORDER_FAILED');
  return c.json({ code: 0, id: orderId, status, nonceReady: response.replayNonce !== null });
}

export async function stepFetchCertificate(c: Context<AppEnv>): Promise<Response> {
  requireAdmin(c);
  const orderId = id(c.req.param('id'), '签发任务');
  const row = await reserveOrderNonce(c, orderId, ['certificate_ready']);
  if (!row.certificate_url) throw new AppError(409, '证书 URL 不存在', 'ACME_CERTIFICATE_URL_MISSING');
  const certificateResponse = await signedPost(c, row, row.certificate_url, '');
  try {
    if (!certificateResponse.text.includes('-----BEGIN CERTIFICATE-----')) throw new Error('certificate chain is not PEM');
    const privateKey = await decrypt(row.private_key_cipher, c.env.APP_KEY, `cert-acme-order/${orderId}/private-key`);
    const inspected = inspectCertificate(certificateResponse.text, privateKey);
    const domains = domainsFrom(row);
    if (domains.some((requested) => !certificateCovers(requested, inspected.domains))) throw new Error('certificate SAN mismatch');
    return await persistIssuedCertificate(c, row, orderId, certificateResponse, privateKey, inspected, domains);
  } catch (error) {
    const nonce = validateRemoteNonce(certificateResponse);
    await c.get('db').execute(
      `UPDATE cert_acme_orders SET status='certificate_ready',replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=?,updated_at=? WHERE id=? AND status='certificate_ready'`,
      [nonce, error instanceof Error ? error.message.slice(0, 100) : 'CERTIFICATE_VALIDATION_FAILED', nowSeconds(), orderId],
    );
    throw new AppError(502, 'CA 证书尚未通过本地校验；可重新获取并检查', 'ACME_CERTIFICATE_INVALID');
  }
}
export async function persistIssuedCertificate(
  c: Context<AppEnv>, row: IssuanceRow, orderId: number, certificateResponse: AcmeJwsResponse,
  privateKey: string, inspected: ReturnType<typeof inspectCertificate>, domains: string[],
  ) {
  const certId = randomId();
  const now = nowSeconds();
  const [fullchainCipher, privateKeyCipher] = await Promise.all([
    encrypt(certificateResponse.text, c.env.APP_KEY, `cert-order/${certId}/fullchain`),
    encrypt(privateKey, c.env.APP_KEY, `cert-order/${certId}/private-key`),
  ]);
  const results = await c.get('db').batch([
    {
      sql: `INSERT INTO cert_orders
        (id,source,status,issuer,key_type,key_size,issued_at,expires_at,fullchain_cipher,private_key_cipher,created_by,created_at,updated_at,is_auto,renewed_from)
        VALUES (?,'acme','issued',?,'RSA',?,?,?,?,?,?,?,?,?,?)`,
      args: [certId, inspected.issuer, inspected.keySize, inspected.issuedAt, inspected.expiresAt,
        fullchainCipher, privateKeyCipher, row.created_by, now, now, row.renewal_of === null ? 0 : 1, row.renewal_of],
    },
    ...domains.map((domain, sort) => ({
      sql: 'INSERT INTO cert_order_domains (order_id,domain,sort) VALUES (?,?,?)', args: [certId, domain, sort],
    })),
    {
      sql: `UPDATE cert_acme_orders SET status='issued',cert_order_id=?,replay_nonce=?,claimed_nonce=NULL,claimed_at=NULL,last_error=NULL,updated_at=?
        WHERE id=? AND status='certificate_ready'`,
      args: [certId, validateRemoteNonce(certificateResponse), now, orderId],
    },
    {
      sql: 'INSERT INTO audit_logs (user_id,action,target,detail,created_at) SELECT ?,?,?,?,? WHERE changes()=1',
      args: [c.get('principal').user.id, 'cert.acme.order.issued', String(certId), `${domains.length} DNS-01 identifiers · ACME ${row.directory}`, now],
    },
    notificationStatement(
      'certificate',
      row.renewal_of === null ? 'SSL 证书已签发' : 'SSL 证书续签成功',
      certificateEventContent(domains, inspected.expiresAt, `订单：#${certId} · 签发机构：${inspected.issuer}`),
    ),
  ]);
  requireAffected(results[domains.length + 1]?.changes ?? 0, 'ACME_ORDER_ISSUE_SAVE_FAILED');
  return c.json({ code: 0, id: orderId, certificateOrderId: certId, status: 'issued', domains, nonceReady: certificateResponse.replayNonce !== null });
}
