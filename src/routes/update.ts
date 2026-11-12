import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import { APP_VERSION, LATEST_SCHEMA_VERSION, MIGRATIONS } from '../version';

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持在线更新检查，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

async function schemaState(c: Context<AppEnv>) {
  const db = c.get('db');
  let appliedNames: string[] = [];
  let appliedSource = 'user_version';
  try {
    const rows = await db.query<{ name: string }>('SELECT name FROM d1_migrations ORDER BY id ASC');
    appliedNames = rows.map((row) => row.name.split(/[\\/]/).pop() ?? row.name);
    appliedSource = 'd1_migrations';
  } catch { /* 本地 SQLite 没有 D1 迁移表，退回 PRAGMA user_version */ }
  let userVersion = 0;
  try {
    const rows = await db.query<{ user_version: number }>('PRAGMA user_version');
    userVersion = Number(rows[0]?.user_version ?? 0);
  } catch { /* D1 可能不支持 PRAGMA user_version */ }
  let fromNames = 0;
  for (const migration of MIGRATIONS) {
    if (!appliedNames.includes(migration)) break;
    fromNames += 1;
  }
  if (!appliedNames.length) appliedSource = 'user_version';
  const schemaVersion = Math.max(userVersion, fromNames);
  const pending = MIGRATIONS.slice(Math.min(schemaVersion, MIGRATIONS.length));
  return {
    appliedSource,
    applied: MIGRATIONS.slice(0, Math.min(schemaVersion, MIGRATIONS.length)),
    schemaVersion,
    latestSchemaVersion: LATEST_SCHEMA_VERSION,
    pending,
    compatible: schemaVersion <= LATEST_SCHEMA_VERSION,
  };
}

function updateView(c: Context<AppEnv>, state: Awaited<ReturnType<typeof schemaState>>) {
  const storage = c.get('storage').config;
  return {
    code: 0,
    version: APP_VERSION,
    checkedAt: nowSeconds(),
    runtime: c.env.RUNTIME.platform,
    storage: { driver: storage.driver, format: storage.format },
    schemaVersion: state.schemaVersion,
    latestSchemaVersion: state.latestSchemaVersion,
    pendingMigrations: state.pending,
    pendingCount: state.pending.length,
    upToDate: state.pending.length === 0,
    compatible: state.compatible,
    readOnly: true,
    applyHint: state.pending.length === 0
      ? '当前数据库结构已是最新，无需执行迁移。'
      : '迁移需由运维在本地执行，本页面只做只读检查，不会自动修改数据库。',
  };
}

export function updateRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/system/update', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    return c.json(updateView(c, await schemaState(c)));
  });

  routes.post('/api/v1/system/update/check', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const state = await schemaState(c);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'system.update.check', 'system',
        `version=${APP_VERSION},schema=${state.schemaVersion},pending=${state.pending.length}`, nowSeconds()],
    );
    return c.json(updateView(c, state));
  });

  return routes;
}
