import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { SqlDatabase, SqlResult, SqlValue } from '../../src/storage/sql.js';

export function createTestDatabase(options: { captchaEnabled?: boolean } = {}): { db: SqlDatabase; close: () => void } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of ['0001_core.sql', '0002_dns.sql', '0003_dns_aliases.sql', '0004_schedule.sql', '0005_failover.sql', '0006_domain_expiration_queue.sql', '0007_domain_periodic_expiration_queue.sql', '0008_domain_expiration_notices.sql', '0009_login_captcha.sql', '0010_certificates.sql', '0011_certificate_acme.sql']) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  if (!options.captchaEnabled) sqlite.prepare('UPDATE app_settings SET value=? WHERE key=?').run('2', 'vcode');
  const execute = (sql: string, args: SqlValue[] = []): SqlResult<Record<string, unknown>> => {
    const statement = sqlite.prepare(sql);
    const rows = statement.all(...args) as Record<string, unknown>[];
    const changes = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
      ? Number((sqlite.prepare('SELECT changes() AS changes').get() as { changes: number }).changes) : 0;
    return { rows, changes };
  };
  const db: SqlDatabase = {
    async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []): Promise<T[]> {
      return execute(sql, args).rows as T[];
    },
    async execute(sql, args = []) { return execute(sql, args); },
    async batch(statements) {
      if (statements.length === 0) return [];
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({ sql, args }) => execute(sql, args));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, close: () => sqlite.close() };
}
