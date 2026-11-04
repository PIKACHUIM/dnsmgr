import type { Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { lookupDomainExpiration } from '../dns/expiration';
import { nowSeconds } from '../security/auth';
import type { SqlDatabase } from '../storage/sql';

interface PendingDomain extends Record<string, unknown> {
  id: number;
  name: string;
}

function db(c: Context<AppEnv>): SqlDatabase {
  return c.get('db');
}

async function audit(c: Context<AppEnv>, domain: PendingDomain, status: 'success' | 'failed', detail: string): Promise<void> {
  await db(c).execute(
    'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
    [0, `domain.expiration.auto.${status}`, domain.name.slice(0, 255), detail.slice(0, 500), nowSeconds()],
  );
}

function budgetExhausted(c: Context<AppEnv>, error: unknown): boolean {
  return (error instanceof AppError && (error.reason === 'REQUEST_BUDGET_EXCEEDED' || error.reason === 'REQUEST_TIMEOUT'))
    || c.env.BUDGET?.remainingMs() === 0;
}

export async function executeInitialExpirationRefresh(c: Context<AppEnv>): Promise<void> {
  const startedAt = nowSeconds();
  const staleClaimBefore = startedAt - 300;
  const pending = await db(c).query<PendingDomain>(
    `SELECT id, name FROM dns_domains
     WHERE check_status = 0 OR (check_status = 3 AND checked_at <= ?)
     ORDER BY CASE WHEN check_status = 0 THEN 0 ELSE 1 END, id ASC LIMIT 1`,
    [staleClaimBefore],
  );
  const domain = pending[0];
  if (!domain) return;

  const claim = await db(c).execute(
    `UPDATE dns_domains SET check_status=3, checked_at=?, updated_at=?
     WHERE id=? AND (check_status=0 OR (check_status=3 AND checked_at <= ?))`,
    [startedAt, startedAt, domain.id, staleClaimBefore],
  );
  if (claim.changes !== 1) return;

  let expiresAt: number;
  try {
    expiresAt = await lookupDomainExpiration(domain.name, c.env.BUDGET?.fetch ?? fetch);
  } catch (error) {
    if (budgetExhausted(c, error)) {
      await db(c).execute(
        'UPDATE dns_domains SET check_status=0, checked_at=NULL, updated_at=? WHERE id=? AND check_status=3 AND checked_at=?',
        [nowSeconds(), domain.id, startedAt],
      );
      return;
    }
    const finishedAt = nowSeconds();
    const failed = await db(c).execute(
      'UPDATE dns_domains SET check_status=2, checked_at=?, updated_at=? WHERE id=? AND check_status=3 AND checked_at=?',
      [finishedAt, finishedAt, domain.id, startedAt],
    );
    if (failed.changes === 1) await audit(c, domain, 'failed', 'initial lookup failed');
    return;
  }

  const finishedAt = nowSeconds();
  const updated = await db(c).execute(
    'UPDATE dns_domains SET expires_at=?, check_status=1, checked_at=?, updated_at=? WHERE id=? AND check_status=3 AND checked_at=?',
    [expiresAt, finishedAt, finishedAt, domain.id, startedAt],
  );
  if (updated.changes === 1) await audit(c, domain, 'success', `expires_at=${expiresAt}`);
}
