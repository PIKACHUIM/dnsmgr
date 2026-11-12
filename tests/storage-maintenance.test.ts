import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { SqlCoordinator } from '../src/storage/coordinator';
import { canonicalJson, sha256, StorageCorruptionError } from '../src/storage/format';
import { createSqlObjectStore } from '../src/storage/objects';
import { VersionedSnapshotRepository } from '../src/storage/snapshots';
import type { StorageRuntime } from '../src/storage/config';
import { exportSnapshot, importSnapshot, listSnapshotVersions, pruneSnapshotVersions, restoreSnapshot } from '../src/storage/maintenance';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const bindings: Bindings = {
  DB_DRIVER: 'turso', DB_FORMAT: 'map', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
  APP_KEY: btoa('12345678901234567890123456789012'), SETUP_TOKEN: 'test-install-token-32-characters!!',
};

describe('versioned snapshot maintenance', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let repository: VersionedSnapshotRepository;
  beforeEach(() => {
    testDb = createTestDatabase();
    repository = new VersionedSnapshotRepository(testDb.db, createSqlObjectStore(testDb.db), 'map');
  });
  afterEach(() => { testDb.close(); });

  it('exports, imports and restores verified snapshot data', async () => {
    const coordinator = new SqlCoordinator(testDb.db);
    const lease = await coordinator.acquire('snapshot:tenant', 'writer');
    const first = await repository.write('tenant', { alpha: 1, nested: { ok: true } }, null, lease);
    const second = await repository.write('tenant', { alpha: 2 }, first, lease);
    await coordinator.release(lease);

    const active = await exportSnapshot(repository, 'tenant');
    expect(active).toMatchObject({ namespace: 'tenant', format: 'map', version: second, data: { alpha: 2 } });
    expect(active.dataSha256).toBe(await sha256(canonicalJson({ alpha: 2 })));
    expect((await listSnapshotVersions(testDb.db, 'tenant')).map((item) => item.version)).toEqual([second, first]);

    const imported = await importSnapshot(
      repository, coordinator, 'copy', { alpha: 3 }, await sha256(canonicalJson({ alpha: 3 })), null, 'importer',
    );
    expect(imported).toMatchObject({ previousVersion: null, format: 'map' });
    expect((await repository.readActive('copy')).data).toEqual({ alpha: 3 });

    const restored = await restoreSnapshot(repository, coordinator, 'copy', imported.version, null, 'restorer');
    expect(restored.restoredFrom).toBe(imported.version);
    expect((await repository.readActive('copy')).data).toEqual({ alpha: 3 });
    expect((await listSnapshotVersions(testDb.db, 'copy')).filter((item) => item.active)).toHaveLength(1);

    await expect(importSnapshot(
      repository, coordinator, 'copy', { alpha: 4 }, await sha256(canonicalJson({ alpha: 3 })), restored.version, 'importer',
    )).rejects.toBeInstanceOf(StorageCorruptionError);
  });

  it('keeps the active version and prunes unreferenced SQL objects', async () => {
    const coordinator = new SqlCoordinator(testDb.db);
    const lease = await coordinator.acquire('snapshot:prune', 'writer');
    const first = await repository.write('prune', { value: 1 }, null, lease);
    const second = await repository.write('prune', { value: 2 }, first, lease);
    const third = await repository.write('prune', { value: 3 }, second, lease);
    await coordinator.release(lease);

    const result = await pruneSnapshotVersions(testDb.db, 'prune', 1, true);
    expect(result.removedVersions).toBe(2);
    expect(result.objectStoreGc).toBe(true);
    expect(result.removedObjects).toBeGreaterThanOrEqual(2);
    const remaining = await listSnapshotVersions(testDb.db, 'prune');
    expect(remaining).toEqual([{ version: third, format: 'map', createdAt: expect.any(Number), active: true }]);
    expect((await repository.readActive('prune')).data).toEqual({ value: 3 });
    const objects = await testDb.db.query<{ object_key: string }>('SELECT object_key FROM storage_objects');
    expect(objects).toHaveLength(1);
  });

  it('validates namespaces, versions and retention bounds', async () => {
    await expect(exportSnapshot(repository, 'missing')).rejects.toThrow();
    await expect(pruneSnapshotVersions(testDb.db, 'tenant', 0, true)).rejects.toThrow();
    await expect(pruneSnapshotVersions(testDb.db, '../escape', 1, true)).rejects.toThrow();
  });

  it('serves admin storage maintenance endpoints with CSRF and audit logging', async () => {
    const coordinator = new SqlCoordinator(testDb.db);
    const lease = await coordinator.acquire('snapshot:tenant', 'seed');
    const seeded = await repository.write('tenant', { item: 'one' }, null, lease);
    await coordinator.release(lease);
    const runtime: StorageRuntime = {
      config: { driver: 'turso', format: 'map', coordinatorDriver: 'turso' },
      db: testDb.db,
      coordinator,
      entities: () => { throw new Error('unused'); },
      snapshots: repository,
    };
    const app = createApp({ database: testDb.db, storage: runtime });
    const request = (path: string, init: RequestInit = {}) => app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    expect((await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! })).status).toBe(200);
    const login = await post('/login', credentials);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = (await login.json() as { csrfToken: string }).csrfToken;

    const versions = await request('/api/v1/system/storage/versions?namespace=tenant', { headers: { cookie } });
    expect(versions.status).toBe(200);
    expect(await versions.json()).toMatchObject({ namespace: 'tenant', format: 'map', active: seeded, versions: [{ version: seeded, active: true }] });

    const exported = await request('/api/v1/system/storage/export?namespace=tenant', { headers: { cookie } });
    expect(exported.status).toBe(200);
    const backup = (await exported.json() as { backup: { data: unknown; dataSha256: string } }).backup;

    expect((await post('/api/v1/system/storage/import', {
      namespace: 'copy', data: backup.data, dataSha256: backup.dataSha256, expectedVersion: null,
    }, { cookie })).status).toBe(403);

    const imported = await post('/api/v1/system/storage/import', {
      namespace: 'copy', data: backup.data, dataSha256: backup.dataSha256, expectedVersion: null,
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(imported.status).toBe(200);
    const importedVersion = (await imported.json() as { version: string }).version;

    const restored = await post('/api/v1/system/storage/restore', {
      namespace: 'copy', version: importedVersion, expectedVersion: importedVersion,
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ restoredFrom: importedVersion });

    const pruned = await post('/api/v1/system/storage/prune', { namespace: 'copy', keep: 1 }, { cookie, 'X-CSRF-Token': csrf });
    expect(pruned.status).toBe(200);
    expect(await pruned.json()).toMatchObject({ namespace: 'copy', removedVersions: 1, objectStoreGc: true });

    expect((await request('/api/v1/system/storage/versions?namespace=__proto__', { headers: { cookie } })).status).toBe(400);
    expect((await request(`/api/v1/system/storage/export?namespace=tenant&version=nope`, { headers: { cookie } })).status).toBe(400);
    const audits = await testDb.db.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action LIKE 'storage.%' ORDER BY id",
    );
    expect(audits.map((row) => row.action)).toEqual(['storage.export', 'storage.import', 'storage.restore', 'storage.prune']);

    await testDb.db.execute('UPDATE users SET level=1 WHERE id=1');
    expect((await request('/api/v1/system/storage/versions?namespace=tenant', { headers: { cookie } })).status).toBe(403);
  });
});
