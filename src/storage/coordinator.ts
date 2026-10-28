import type { SqlDatabase } from './sql.js';

export class StorageConflictError extends Error {
  constructor(message = 'Storage version or lease conflict') {
    super(message);
    this.name = 'StorageConflictError';
  }
}
export type Lease = { name: string; owner: string; fence: number; leaseUntil: number };
export function unixSeconds(): number { return Math.floor(Date.now() / 1000); }
export function validateStorageName(name: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) {
    throw new Error('Invalid storage key');
  }
}
function validateTime(now: number, ttl: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 3600) {
    throw new Error('Invalid lease duration');
  }
}
export class SqlCoordinator {
  constructor(readonly db: SqlDatabase) {}

  async acquire(name: string, owner: string, ttl = 30, now?: number): Promise<Lease> {
    validateStorageName(name);
    validateStorageName(owner);
    validateTime(now ?? unixSeconds(), ttl);
    const clock = now === undefined ? 'unixepoch()' : '?';
    const rows = await this.db.query<{ name: string; owner: string; fence: number; lease_until: number }>(
      `INSERT INTO coordinator_leases(name, owner, lease_until, fence) VALUES (?, ?, ${clock}+?, 1)
       ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, lease_until=excluded.lease_until, fence=coordinator_leases.fence+1
       WHERE coordinator_leases.lease_until <= ${clock} RETURNING name, owner, fence, lease_until`,
      now === undefined ? [name, owner, ttl] : [name, owner, now, ttl, now],
    );
    const row = rows[0];
    if (!row) throw new StorageConflictError();
    return { name: row.name, owner: row.owner, fence: row.fence, leaseUntil: row.lease_until };
  }

  async renew(lease: Lease, ttl = 30, now?: number): Promise<Lease> {
    validateTime(now ?? unixSeconds(), ttl);
    const clock = now === undefined ? 'unixepoch()' : '?';
    const result = await this.db.execute(
      `UPDATE coordinator_leases SET lease_until=${clock}+? WHERE name=? AND owner=? AND fence=? AND lease_until>${clock}
       RETURNING lease_until`, now === undefined ? [ttl, lease.name, lease.owner, lease.fence] : [now, ttl, lease.name, lease.owner, lease.fence, now],
    );
    if (result.changes !== 1) throw new StorageConflictError();
    return { ...lease, leaseUntil: Number(result.rows[0]?.lease_until) };
  }

  async release(lease: Lease, now?: number): Promise<void> {
    validateTime(now ?? unixSeconds(), 1);
    const clock = now === undefined ? 'unixepoch()' : '?';
    const result = await this.db.execute(
      `UPDATE coordinator_leases SET lease_until=${clock} WHERE name=? AND owner=? AND fence=? AND lease_until>${clock}`,
      now === undefined ? [lease.name, lease.owner, lease.fence] : [now, lease.name, lease.owner, lease.fence, now],
    );
    if (result.changes !== 1) throw new StorageConflictError();
  }
}
