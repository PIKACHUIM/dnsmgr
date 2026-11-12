import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import {
  loadProxySettings, normalizeNoProxy, normalizeProxyPassword, normalizeProxyUrl, normalizeProxyUsername,
  proxyView, saveProxySettings, validateProxySettings,
} from '../proxy';

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持代理设置，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

export function proxyRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/system/proxy', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const settings = await loadProxySettings(c);
    return c.json({ code: 0, ...proxyView(settings) });
  });

  routes.put('/api/v1/system/proxy', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const current = await loadProxySettings(c);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new AppError(400, '代理开关必须是布尔值', 'INVALID_PROXY_SETTING');
    }
    const settings = {
      enabled: body.enabled === undefined ? current.enabled : body.enabled,
      url: body.url === undefined ? current.url : normalizeProxyUrl(body.url),
      username: body.username === undefined ? current.username : normalizeProxyUsername(body.username),
      password: body.clearPassword === true
        ? ''
        : typeof body.password === 'string' && body.password !== ''
          ? normalizeProxyPassword(body.password)
          : current.password,
      noProxy: body.noProxy === undefined ? current.noProxy : normalizeNoProxy(body.noProxy),
    };
    validateProxySettings(settings);
    await saveProxySettings(c, settings);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'proxy.settings', 'system',
        `enabled=${settings.enabled},url=${settings.url || 'none'},auth=${Boolean(settings.username)},noProxy=${settings.noProxy || 'none'}`, nowSeconds()],
    );
    return c.json({ code: 0, ...proxyView(settings) });
  });

  return routes;
}
