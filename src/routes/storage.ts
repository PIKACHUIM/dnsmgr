import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input } from '../core/request';
import { nowSeconds, requireAdmin, requireCsrf, requireSession } from '../security/auth';
import { SqlCoordinator, validateStorageName } from '../storage/coordinator';
import {
  exportSnapshot, importSnapshot, listSnapshotVersions, pruneSnapshotVersions, restoreSnapshot,
} from '../storage/maintenance';

const versionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function namespaceOf(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(400, 'namespace 参数无效', 'INVALID_STORAGE_NAMESPACE');
  try {
    validateStorageName(value);
  } catch {
    throw new AppError(400, 'namespace 参数无效', 'INVALID_STORAGE_NAMESPACE');
  }
  return value;
}

function versionOf(value: unknown): string {
  if (typeof value !== 'string' || !versionPattern.test(value)) {
    throw new AppError(400, 'version 参数无效', 'INVALID_STORAGE_VERSION');
  }
  return value;
}

function expectedVersionOf(body: Record<string, unknown>, required: boolean): string | null | undefined {
  if (body.expectedVersion === undefined) {
    if (required) throw new AppError(400, '缺少 expectedVersion', 'INVALID_STORAGE_VERSION');
    return undefined;
  }
  if (body.expectedVersion === null) return null;
  return versionOf(body.expectedVersion);
}

function snapshots(c: Context<AppEnv>) {
  const repository = c.get('storage').snapshots;
  if (!repository) throw new AppError(501, '当前存储格式不支持快照维护', 'STORAGE_FORMAT_UNSUPPORTED');
  return repository;
}

function leaseOwner(c: Context<AppEnv>): string {
  return `admin-${c.get('principal').user.id}`;
}

async function audited(
  c: Context<AppEnv>, action: string, target: string, detail: string, failureMessage: string,
): Promise<void> {
  try {
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, action, target.slice(0, 255), detail.slice(0, 500), nowSeconds()],
    );
  } catch {
    throw new AppError(503, failureMessage, 'STORAGE_AUDIT_FAILED');
  }
}

const mutationAuditFailure = '维护操作可能已提交，但审计写入未确认；请重新读取版本状态核对';

export function storageRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/system/storage/versions', requireSession, async (c) => {
    requireAdmin(c);
    const repository = snapshots(c);
    const namespace = namespaceOf(c.req.query('namespace'));
    const limit = Number(c.req.query('limit') ?? '50');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new AppError(400, 'limit 需为 1–200', 'INVALID_STORAGE_LIMIT');
    }
    return c.json({
      code: 0,
      namespace,
      format: repository.format,
      active: await repository.activeVersion(namespace),
      versions: await listSnapshotVersions(c.get('db'), namespace, limit),
    });
  });

  routes.get('/api/v1/system/storage/export', requireSession, async (c) => {
    requireAdmin(c);
    const repository = snapshots(c);
    const namespace = namespaceOf(c.req.query('namespace'));
    const rawVersion = c.req.query('version');
    const backup = await exportSnapshot(repository, namespace, rawVersion === undefined ? undefined : versionOf(rawVersion));
    await audited(c, 'storage.export', namespace, `${backup.version} sha256=${backup.dataSha256}`, '导出审计未确认，未返回存储数据');
    return c.json({ code: 0, backup });
  });

  routes.post('/api/v1/system/storage/import', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const repository = snapshots(c);
    const body = await input(c);
    const namespace = namespaceOf(body.namespace);
    const expectedVersion = expectedVersionOf(body, true) as string | null;
    if (typeof body.dataSha256 !== 'string') {
      throw new AppError(400, 'dataSha256 参数无效', 'INVALID_STORAGE_HASH');
    }
    const result = await importSnapshot(
      repository, new SqlCoordinator(c.get('db')), namespace, body.data, body.dataSha256, expectedVersion, leaseOwner(c),
    );
    await audited(c, 'storage.import', namespace, `${result.version} from=${expectedVersion ?? 'null'}`, mutationAuditFailure);
    return c.json({ code: 0, ...result });
  });

  routes.post('/api/v1/system/storage/restore', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const repository = snapshots(c);
    const body = await input(c);
    const namespace = namespaceOf(body.namespace);
    const version = versionOf(body.version);
    const expectedVersion = expectedVersionOf(body, false);
    const result = await restoreSnapshot(
      repository, new SqlCoordinator(c.get('db')), namespace, version, expectedVersion ?? null, leaseOwner(c),
    );
    await audited(c, 'storage.restore', namespace, `${version}->${result.version}`, mutationAuditFailure);
    return c.json({ code: 0, ...result });
  });

  routes.post('/api/v1/system/storage/prune', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    snapshots(c);
    const body = await input(c);
    const namespace = namespaceOf(body.namespace);
    const keep = Number(body.keep ?? 10);
    if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) {
      throw new AppError(400, 'keep 需为 1–100', 'INVALID_STORAGE_RETENTION');
    }
    const driver = c.get('storage').config.driver;
    const result = await pruneSnapshotVersions(c.get('db'), namespace, keep, driver === 'd1' || driver === 'turso');
    await audited(c, 'storage.prune', namespace, `keep=${keep},versions=${result.removedVersions},objects=${result.removedObjects}`, mutationAuditFailure);
    return c.json({ code: 0, ...result });
  });

  return routes;
}
