import type { SqlDatabase } from './sql.js';
import { StorageConflictError, unixSeconds, validateStorageName } from './coordinator.js';
import { canonicalJson, jsonMap, parseJsonMap } from './format.js';

export type StoredEntity = { data: Record<string, unknown>; revision: number; updatedAt: number };
export class SqlEntityRepository {
  constructor(private readonly db: SqlDatabase, private readonly namespace: string) {
    validateStorageName(namespace);
  }
  async get(id: string): Promise<StoredEntity | null> {
    validateStorageName(id);
    const rows = await this.db.query<{ payload: string; revision: number; updated_at: number }>(
      'SELECT payload,revision,updated_at FROM storage_entities WHERE namespace=? AND entity_id=?', [this.namespace, id],
    );
    const row = rows[0];
    return row ? { data: parseJsonMap(row.payload), revision: row.revision, updatedAt: row.updated_at } : null;
  }
  async put(id: string, data: Record<string, unknown>, expectedRevision: number | null, now = unixSeconds()): Promise<number> {
    validateStorageName(id);
    const payload = canonicalJson(jsonMap(data));
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new StorageConflictError();
    const result = expectedRevision === null
      ? await this.db.execute(
        `INSERT INTO storage_entities(namespace,entity_id,payload,revision,updated_at) VALUES (?,?,?,1,?)
         ON CONFLICT(namespace,entity_id) DO NOTHING RETURNING revision`, [this.namespace, id, payload, now],
      ) : await this.db.execute(
        `UPDATE storage_entities SET payload=?,revision=revision+1,updated_at=?
         WHERE namespace=? AND entity_id=? AND revision=? RETURNING revision`, [payload, now, this.namespace, id, expectedRevision],
      );
    if (result.changes !== 1) throw new StorageConflictError();
    return Number(result.rows[0]?.revision);
  }
  async delete(id: string, expectedRevision: number): Promise<void> {
    validateStorageName(id);
    const result = await this.db.execute(
      'DELETE FROM storage_entities WHERE namespace=? AND entity_id=? AND revision=?', [this.namespace, id, expectedRevision],
    );
    if (result.changes !== 1) throw new StorageConflictError();
  }
  async list(after = '', limit = 100): Promise<{ id: string; entity: StoredEntity }[]> {
    if (after) validateStorageName(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid entity page size');
    const rows = await this.db.query<{ entity_id: string; payload: string; revision: number; updated_at: number }>(
      `SELECT entity_id,payload,revision,updated_at FROM storage_entities
       WHERE namespace=? AND entity_id>? ORDER BY entity_id LIMIT ?`, [this.namespace, after, limit],
    );
    return rows.map((row) => ({ id: row.entity_id, entity: { data: parseJsonMap(row.payload), revision: row.revision, updatedAt: row.updated_at } }));
  }
}
