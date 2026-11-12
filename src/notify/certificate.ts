import type { Context } from 'hono';
import type { AppEnv, Bindings } from '../core/types';
import type { SqlDatabase, SqlStatement } from '../storage/sql';
import { nowSeconds } from '../security/auth';
import { sendConfiguredNotifications } from './settings';

export const CERT_NOTIFY_ENABLED = 'cert_notify_enabled';
export const NOTIFICATION_RETENTION_SECONDS = 7 * 86_400;
const MAX_DELIVERY_ATTEMPTS = 5;

export type NotificationTopic = 'certificate' | 'deploy' | 'system';

interface OutboxRow extends Record<string, unknown> {
  id: number;
  topic: NotificationTopic;
  title: string;
  content: string;
  attempts: number;
}

export async function certificateNotifyEnabled(db: SqlDatabase): Promise<boolean> {
  const rows = await db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [CERT_NOTIFY_ENABLED]);
  return rows[0]?.value !== '0';
}

export function notificationStatement(
  topic: NotificationTopic, title: string, content: string,
): SqlStatement {
  return {
    sql: 'INSERT INTO notification_outbox (topic,title,content,created_at) VALUES (?,?,?,?)',
    args: [topic, title.slice(0, 200), content.slice(0, 4000), nowSeconds()],
  };
}

export async function queueNotification(
  db: SqlDatabase, topic: NotificationTopic, title: string, content: string,
): Promise<void> {
  try {
    const statement = notificationStatement(topic, title, content);
    await db.execute(statement.sql, statement.args ?? []);
  } catch {
    console.error(JSON.stringify({ event: 'notification_queue_failed' }));
  }
}

function notificationContext(env: Bindings, db: SqlDatabase): Context<AppEnv> {
  return {
    env,
    get: (key: string) => key === 'db' ? db : undefined,
  } as unknown as Context<AppEnv>;
}

export async function deliverQueuedNotifications(
  env: Bindings, db: SqlDatabase, limit = 3,
): Promise<{ delivered: number; failed: number; pending: number }> {
  const rows = await db.query<OutboxRow>(
    'SELECT id,topic,title,content,attempts FROM notification_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?', [limit],
  );
  if (rows.length === 0) {
    await db.execute(
      'DELETE FROM notification_outbox WHERE sent_at IS NOT NULL AND sent_at<=?',
      [nowSeconds() - NOTIFICATION_RETENTION_SECONDS],
    ).catch(() => undefined);
    return { delivered: 0, failed: 0, pending: 0 };
  }
  const certEnabled = await certificateNotifyEnabled(db);
  const context = notificationContext(env, db);
  let delivered = 0;
  let failed = 0;
  let pending = 0;
  for (const row of rows) {
    if (row.topic === 'certificate' && !certEnabled) {
      await db.execute('UPDATE notification_outbox SET sent_at=?,last_error=? WHERE id=?', [nowSeconds(), 'DISABLED', row.id]);
      continue;
    }
    let deliveries: Awaited<ReturnType<typeof sendConfiguredNotifications>>;
    try {
      deliveries = await sendConfiguredNotifications(context, row.title, row.content);
    } catch {
      deliveries = [];
    }
    if (deliveries.length === 0) {
      pending += 1;
      continue;
    }
    const failures = deliveries.filter((delivery) => !delivery.ok);
    if (failures.length === 0) {
      await db.execute('UPDATE notification_outbox SET sent_at=?,attempts=attempts+1,last_error=NULL WHERE id=?', [nowSeconds(), row.id]);
      delivered += 1;
      continue;
    }
    failed += 1;
    const attempt = row.attempts + 1;
    await db.execute(
      `UPDATE notification_outbox SET attempts=?,last_error=?,sent_at=CASE WHEN ?>=? THEN ? ELSE sent_at END WHERE id=?`,
      [attempt, failures.map((delivery) => delivery.channel).join(','), attempt, MAX_DELIVERY_ATTEMPTS, nowSeconds(), row.id],
    );
  }
  return { delivered, failed, pending };
}

export function certificateEventContent(domains: string[], expiresAt: number, extra?: string): string {
  const lines = [
    `域名：${domains.join(', ')}`,
    `到期：${new Date(expiresAt * 1000).toISOString().slice(0, 10)}`,
  ];
  if (extra) lines.push(extra);
  return lines.join('\n');
}
