import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createD1Database, createTursoDatabase, SqlStorageError, type D1Binding, type D1Statement, type SqlDatabase, type SqlValue } from '../src/storage/sql.js';
import { SqlCoordinator, StorageConflictError } from '../src/storage/coordinator.js';
import { SqlEntityRepository } from '../src/storage/entities.js';
import { canonicalJson, sha256, StorageCorruptionError } from '../src/storage/format.js';
import { createBlobObjectStore, createKvObjectStore, createSqlObjectStore, readLegacyJson, type ImmutableObjectStore } from '../src/storage/objects.js';
import { VersionedSnapshotRepository } from '../src/storage/snapshots.js';
import { createTestDatabase } from './helpers/sqlite.js';
import { createStorage, resolveStorageConfig, StorageConfigurationError } from '../src/storage/config.js';

const closes: (() => void)[] = [];
afterEach(() => { closes.splice(0).forEach((close) => close()); vi.useRealTimers(); });
function database(): SqlDatabase {
  const test = createTestDatabase();
  closes.push(test.close);
  return test.db;
}
function binding(db: SqlDatabase): D1Binding {
  const statement = (sql: string, args: SqlValue[] = []): D1Statement & { sql: string; args: SqlValue[] } => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    async all() { const result = await db.execute(sql, args); return { success: true, results: result.rows, meta: { changes: result.changes } }; },
    async run() { const result = await db.execute(sql, args); return { success: true, results: result.rows, meta: { changes: result.changes } }; },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const result = await db.batch(statements as (D1Statement & { sql: string; args: SqlValue[] })[]);
      return result.map((item) => ({ success: true, results: item.rows, meta: { changes: item.changes } }));
    },
  };
}
const emptyWire = { cols: [], rows: [], affected_row_count: 0 };
function response(type: 'execute' | 'batch', result: unknown): Response {
  return Response.json({ results: [{ type: 'ok', response: { type, result } }, { type: 'ok', response: { type: 'close' } }] });
}

describe('SQLite migration and D1 adapter', () => {
  it('creates shared auth schema with FK and unique constraints', async () => {
    const db = database();
    expect(await db.query('SELECT * FROM system_state')).toEqual([{ id: 1, initialized: 0, storage_identity: null }]);
    await db.execute('INSERT INTO users(username,password_hash,created_at) VALUES (?,?,?)', ['test', 'hash', 100]);
    await expect(db.execute('INSERT INTO users(username,password_hash,created_at) VALUES (?,?,?)', ['test', 'other', 101])).rejects.toThrow();
    await expect(db.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?)', ['hash', 999, 1, 'csrf', 200, 100])).rejects.toThrow();
  });
  it('persists one-use security challenges and monotonically consumes TOTP counters', async () => {
    const db = database();
    await db.execute('INSERT INTO users(id,username,password_hash,created_at) VALUES (1,?,?,?)', ['test', 'hash', 100]);
    await db.execute('INSERT INTO security_challenges VALUES (?,?,?,?,?,?,?)', ['token', 'totp-login', 1, null, 1, 200, 100]);
    expect(await db.query('DELETE FROM security_challenges WHERE token_hash=? RETURNING user_id', ['token'])).toEqual([{ user_id: 1 }]);
    expect(await db.query('DELETE FROM security_challenges WHERE token_hash=? RETURNING user_id', ['token'])).toEqual([]);
    const sql = 'INSERT INTO totp_counters VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET counter=excluded.counter WHERE counter<excluded.counter';
    expect((await db.execute(sql, [1, 100])).changes).toBe(1);
    expect((await db.execute(sql, [1, 100])).changes).toBe(0);
    expect((await db.execute(sql, [1, 99])).changes).toBe(0);
    expect((await db.execute(sql, [1, 101])).changes).toBe(1);
    await db.execute('DELETE FROM users WHERE id=1');
    expect(await db.query('SELECT * FROM totp_counters')).toEqual([]);
  });
  it('preserves number/text/null and supports RETURNING', async () => {
    const db = createD1Database(binding(database()));
    expect(await db.query('SELECT ? AS numeric, ? AS text, ? AS nullable', [42, '0042', null])).toEqual([{ numeric: 42, text: '0042', nullable: null }]);
    const inserted = await db.execute('INSERT INTO rate_limits VALUES (?,?,?) RETURNING count', ['test', 100, 1]);
    expect(inserted).toEqual({ rows: [{ count: 1 }], changes: 1 });
  });
  it('rolls back all statements on atomic batch failure', async () => {
    const db = createD1Database(binding(database()));
    await expect(db.batch([{ sql: 'INSERT INTO rate_limits VALUES (?,?,?)', args: ['one', 100, 1] },
      { sql: 'INSERT INTO rate_limits VALUES (?,?,?)', args: ['one', 100, 2] }])).rejects.toBeInstanceOf(SqlStorageError);
    expect(await db.query('SELECT * FROM rate_limits')).toEqual([]);
  });
  it('fails closed on D1 errors and invalid numeric input', async () => {
    const db = createD1Database({ prepare() { throw new Error('sensitive external details'); }, async batch() { throw new Error('external'); } });
    await expect(db.query('SELECT 1')).rejects.toThrow('SQL storage operation failed');
    await expect(createD1Database(binding(database())).query('SELECT ?', [NaN])).rejects.toThrow(SqlStorageError);
    await expect(createD1Database(binding(database())).query('SELECT ?', [Number.MAX_SAFE_INTEGER + 1])).rejects.toThrow(SqlStorageError);
    expect(await db.batch([])).toEqual([]);
  });
});

