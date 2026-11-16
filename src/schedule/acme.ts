import type { Bindings } from '../core/types';
import type { SqlDatabase } from '../storage/sql';
import { advanceIssuance } from '../routes/certificate-acme';
import { stepContext } from './certificate';

/** 已由用户显式启动、仍可自动推进的状态；draft 需要用户先提交订单。 */
const ACTIVE_STATUSES = [
  'authorizing', 'challenge_ready', 'dns_present', 'submitted', 'triggering', 'trigger_unknown',
  'authorization_valid', 'ready_to_finalize', 'finalizing', 'processing', 'certificate_ready',
];

const ACTIVE_SQL = ACTIVE_STATUSES.map(() => '?').join(',');
const ORDERS_PER_RUN = 3;

/**
 * 由 /cron 驱动，把已启动的签发任务一步步推到签发完成。
 * 单次 cron 请求只处理少量订单，慢步骤（DNS 生效、CA 验证）留给下一次 cron。
 */
export async function executeCertificateIssuance(
  env: Bindings, db: SqlDatabase,
): Promise<{ processed: boolean; detail: string }> {
  const active = await db.query<{ id: number; created_by: number }>(
    `SELECT id,created_by FROM cert_acme_orders
     WHERE renewal_of IS NULL AND status IN (${ACTIVE_SQL})
     ORDER BY updated_at ASC,id ASC LIMIT ?`,
    [...ACTIVE_STATUSES, ORDERS_PER_RUN],
  );
  if (active.length === 0) return { processed: false, detail: 'no active certificate issuance' };

  const results: string[] = [];
  for (const row of active) {
    if (env.BUDGET && env.BUDGET.remainingMs() < 8_000) break;
    try {
      const outcome = await advanceIssuance(stepContext(env, db, row.created_by, row.id), row.id, { tolerant: true });
      results.push(`#${row.id} → ${outcome.status}${outcome.steps.length > 0 ? `（${outcome.steps.join('、')}）` : ''}`);
    } catch (error) {
      results.push(`#${row.id} → 未推进：${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`);
    }
  }
  return { processed: results.length > 0, detail: results.join('; ') };
}
