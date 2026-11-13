import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input } from '../core/request';
import { nowSeconds, requireAdmin, requireCsrf, requireSession } from '../security/auth';

/** 站点默认皮肤，用于没有本地选择的浏览器；个人选择仍保存在 localStorage。 */
const DEFAULT_SKIN = 'default_skin';
const SKINS = ['classic', 'tech', 'elegant', 'aurora'] as const;
type Skin = typeof SKINS[number];

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持站点偏好，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

function parseSkin(value: unknown): Skin {
  const skin = typeof value === 'string' ? value.trim() : '';
  if (!SKINS.includes(skin as Skin)) throw new AppError(400, '无效的主题皮肤', 'INVALID_SKIN');
  return skin as Skin;
}

async function readDefaultSkin(c: Context<AppEnv>): Promise<Skin> {
  const rows = await c.get('db').query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [DEFAULT_SKIN]);
  const stored = rows[0]?.value;
  return SKINS.includes(stored as Skin) ? stored as Skin : 'classic';
}

export function preferenceRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/preferences/skin', async (c) => {
    requireSql(c);
    return c.json({ code: 0, skin: await readDefaultSkin(c) });
  });

  routes.put('/api/v1/system/skin', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const skin = parseSkin(body.skin);
    await c.get('db').execute(
      'INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
      [DEFAULT_SKIN, skin, nowSeconds()],
    );
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'system.skin', 'system', skin, nowSeconds()],
    );
    return c.json({ code: 0, skin });
  });

  return routes;
}