describe('Turso HTTPS pipeline', () => {
  it('encodes and decodes typed values without coercing text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('execute', {
      cols: [{ name: 'integer' }, { name: 'float' }, { name: 'text' }, { name: 'nil' }],
      rows: [[{ type: 'integer', value: '42' }, { type: 'float', value: 1.5 }, { type: 'text', value: '0042' }, { type: 'null' }]], affected_row_count: 0,
    }));
    const db = createTursoDatabase({ url: 'libsql://example.test', token: 'test-token', fetch: fetcher });
    expect(await db.query('SELECT ?,?,?,?', [42, 1.5, '0042', null])).toEqual([{ integer: 42, float: 1.5, text: '0042', nil: null }]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://example.test/v2/pipeline');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body)).requests[0].stmt.args).toEqual([
      { type: 'integer', value: '42' }, { type: 'float', value: 1.5 }, { type: 'text', value: '0042' }, { type: 'null' },
    ]);
  });
  it('sends BEGIN, chained conditional statements, COMMIT and conditional ROLLBACK in one batch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('batch', {
      step_results: [emptyWire, { ...emptyWire, affected_row_count: 1 }, { ...emptyWire, affected_row_count: 2 }, emptyWire, null],
      step_errors: [null, null, null, null, null],
    }));
    const db = createTursoDatabase({ url: 'https://example.test', token: 'test-token', fetch: fetcher });
    expect((await db.batch([{ sql: 'INSERT ONE' }, { sql: 'INSERT TWO' }])).map((item) => item.changes)).toEqual([1, 2]);
    const packet = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(packet.requests).toHaveLength(2);
    expect(packet.requests[0].batch.steps.map((step: { stmt: { sql: string } }) => step.stmt.sql)).toEqual(['BEGIN IMMEDIATE', 'INSERT ONE', 'INSERT TWO', 'COMMIT', 'ROLLBACK']);
    expect(packet.requests[0].batch.steps.slice(1).map((step: { condition: unknown }) => step.condition)).toEqual([
      { type: 'ok', step: 0 }, { type: 'ok', step: 1 }, { type: 'ok', step: 2 }, { type: 'not', cond: { type: 'ok', step: 3 } },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('executes Hrana conditional transaction packets against real in-memory SQLite including rollback', async () => {
    const sqlite = new DatabaseSync(':memory:');
    closes.push(() => sqlite.close());
    sqlite.exec(readFileSync(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8'));
    type Condition = { type: 'ok'; step: number } | { type: 'not'; cond: Condition };
    type Step = { condition?: Condition; stmt: { sql: string; args: { type: string; value?: string | number }[] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const packet = JSON.parse(String(init?.body)) as { requests: [{ batch: { steps: Step[] } }] };
      const stepResults: (unknown | null)[] = [];
      const stepErrors: (unknown | null)[] = [];
      const conditionOk = (condition: Condition): boolean => condition.type === 'ok'
        ? stepResults[condition.step] != null : !conditionOk(condition.cond);
      for (const step of packet.requests[0].batch.steps) {
        if (step.condition && !conditionOk(step.condition)) {
          stepResults.push(null); stepErrors.push(null); continue;
        }
        try {
          const statement = sqlite.prepare(step.stmt.sql);
          const args = step.stmt.args.map((value) => value.type === 'null' ? null
            : value.type === 'integer' ? Number(value.value) : value.value as string | number);
          const rows = statement.all(...args);
          const cols = statement.columns().map(({ name }) => ({ name }));
          const wireRows = rows.map((row) => cols.map(({ name }) => {
            const value = row[name];
            return value === null ? { type: 'null' } : typeof value === 'string' ? { type: 'text', value }
              : Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value };
          }));
          const affected = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(step.stmt.sql)
            ? Number(sqlite.prepare('SELECT changes() AS changes').get()!.changes) : 0;
          stepResults.push({ cols, rows: wireRows, affected_row_count: affected });
          stepErrors.push(null);
        } catch {
          stepResults.push(null); stepErrors.push({ message: 'statement failed' });
        }
      }
      return response('batch', { step_results: stepResults, step_errors: stepErrors });
    });
    const db = createTursoDatabase({ url: 'https://example.test', token: 'test-token', fetch: fetcher });
    await expect(db.batch([
      { sql: 'INSERT INTO rate_limits VALUES (?,?,?)', args: ['test', 100, 1] },
      { sql: 'INSERT INTO rate_limits VALUES (?,?,?)', args: ['test', 100, 2] },
    ])).rejects.toThrow(SqlStorageError);
    expect(sqlite.prepare('SELECT * FROM rate_limits').all()).toEqual([]);
    expect((await db.batch([
      { sql: 'INSERT INTO rate_limits VALUES (?,?,?)', args: ['one', 100, 1] },
      { sql: 'INSERT INTO rate_limits VALUES (?,?,?)', args: ['two', 100, 2] },
    ])).map((result) => result.changes)).toEqual([1, 1]);
    expect(sqlite.prepare('SELECT * FROM rate_limits').all()).toHaveLength(2);
  });
  it('rejects failed transactions instead of returning partial results', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('batch', {
      step_results: [emptyWire, emptyWire, null, null, emptyWire],
      step_errors: [null, null, { message: 'private data' }, null, null],
    }));
    const db = createTursoDatabase({ url: 'https://example.test', token: 'test-token', fetch: fetcher });
    await expect(db.batch([{ sql: 'INSERT ONE' }, { sql: 'INSERT TWO' }])).rejects.toThrow('SQL storage operation failed');
  });
  it.each([
    { cols: [{ name: 'n' }], rows: [[{ type: 'integer', value: '9007199254740993' }]], affected_row_count: 0 },
    { cols: [{ name: 'n' }], rows: [[{ type: 'blob', value: 'AA==' }]], affected_row_count: 0 },
    { cols: [{ name: 'n' }], rows: [[]], affected_row_count: 0 },
    { cols: [{ name: 'n' }, { name: 'n' }], rows: [], affected_row_count: 0 },
  ])('rejects unsupported or corrupt values', async (result) => {
    const db = createTursoDatabase({ url: 'https://example.test', token: 'test-token', fetch: vi.fn<typeof fetch>().mockResolvedValue(response('execute', result)) });
    await expect(db.query('SELECT 1')).rejects.toThrow(SqlStorageError);
  });
  it('rejects HTTP failure, malformed response and insecure endpoint without fallback', async () => {
    expect(() => createTursoDatabase({ url: 'http://example.test', token: 'test-token' })).toThrow(SqlStorageError);
    for (const result of [new Response('private', { status: 500 }), Response.json({ results: [] })]) {
      const db = createTursoDatabase({ url: 'https://example.test', token: 'test-token', fetch: vi.fn<typeof fetch>().mockResolvedValue(result) });
      await expect(db.query('SELECT 1')).rejects.toThrow(SqlStorageError);
    }
  });
  it('aborts requests at timeout and does not retry writes', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const db = createTursoDatabase({ url: 'https://example.test', token: 'test-token', fetch: fetcher, timeoutMs: 20 });
    const pending = expect(db.execute('INSERT ONE')).rejects.toThrow(SqlStorageError);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('SQL coordinator and entity payload repository', () => {
  it('serializes lease acquire, renew, release and monotonically fences stale owners', async () => {
    const coordinator = new SqlCoordinator(database());
    const first = await coordinator.acquire('snapshot:main', 'worker-a', 10, 100);
    await expect(coordinator.acquire('snapshot:main', 'worker-b', 10, 109)).rejects.toThrow(StorageConflictError);
    expect((await coordinator.renew(first, 10, 105)).leaseUntil).toBe(115);
    await coordinator.release(first, 106);
    const second = await coordinator.acquire('snapshot:main', 'worker-b', 10, 106);
    expect(second.fence).toBe(first.fence + 1);
    await expect(coordinator.renew(first, 10, 107)).rejects.toThrow(StorageConflictError);
    await expect(coordinator.release(first, 107)).rejects.toThrow(StorageConflictError);
  });
  it('supports entity CAS, pagination and revision-checked deletion without whole database serialization', async () => {
    const repository = new SqlEntityRepository(database(), 'domains');
    expect(await repository.get('one')).toBeNull();
    expect(await repository.put('one', { title: 'A', enabled: true }, null, 100)).toBe(1);
    await expect(repository.put('one', { title: 'B' }, null, 100)).rejects.toThrow(StorageConflictError);
    expect(await repository.put('one', { title: 'B' }, 1, 101)).toBe(2);
    await expect(repository.put('one', { title: 'C' }, 1, 102)).rejects.toThrow(StorageConflictError);
    await repository.put('two', { title: 'D' }, null, 102);
    expect((await repository.list('one', 1)).map((item) => item.id)).toEqual(['two']);
    await expect(repository.delete('one', 1)).rejects.toThrow(StorageConflictError);
    await repository.delete('one', 2);
    expect(await repository.get('one')).toBeNull();
    await expect(repository.list('', 1000)).rejects.toThrow();
  });
});

describe('immutable snapshots and legacy object reads', () => {
  function snapshots(store?: (db: SqlDatabase) => ImmutableObjectStore) {
    const db = database();
    const objects = store ? store(db) : createSqlObjectStore(db);
    return { db, objects, repo: new VersionedSnapshotRepository(db, objects), coordinator: new SqlCoordinator(db) };
  }
  it('publishes via SQL transaction CAS and retains immutable previous versions', async () => {
    const { db, repo, coordinator } = snapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const first = await repo.write('main', { users: [{ id: 1 }], domains: {} }, null, lease, 100);
    const second = await repo.write('main', { users: [{ id: 2 }] }, first, lease, 101);
    expect((await repo.readVersion('main', first)).data).toEqual({ users: [{ id: 1 }], domains: {} });
    expect((await repo.readActive('main')).version).toBe(second);
    await expect(repo.write('main', { users: [] }, first, lease, 102)).rejects.toThrow(StorageConflictError);
    expect(await repo.activeVersion('main')).toBe(second);
    expect(await db.query('SELECT version FROM storage_versions')).toHaveLength(2);
  });
  it('denies stale fences and wrong coordinator namespaces even with expected active version', async () => {
    const { repo, coordinator } = snapshots();
    const stale = await coordinator.acquire('snapshot:main', 'old', 1, 100);
    const live = await coordinator.acquire('snapshot:main', 'new', 30, 101);
    const first = await repo.write('main', { data: 1 }, null, live, 101);
    await expect(repo.write('main', { data: 2 }, first, stale, 102)).rejects.toThrow(StorageConflictError);
    await expect(repo.write('other', { data: 2 }, null, live, 102)).rejects.toThrow(StorageConflictError);
    expect((await repo.readActive('main')).data).toEqual({ data: 1 });
  });
  it('preserves active pointer after object-write failure', async () => {
    const { repo, coordinator } = snapshots((db) => ({ ...createSqlObjectStore(db), async writeNew() { throw new Error('unavailable'); } }));
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    await expect(repo.write('main', { data: 1 }, null, lease, 100)).rejects.toThrow('unavailable');
    expect(await repo.activeVersion('main')).toBeNull();
  });
  it('throws for missing objects, content hash mismatch, corrupt manifest and unsupported format', async () => {
    const { db, repo, coordinator } = snapshots();
    await expect(repo.readActive('empty')).rejects.toThrow(StorageCorruptionError);
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const version = await repo.write('main', { data: 1 }, null, lease, 100);
    const rows = await db.query<{ object_key: string; payload: string }>('SELECT v.object_key,o.payload FROM storage_versions v JOIN storage_objects o ON o.object_key=v.object_key');
    const row = rows[0]!;
    await db.execute('DELETE FROM storage_objects WHERE object_key=?', [row.object_key]);
    await expect(repo.readActive('main')).rejects.toThrow(StorageCorruptionError);
    await db.execute('INSERT INTO storage_objects VALUES (?,?,?)', [row.object_key, '{}', 100]);
    await expect(repo.readActive('main')).rejects.toThrow(StorageCorruptionError);
    await db.execute('UPDATE storage_objects SET payload=? WHERE object_key=?', [row.payload, row.object_key]);
    await db.execute('UPDATE storage_versions SET manifest=? WHERE version=?', ['{}', version]);
    await expect(repo.readActive('main')).rejects.toThrow(StorageCorruptionError);
    await db.execute('UPDATE storage_versions SET format=? WHERE version=?', ['yaml', version]);
    await expect(repo.readActive('main')).rejects.toThrow(StorageCorruptionError);
  });
  it('writes only fresh immutable KV keys and reads back through SQL pointer', async () => {
    const values = new Map<string, string>();
    const kv = { get: vi.fn(async (key: string) => values.get(key) ?? null), put: vi.fn(async (key: string, value: string) => { values.set(key, value); }) };
    const { repo, coordinator, objects } = snapshots(() => createKvObjectStore(kv));
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const first = await repo.write('main', { data: 1 }, null, lease, 100);
    await repo.write('main', { data: 2 }, first, lease, 101);
    expect(values.size).toBe(2);
    expect((await repo.readVersion('main', first)).data).toEqual({ data: 1 });
    const [key, payload] = values.entries().next().value!;
    await expect(objects.writeNew(key, payload)).rejects.toThrow('Immutable object already exists');
    expect(kv.put).toHaveBeenCalledTimes(2);
  });
  it('requires real Blob adapter put-if-absent behavior without pretending a platform API exists', async () => {
    const { repo, coordinator } = snapshots(() => createBlobObjectStore({ async getText() { return null; }, async putIfAbsent() { return false; } }));
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    await expect(repo.write('main', { data: 1 }, null, lease, 100)).rejects.toThrow('Immutable object already exists');
    expect(await repo.activeVersion('main')).toBeNull();
  });
  it('fails closed for missing/corrupt legacy KV and Blob JSON rather than initializing empty data', async () => {
    await expect(readLegacyJson({ async read() { return null; } }, 'legacy')).rejects.toThrow(StorageCorruptionError);
    await expect(readLegacyJson({ async read() { return '{bad'; } }, 'legacy')).rejects.toThrow(StorageCorruptionError);
    await expect(readLegacyJson({ async read() { return '{"users":[]}'; } }, 'legacy', '0'.repeat(64))).rejects.toThrow(StorageCorruptionError);
    const payload = '{"users":[],"domains":{}}';
    expect(await readLegacyJson({ async read() { return payload; } }, 'legacy', await sha256(payload))).toEqual({ users: [], domains: {} });
    await expect(readLegacyJson({ async read() { return payload; } }, '../legacy')).rejects.toThrow();
  });
  it('validates JSON map keys, sparse/cyclic/nonfinite data and captures input before async writes', async () => {
    expect(() => canonicalJson({ invalid: NaN })).toThrow(StorageCorruptionError);
    expect(() => canonicalJson(new Array(1))).toThrow(StorageCorruptionError);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(StorageCorruptionError);
    const { repo, coordinator } = snapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    await expect(repo.write('main', JSON.parse('{"__proto__":{}}'), null, lease, 100)).rejects.toThrow();
    const mutable = { data: { number: 1 } };
    const pending = repo.write('main', mutable, null, lease, 100);
    mutable.data.number = 2;
    const version = await pending;
    expect((await repo.readVersion('main', version)).data).toEqual({ data: { number: 1 } });
  });
  it('uses database time for production leases despite client clock drift', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    const { db, repo, coordinator } = snapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30);
    const [clock] = await db.query<{ now: number }>('SELECT unixepoch() AS now');
    expect(lease.leaseUntil - clock!.now).toBeGreaterThanOrEqual(29);
    expect(lease.leaseUntil - clock!.now).toBeLessThanOrEqual(30);
    const renewed = await coordinator.renew(lease, 30);
    const version = await repo.write('main', { data: 1 }, null, renewed);
    await db.execute('UPDATE coordinator_leases SET lease_until=unixepoch()-1');
    await expect(repo.write('main', { data: 2 }, version, renewed)).rejects.toThrow(StorageConflictError);
    expect(await repo.activeVersion('main')).toBe(version);
  });
  it('allows exactly one concurrent CAS publication from the same active version', async () => {
    const { repo, coordinator } = snapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const results = await Promise.allSettled([
      repo.write('main', { data: 1 }, null, lease, 100),
      repo.write('main', { data: 2 }, null, lease, 100),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect([1, 2]).toContain((await repo.readActive('main')).data.data);
  });
  it('rolls back metadata insertion when pointer transaction fails', async () => {
    const { db, coordinator, objects } = snapshots();
    const failingDb: SqlDatabase = { ...db, async batch(statements) {
      return db.batch([statements[0]!, { sql: 'INSERT INTO missing_table VALUES (1)' }]);
    } };
    const repo = new VersionedSnapshotRepository(failingDb, objects);
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    await expect(repo.write('main', { data: 1 }, null, lease, 100)).rejects.toThrow();
    expect(await db.query('SELECT * FROM storage_versions')).toEqual([]);
    expect(await repo.activeVersion('main')).toBeNull();
  });
  it('rechecks lease time after slow external object writes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { repo, coordinator } = snapshots((db) => {
      const sqlObjects = createSqlObjectStore(db);
      return { ...sqlObjects, async writeNew(key, payload) {
        await sqlObjects.writeNew(key, payload);
        vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      } };
    });
    const lease = await coordinator.acquire('snapshot:main', 'writer', 1, 100);
    await expect(repo.write('main', { data: 1 }, null, lease, 100)).rejects.toThrow(StorageConflictError);
    expect(await repo.activeVersion('main')).toBeNull();
  });
});

