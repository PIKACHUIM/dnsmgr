import type { Context } from 'hono';
import type { AppEnv } from './core/types';
import { AppError } from './core/errors';
import { decrypt, encrypt } from './security/crypto';
import { nowSeconds } from './security/auth';

export const PROXY_SETTING = 'proxy_config_cipher';
const PROXY_PURPOSE = 'proxy-config/v1';

export interface ProxySettings {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  noProxy: string;
}

export interface ProxyView {
  enabled: boolean;
  url: string;
  username: string;
  hasPassword: boolean;
  noProxy: string;
}

export function emptyProxySettings(): ProxySettings {
  return { enabled: false, url: '', username: '', password: '', noProxy: '' };
}

function parseSettings(value: string): ProxySettings {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new AppError(503, '代理配置损坏，请重新保存', 'PROXY_CONFIG_CORRUPTED'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(503, '代理配置损坏，请重新保存', 'PROXY_CONFIG_CORRUPTED');
  }
  const source = parsed as Record<string, unknown>;
  const result = emptyProxySettings();
  if (typeof source.enabled === 'boolean') result.enabled = source.enabled;
  for (const key of ['url', 'username', 'password', 'noProxy'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'string') {
      throw new AppError(503, '代理配置损坏，请重新保存', 'PROXY_CONFIG_CORRUPTED');
    }
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  return result;
}

export async function loadProxySettings(c: Context<AppEnv>): Promise<ProxySettings> {
  const rows = await c.get('db').query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [PROXY_SETTING]);
  if (!rows[0]) return emptyProxySettings();
  let plain: string;
  try { plain = await decrypt(rows[0].value, c.env.APP_KEY, PROXY_PURPOSE); }
  catch { throw new AppError(503, '代理配置无法解密，请重新保存', 'PROXY_CONFIG_UNAVAILABLE'); }
  return parseSettings(plain);
}

export async function saveProxySettings(c: Context<AppEnv>, settings: ProxySettings): Promise<void> {
  const cipher = await encrypt(JSON.stringify(settings), c.env.APP_KEY, PROXY_PURPOSE);
  await c.get('db').execute(
    'INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    [PROXY_SETTING, cipher, nowSeconds()],
  );
}

export function proxyView(settings: ProxySettings): ProxyView {
  return {
    enabled: settings.enabled, url: settings.url, username: settings.username,
    hasPassword: Boolean(settings.password), noProxy: settings.noProxy,
  };
}

export function normalizeProxyUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.length > 2000) throw new AppError(400, '代理地址过长', 'INVALID_PROXY_URL');
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError(400, '代理地址无效', 'INVALID_PROXY_URL'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
    throw new AppError(400, '代理地址仅支持 HTTP、HTTPS 或 SOCKS5', 'INVALID_PROXY_URL');
  }
  if (!url.hostname || url.username || url.password || url.hash) {
    throw new AppError(400, '代理地址不能包含凭据或锚点，请使用独立账号字段', 'INVALID_PROXY_URL');
  }
  return url.pathname === '/' && !url.search ? `${url.protocol}//${url.host}` : url.toString();
}

export function normalizeNoProxy(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.length > 2048) throw new AppError(400, '代理排除列表过长', 'INVALID_NO_PROXY');
  const entries = raw.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > 100) throw new AppError(400, '代理排除列表最多 100 项', 'INVALID_NO_PROXY');
  for (const entry of entries) {
    if (!/^[A-Za-z0-9.*_-]{1,255}(?::\d{1,5})?$/.test(entry)) {
      throw new AppError(400, `代理排除项无效：${entry.slice(0, 40)}`, 'INVALID_NO_PROXY');
    }
  }
  return [...new Set(entries)].join(',');
}

export function normalizeProxyUsername(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length > 128) throw new AppError(400, '代理用户名过长', 'INVALID_PROXY_USERNAME');
  if (raw && !/^[^\s:]+$/.test(raw)) throw new AppError(400, '代理用户名不能包含空格或冒号', 'INVALID_PROXY_USERNAME');
  return raw;
}

export function normalizeProxyPassword(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length > 512) throw new AppError(400, '代理密码过长', 'INVALID_PROXY_PASSWORD');
  return raw;
}

export function validateProxySettings(settings: ProxySettings): void {
  if (!settings.enabled) return;
  if (!settings.url) throw new AppError(400, '启用代理时必须填写代理地址', 'INCOMPLETE_PROXY_CONFIG');
  if (Boolean(settings.username) !== Boolean(settings.password)) {
    throw new AppError(400, '代理用户名与密码必须同时填写或同时留空', 'INCOMPLETE_PROXY_CONFIG');
  }
}

export function executorProxy(settings: ProxySettings) {
  if (!settings.enabled) return null;
  return {
    url: settings.url,
    username: settings.username || null,
    password: settings.password || null,
    noProxy: settings.noProxy,
  };
}