describe('real map and per-entity key snapshot formats', () => {
  it('reuses unchanged entity objects and supports CAS put, delete and cursor pagination', async () => {
    const db = database();
    const values = new Map<string, string>();
    const writes: string[] = [];
    const objects = createKvObjectStore({
      async get(key) { return values.get(key) ?? null; },
      async put(key, payload) { writes.push(key); values.set(key, payload); },
    });
    const repo = new VersionedSnapshotRepository(db, objects, 'key');
    const lease = await new SqlCoordinator(db).acquire('snapshot:main', 'writer', 30, 100);
    const first = await repo.write('main', { alpha: { value: 1 }, beta: { value: 2 } }, null, lease, 100);
    const firstIndex = JSON.parse(values.get((await db.query<{ object_key: string }>('SELECT object_key FROM storage_versions WHERE version=?', [first]))[0]!.object_key)!) as { keyObjects: Record<string, string> };
    expect(writes.filter((key) => key.startsWith('entities/'))).toHaveLength(2);
    writes.length = 0;

    const second = await repo.write('main', { alpha: { value: 1 }, beta: { value: 3 } }, first, lease, 101);
    const secondIndex = JSON.parse(values.get((await db.query<{ object_key: string }>('SELECT object_key FROM storage_versions WHERE version=?', [second]))[0]!.object_key)!) as { keyObjects: Record<string, string> };
    expect(writes.filter((key) => key.startsWith('entities/'))).toHaveLength(1);
    expect(secondIndex.keyObjects.alpha).toBe(firstIndex.keyObjects.alpha);
    expect(secondIndex.keyObjects.beta).not.toBe(firstIndex.keyObjects.beta);

    writes.length = 0;
    const sameValue = await repo.putKey('main', 'beta', { value: 3 }, second, lease, 102);
    expect(sameValue).not.toBe(second);
    expect(writes.filter((key) => key.startsWith('entities/'))).toHaveLength(0);
    await expect(repo.putKey('main', 'beta', { value: 2 }, first, lease, 103)).rejects.toThrow(StorageConflictError);

    writes.length = 0;
    const third = await repo.putKey('main', 'gamma', { value: 4 }, sameValue, lease, 104);
    expect(writes.filter((key) => key.startsWith('entities/'))).toHaveLength(1);
    const fourth = await repo.deleteKey('main', 'alpha', third, lease, 105);
    expect(writes.filter((key) => key.startsWith('entities/'))).toHaveLength(1);
    expect(await repo.readKey('main', 'alpha', first)).toEqual({ value: 1 });
    expect(await repo.readKey('main', 'alpha', fourth)).toBeUndefined();
    expect(await repo.readKey('main', 'gamma', fourth)).toEqual({ value: 4 });
    expect(await repo.listKeys('main', '', 1, fourth)).toEqual({ keys: ['beta'], nextCursor: 'beta', version: fourth });
    expect(await repo.listKeys('main', 'beta', 1, fourth)).toEqual({ keys: ['gamma'], nextCursor: null, version: fourth });
    await expect(repo.deleteKey('main', 'missing', fourth, lease, 104)).rejects.toThrow(StorageConflictError);
  });

  function keySnapshots() {
    const db = database();
    const objects = createSqlObjectStore(db);
    return { db, objects, coordinator: new SqlCoordinator(db), repo: new VersionedSnapshotRepository(db, objects, 'key') };
  }
  it.each(['map', 'key'] as const)('round-trips empty maps and typed entity values in %s', async (format) => {
    const db = database();
    const objects = createSqlObjectStore(db);
    const repo = new VersionedSnapshotRepository(db, objects, format);
    const coordinator = new SqlCoordinator(db);
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const first = await repo.write('main', {}, null, lease, 100);
    expect((await repo.readVersion('main', first)).data).toEqual({});
    const data = { zero: 0, fraction: 1.5, text: '0042', nil: null, flag: false, array: [null, 3], object: { name: '中文' } };
    const second = await repo.write('main', data, first, lease, 101);
    expect((await repo.readVersion('main', second)).data).toEqual(data);
    expect(await repo.readKey('main', 'nil')).toBeNull();
    expect(await repo.readKey('main', 'zero')).toBe(0);
    expect(await repo.readKey('main', 'missing')).toBeUndefined();
    expect((await repo.readVersion('main', first)).data).toEqual({});
  });
  it('stores one whole JSON object for map but independent entity objects plus an index for key', async () => {
    for (const format of ['map', 'key'] as const) {
      const db = database();
      const objects = createSqlObjectStore(db);
      const repo = new VersionedSnapshotRepository(db, objects, format);
      const lease = await new SqlCoordinator(db).acquire('snapshot:main', 'writer', 30, 100);
      await repo.write('main', { first: { title: 'A' }, second: { title: 'B' } }, null, lease, 100);
      const rows = await db.query<{ payload: string }>('SELECT payload FROM storage_objects');
      expect(rows).toHaveLength(format === 'map' ? 1 : 3);
      const rootRows = await db.query<{ format: string; payload: string }>(
        'SELECT v.format,o.payload FROM storage_versions v JOIN storage_objects o ON o.object_key=v.object_key');
      expect(rootRows[0]!.format).toBe(format);
      const envelope = JSON.parse(rootRows[0]!.payload);
      expect(envelope.format).toBe(format);
      if (format === 'map') expect(envelope.data).toEqual({ first: { title: 'A' }, second: { title: 'B' } });
      else {
        expect(envelope).not.toHaveProperty('data');
        expect(Object.keys(envelope.keyObjects)).toEqual(['first', 'second']);
        expect(rows.map((row) => JSON.parse(row.payload)).filter((object) => object.key)).toEqual([
          expect.objectContaining({ key: 'first', data: { title: 'A' } }), expect.objectContaining({ key: 'second', data: { title: 'B' } }),
        ]);
      }
    }
  });
  it('reads only the selected entity object in key mode, not the entire dataset', async () => {
    const { db, objects, coordinator } = keySnapshots();
    const read = vi.fn(objects.read);
    const repo = new VersionedSnapshotRepository(db, { ...objects, read }, 'key');
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const version = await repo.write('main', { first: { id: 1 }, second: { id: 2 }, third: { id: 3 } }, null, lease, 100);
    expect(await repo.readKey('main', 'second', version)).toEqual({ id: 2 });
    expect(read).toHaveBeenCalledTimes(2);
    const entityText = await objects.read(read.mock.calls[1]![0]);
    expect(JSON.parse(entityText!).key).toBe('second');
    await repo.readVersion('main', version);
    expect(read).toHaveBeenCalledTimes(6);
  });
  it('keeps prior key versions immutable and enforces active CAS and stale fencing', async () => {
    const { db, objects, repo, coordinator } = keySnapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const first = await repo.write('main', { first: { title: 'A' }, second: 0 }, null, lease, 100);
    const oldObjects = await db.query<{ object_key: string; payload: string }>('SELECT object_key,payload FROM storage_objects');
    const second = await repo.write('main', { first: { title: 'B' }, third: null }, first, lease, 101);
    expect(await repo.readKey('main', 'first', first)).toEqual({ title: 'A' });
    expect(await repo.readKey('main', 'first', second)).toEqual({ title: 'B' });
    expect(await repo.readKey('main', 'second', second)).toBeUndefined();
    for (const row of oldObjects) expect(await objects.read(row.object_key)).toBe(row.payload);
    await expect(repo.write('main', { first: 'stale' }, first, lease, 102)).rejects.toThrow(StorageConflictError);
    await coordinator.release(lease, 103);
    const next = await coordinator.acquire('snapshot:main', 'new', 30, 103);
    expect(next.fence).toBeGreaterThan(lease.fence);
    await expect(repo.write('main', { first: 'old owner' }, second, lease, 104)).rejects.toThrow(StorageConflictError);
    expect(await repo.activeVersion('main')).toBe(second);
    expect(await db.query('SELECT * FROM storage_versions')).toHaveLength(2);
  });
  it('does not mix map and key format into one active namespace', async () => {
    const { db, objects, repo, coordinator } = keySnapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const first = await repo.write('main', { entity: 1 }, null, lease, 100);
    const map = new VersionedSnapshotRepository(db, objects, 'map');
    await expect(map.readVersion('main', first)).rejects.toThrow(StorageCorruptionError);
    await expect(map.write('main', { entity: 2 }, first, lease, 101)).rejects.toThrow(StorageConflictError);
    expect(await repo.activeVersion('main')).toBe(first);
  });
  it('throws on missing or corrupt entity objects instead of returning partial or empty key data', async () => {
    const { db, repo, coordinator } = keySnapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const version = await repo.write('main', { first: { title: 'A' }, second: null }, null, lease, 100);
    const [row] = await db.query<{ payload: string }>('SELECT o.payload FROM storage_versions v JOIN storage_objects o ON o.object_key=v.object_key');
    const root = JSON.parse(row!.payload);
    const entityKey = root.keyObjects.first;
    await db.execute('DELETE FROM storage_objects WHERE object_key=?', [entityKey]);
    await expect(repo.readKey('main', 'first', version)).rejects.toThrow(StorageCorruptionError);
    await expect(repo.readVersion('main', version)).rejects.toThrow(StorageCorruptionError);
    expect(await repo.readKey('main', 'second', version)).toBeNull();
    await db.execute('INSERT INTO storage_objects VALUES (?,?,?)', [entityKey, '{}', 100]);
    await expect(repo.readKey('main', 'first', version)).rejects.toThrow(StorageCorruptionError);
  });
  it('validates entity key-to-object mapping and per-entity SHA256 even with a rehashed corrupt index', async () => {
    const { db, repo, coordinator } = keySnapshots();
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const version = await repo.write('main', { first: { title: 'A' }, second: { title: 'B' } }, null, lease, 100);
    const [row] = await db.query<{ payload: string; manifest: string }>('SELECT o.payload,v.manifest FROM storage_versions v JOIN storage_objects o ON o.object_key=v.object_key');
    const original = JSON.parse(row!.payload);
    async function corruptIndex(envelope: Record<string, unknown>) {
      const payload = canonicalJson(envelope);
      const hash = await sha256(payload);
      const newObject = `snapshots/main/${version}/${hash}.json`;
      const manifest = { ...JSON.parse(row!.manifest), objectKey: newObject, sha256: hash,
        keyMap: envelope.keyMap, keyObjects: envelope.keyObjects };
      await db.execute('INSERT OR REPLACE INTO storage_objects VALUES (?,?,?)', [newObject, payload, 100]);
      await db.execute('UPDATE storage_versions SET object_key=?,sha256=?,manifest=? WHERE version=?', [newObject, hash, canonicalJson(manifest), version]);
    }
    await corruptIndex({ ...original, keyObjects: { first: original.keyObjects.second, second: original.keyObjects.first } });
    await expect(repo.readKey('main', 'first', version)).rejects.toThrow(StorageCorruptionError);
    await corruptIndex({ ...original, keyMap: { ...original.keyMap, first: '0'.repeat(64) } });
    await expect(repo.readKey('main', 'first', version)).rejects.toThrow(StorageCorruptionError);
    await corruptIndex({ ...original, keyObjects: { first: original.keyObjects.first } });
    await expect(repo.readVersion('main', version)).rejects.toThrow(StorageCorruptionError);
  });
  it.each(['map', 'key'] as const)('atomically rolls back metadata if the lease expires between registration and pointer update in %s', async (format) => {
    const db = database();
    const objects = createSqlObjectStore(db);
    const coordinator = new SqlCoordinator(db);
    const expiringDb: SqlDatabase = { ...db, async batch(statements) {
      return db.batch([statements[0]!, { sql: 'UPDATE coordinator_leases SET lease_until=0 WHERE name=?', args: ['snapshot:main'] }, statements[1]!]);
    } };
    const repo = new VersionedSnapshotRepository(expiringDb, objects, format);
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    await expect(repo.write('main', { first: 1 }, null, lease, 100)).rejects.toThrow();
    expect(await db.query('SELECT * FROM storage_versions')).toEqual([]);
    expect(await repo.activeVersion('main')).toBeNull();
    expect((await db.query<{ lease_until: number }>('SELECT lease_until FROM coordinator_leases'))[0]!.lease_until).toBe(130);
  });
  it('does not publish a partially written key version if any entity object write fails', async () => {
    const { db, objects, coordinator } = keySnapshots();
    const original = new VersionedSnapshotRepository(db, objects, 'key');
    const lease = await coordinator.acquire('snapshot:main', 'writer', 30, 100);
    const first = await original.write('main', { first: 1, second: 2 }, null, lease, 100);
    let writes = 0;
    const failed = new VersionedSnapshotRepository(db, { ...objects, async writeNew(key, payload) {
      if (++writes === 2) throw new Error('object write failed');
      return objects.writeNew(key, payload);
    } }, 'key');
    await expect(failed.write('main', { first: 3, second: 4 }, first, lease, 101)).rejects.toThrow('object write failed');
    expect(await original.activeVersion('main')).toBe(first);
    expect((await original.readActive('main')).data).toEqual({ first: 1, second: 2 });
    expect(await db.query('SELECT * FROM storage_versions')).toHaveLength(1);
  });
  it.each(['kv', 'blob'] as const)('round-trips real per-entity key format through injected %s adapter with SQL pointer', async (driver) => {
    const db = database();
    const values = new Map<string, string>();
    const store = driver === 'kv' ? createKvObjectStore({
      async get(key) { return values.get(key) ?? null; }, async put(key, payload) { values.set(key, payload); },
    }) : createBlobObjectStore({
      async getText(key) { return values.get(key) ?? null; }, async putIfAbsent(key, payload) {
        if (values.has(key)) return false; values.set(key, payload); return true;
      },
    });
    const repo = new VersionedSnapshotRepository(db, store, 'key');
    const lease = await new SqlCoordinator(db).acquire('snapshot:main', 'writer', 30, 100);
    const version = await repo.write('main', { first: 1, second: null }, null, lease, 100);
    expect(values.size).toBe(3);
    expect((await repo.readActive('main')).data).toEqual({ first: 1, second: null });
    expect(await repo.readKey('main', 'first', version)).toBe(1);
    expect(values.has('main')).toBe(false);
  });
});

describe('storage driver and format configuration matrix', () => {
  it.each([
    ['d1', 'sql', undefined], ['d1', 'map', undefined], ['d1', 'key', undefined],
    ['turso', 'sql', undefined], ['turso', 'map', undefined], ['turso', 'key', undefined],
    ['kv', 'map', 'd1'], ['kv', 'map', 'turso'], ['kv', 'key', 'd1'], ['kv', 'key', 'turso'],
    ['blob', 'map', 'd1'], ['blob', 'map', 'turso'], ['blob', 'key', 'd1'], ['blob', 'key', 'turso'],
  ])('accepts implemented driver=%s format=%s coordinator=%s', (driver, format, coordinator) => {
    expect(resolveStorageConfig({ DB_DRIVER: driver, DB_FORMAT: format, COORDINATOR_DRIVER: coordinator }).format).toBe(format);
  });
  it.each([
    { DB_DRIVER: 'kv' }, { DB_DRIVER: 'blob' },
    { DB_DRIVER: 'kv', DB_FORMAT: 'sql', COORDINATOR_DRIVER: 'd1' },
    { DB_DRIVER: 'blob', DB_FORMAT: 'sql', COORDINATOR_DRIVER: 'd1' },
    { DB_DRIVER: 'd1', DB_FORMAT: 'json' },
    { DB_DRIVER: 'd1', DB_FORMAT: 'sqlite' },
    { DB_DRIVER: 'turso', DB_FORMAT: 'msgpack' },
    { DB_DRIVER: 'blob', DB_FORMAT: 'yaml', COORDINATOR_DRIVER: 'd1' },
    { DB_DRIVER: 'd1', COORDINATOR_DRIVER: 'turso' },
    { DB_DRIVER: 'filesystem' },
  ])('rejects unsupported or unsafe configurations without silent fallback', (env) => {
    expect(() => resolveStorageConfig(env)).toThrow(StorageConfigurationError);
  });
  it('auto-selects actual bindings and never creates an in-memory fallback', () => {
    expect(resolveStorageConfig({ DB: binding(database()) })).toEqual({ driver: 'd1', format: 'sql', coordinatorDriver: 'd1' });
    expect(resolveStorageConfig({ TURSO_DATABASE_URL: 'https://example.test' })).toEqual({ driver: 'turso', format: 'sql', coordinatorDriver: 'turso' });
    expect(() => resolveStorageConfig({ DB_DRIVER: 'auto' })).toThrow(StorageConfigurationError);
  });
  it('requires real bindings and Blob adapter at startup and keeps SQL entity mode separate', () => {
    expect(() => createStorage({})).toThrow('Unsupported or unconfigured storage driver');
    expect(() => createStorage({ DB_DRIVER: 'd1' })).toThrow('D1 binding is required');
    expect(() => createStorage({ DB_DRIVER: 'turso' })).toThrow('Turso credentials are required');
    expect(() => createStorage({ DB_DRIVER: 'kv', COORDINATOR_DRIVER: 'd1', DB: binding(database()) })).toThrow('KV binding is required');
    expect(() => createStorage({ DB_DRIVER: 'blob', COORDINATOR_DRIVER: 'd1', DB: binding(database()) })).toThrow('A real platform Blob adapter is required');
    const sql = createStorage({ DB: binding(database()) });
    expect(sql.snapshots).toBeNull();
    expect(sql.entities('test')).toBeInstanceOf(SqlEntityRepository);
    for (const format of ['map', 'key'] as const) {
      const storage = createStorage({ DB_FORMAT: format, DB: binding(database()) });
      expect(storage.snapshots).toBeInstanceOf(VersionedSnapshotRepository);
      expect(storage.snapshots!.format).toBe(format);
      expect(() => storage.entities('test')).toThrow('Use the snapshot repository');
    }
  });
});
