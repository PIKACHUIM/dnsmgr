import type { Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { lookupDomainExpiration } from '../dns/expiration';
import {
  sendConfiguredNotifications, type NotificationChannel, type NotificationDelivery,
} from '../notify/settings';
import { nowSeconds } from '../security/auth';
import type { SqlDatabase } from '../storage/sql';

interface PendingDomain extends Record<string, unknown> {
  id: number;
  name: string;
}

interface PeriodicDomain extends PendingDomain {
  check_status: number;
  checked_at: number;
  expires_at: number;
  updated_at: number;
}

interface NoticeDomain extends PendingDomain {
  expires_at: number;
  notice_attempted_at: number | null;
  updated_at: number;
}

const DAY_SECONDS = 86_400;
const NOTICE_COOLDOWN_SECONDS = 20 * 60 * 60;
const MAX_NOTICE_DOMAINS = 10;
export const EXPIRATION_NOTICE_CHANNELS_SETTING = 'expire_notice_channels';
export const EXPIRATION_NOTICE_CHANNELS = ['webhook', 'wxpusher', 'telegram', 'wecom', 'dingtalk', 'feishu'] as const;
export type ExpirationNoticeChannel = typeof EXPIRATION_NOTICE_CHANNELS[number];
export type ExpirationNoticeChannels = Record<ExpirationNoticeChannel, boolean>;

function allExpirationChannels(enabled: boolean): ExpirationNoticeChannels {
  return Object.fromEntries(EXPIRATION_NOTICE_CHANNELS.map((channel) => [channel, enabled])) as ExpirationNoticeChannels;
}

export function defaultExpirationNoticeChannels(): ExpirationNoticeChannels {
  return allExpirationChannels(true);
}

export function parseExpirationNoticeChannels(value: string | null): ExpirationNoticeChannels {
  if (value === null) return defaultExpirationNoticeChannels();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return allExpirationChannels(false);
    const settings = parsed as Record<string, unknown>;
    if (EXPIRATION_NOTICE_CHANNELS.some((channel) => typeof settings[channel] !== 'boolean')) {
      return allExpirationChannels(false);
    }
    return Object.fromEntries(EXPIRATION_NOTICE_CHANNELS.map((channel) => [channel, settings[channel]])) as ExpirationNoticeChannels;
  } catch {
    return allExpirationChannels(false);
  }
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

export async function executeInitialExpirationRefresh(c: Context<AppEnv>): Promise<boolean> {
  const startedAt = nowSeconds();
  const staleClaimBefore = startedAt - 300;
  const pending = await db(c).query<PendingDomain>(
    `SELECT id, name FROM dns_domains
     WHERE check_status = 0 OR (check_status = 3 AND checked_at <= ?)
     ORDER BY CASE WHEN check_status = 0 THEN 0 ELSE 1 END, id ASC LIMIT 1`,
    [staleClaimBefore],
  );
  const domain = pending[0];
  if (!domain) return false;

  const claim = await db(c).execute(
    `UPDATE dns_domains SET check_status=3, checked_at=?, updated_at=?
     WHERE id=? AND (check_status=0 OR (check_status=3 AND checked_at <= ?))`,
    [startedAt, startedAt, domain.id, staleClaimBefore],
  );
  if (claim.changes !== 1) return false;

  let expiresAt: number;
  try {
    expiresAt = await lookupDomainExpiration(domain.name, c.env.BUDGET?.fetch ?? fetch);
  } catch (error) {
    if (budgetExhausted(c, error)) {
      await db(c).execute(
        'UPDATE dns_domains SET check_status=0, checked_at=NULL, updated_at=? WHERE id=? AND check_status=3 AND checked_at=?',
        [nowSeconds(), domain.id, startedAt],
      );
      return true;
    }
    const finishedAt = nowSeconds();
    const failed = await db(c).execute(
      'UPDATE dns_domains SET check_status=2, checked_at=?, updated_at=? WHERE id=? AND check_status=3 AND checked_at=?',
      [finishedAt, finishedAt, domain.id, startedAt],
    );
    if (failed.changes === 1) await audit(c, domain, 'failed', 'initial lookup failed');
    return true;
  }

  const finishedAt = nowSeconds();
  const updated = await db(c).execute(
    'UPDATE dns_domains SET expires_at=?, check_status=1, checked_at=?, updated_at=? WHERE id=? AND check_status=3 AND checked_at=?',
    [expiresAt, finishedAt, finishedAt, domain.id, startedAt],
  );
  if (updated.changes === 1) await audit(c, domain, 'success', `expires_at=${expiresAt}`);
  return true;
}

export async function executePeriodicExpirationRefresh(c: Context<AppEnv>): Promise<boolean> {
  const startedAt = nowSeconds();
  const checkedBefore = startedAt - DAY_SECONDS;
  const expirationFrom = startedAt - 5 * DAY_SECONDS;
  const expirationUntil = startedAt + 30 * DAY_SECONDS;
  const candidates = await db(c).query<PeriodicDomain>(
    `SELECT id, name, check_status, checked_at, expires_at, updated_at FROM dns_domains
     WHERE check_status IN (1,2) AND expires_at BETWEEN ? AND ? AND checked_at <= ?
     ORDER BY expires_at ASC, id ASC LIMIT 1`,
    [expirationFrom, expirationUntil, checkedBefore],
  );
  const domain = candidates[0];
  if (!domain) return false;

  const claim = await db(c).execute(
    `UPDATE dns_domains SET checked_at=?, updated_at=?
     WHERE id=? AND check_status=? AND checked_at=? AND expires_at=? AND checked_at <= ? AND expires_at BETWEEN ? AND ?`,
    [startedAt, startedAt, domain.id, domain.check_status, domain.checked_at, domain.expires_at, checkedBefore, expirationFrom, expirationUntil],
  );
  if (claim.changes !== 1) return false;

  let expiresAt: number;
  try {
    expiresAt = await lookupDomainExpiration(domain.name, c.env.BUDGET?.fetch ?? fetch);
  } catch (error) {
    if (budgetExhausted(c, error)) {
      await db(c).execute(
        'UPDATE dns_domains SET checked_at=?, updated_at=? WHERE id=? AND check_status=? AND checked_at=? AND expires_at=?',
        [domain.checked_at, domain.updated_at, domain.id, domain.check_status, startedAt, domain.expires_at],
      );
      return true;
    }
    const finishedAt = nowSeconds();
    const failed = await db(c).execute(
      'UPDATE dns_domains SET check_status=2, checked_at=?, updated_at=? WHERE id=? AND check_status=? AND checked_at=? AND expires_at=?',
      [finishedAt, finishedAt, domain.id, domain.check_status, startedAt, domain.expires_at],
    );
    if (failed.changes === 1) await audit(c, domain, 'failed', 'periodic lookup failed');
    return true;
  }

  const finishedAt = nowSeconds();
  const updated = await db(c).execute(
    'UPDATE dns_domains SET expires_at=?, check_status=1, checked_at=?, updated_at=? WHERE id=? AND check_status=? AND checked_at=? AND expires_at=?',
    [expiresAt, finishedAt, finishedAt, domain.id, domain.check_status, startedAt, domain.expires_at],
  );
  if (updated.changes === 1) await audit(c, domain, 'success', `expires_at=${expiresAt}`);
  return true;
}

function parseNoticeDays(value: string | null): number[] {
  const raw = value?.trim() ?? '';
  if (!raw || raw.length > 256) return [];
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length > 32 || entries.some((entry) => !/^\d{1,4}$/.test(entry))) return [];
  const days = [...new Set(entries.map(Number))];
  if (days.some((day) => day > 3650)) return [];
  return days.sort((left, right) => left - right);
}

async function auditNotice(c: Context<AppEnv>, day: number, detail: string): Promise<void> {
  await db(c).execute(
    'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
    [0, 'domain.expiration.notice', `days=${day}`, detail.slice(0, 500), nowSeconds()],
  );
}

export async function executeExpirationNotice(c: Context<AppEnv>, offsetMinutes: number): Promise<void> {
  const settings = await db(c).query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', ['expire_noticedays']);
  const days = parseNoticeDays(settings[0]?.value ?? null);
  if (days.length === 0) return;
  const channelSettings = await db(c).query<{ value: string }>(
    'SELECT value FROM app_settings WHERE key=?', [EXPIRATION_NOTICE_CHANNELS_SETTING],
  );
  const channels = parseExpirationNoticeChannels(channelSettings[0]?.value ?? null);
  const enabledChannels = new Set<NotificationChannel>(
    EXPIRATION_NOTICE_CHANNELS.filter((channel) => channels[channel]),
  );
  if (enabledChannels.size === 0) return;

  const startedAt = nowSeconds();
  const localHour = new Date((startedAt + offsetMinutes * 60) * 1000).getUTCHours();
  if (localHour < 9) return;

  const dayWindows = days.map(() => '(expires_at >= ? AND expires_at < ?)').join(' OR ');
  const windowArgs = days.flatMap((day) => [startedAt + day * DAY_SECONDS, startedAt + (day + 1) * DAY_SECONDS]);
  const cooldownBefore = startedAt - NOTICE_COOLDOWN_SECONDS;
  const candidates = await db(c).query<NoticeDomain>(
    `SELECT id, name, expires_at, notice_attempted_at, updated_at FROM dns_domains
     WHERE notice=1 AND expires_at >= ? AND (${dayWindows}) AND (notice_attempted_at IS NULL OR notice_attempted_at <= ?)
     ORDER BY expires_at ASC, id ASC LIMIT ?`,
    [startedAt, ...windowArgs, cooldownBefore, MAX_NOTICE_DOMAINS],
  );
  const first = candidates[0];
  if (!first) return;

  const day = Math.floor((first.expires_at - startedAt) / DAY_SECONDS);
  const dayFrom = startedAt + day * DAY_SECONDS;
  const dayUntil = dayFrom + DAY_SECONDS;
  const group = candidates.filter((candidate) => Math.floor((candidate.expires_at - startedAt) / DAY_SECONDS) === day);
  const claimedResults = await db(c).batch(group.map((domain) => ({
    sql: `UPDATE dns_domains SET notice_attempted_at=?, updated_at=?
          WHERE id=? AND notice=1 AND expires_at=? AND expires_at>=? AND expires_at<?
            AND (notice_attempted_at IS NULL OR notice_attempted_at<=?) AND notice_attempted_at IS ?`,
    args: [startedAt, startedAt, domain.id, domain.expires_at, dayFrom, dayUntil, cooldownBefore, domain.notice_attempted_at],
  })));
  const claimed = group.filter((_, index) => claimedResults[index]?.changes === 1);
  if (claimed.length === 0) return;

  const title = `DNSMGR 域名到期提醒：${day} 天后到期`;
  const content = `以下 ${claimed.length} 个域名将在 ${day} 天后到期：\n${claimed.map((domain) =>
    `- ${domain.name}（${new Date(domain.expires_at * 1000).toISOString()}）`,
  ).join('\n')}`;
  let deliveries: NotificationDelivery[];
  try {
    deliveries = await sendConfiguredNotifications(c, title, content, enabledChannels);
  } catch {
    await auditNotice(c, day, `days=${day} domains=${claimed.length} deliveries=error`);
    return;
  }

  if (deliveries.length === 0) {
    await db(c).batch(claimed.map((domain) => ({
      sql: 'UPDATE dns_domains SET notice_attempted_at=?, updated_at=? WHERE id=? AND notice_attempted_at=?',
      args: [domain.notice_attempted_at, domain.updated_at, domain.id, startedAt],
    })));
    return;
  }
  const deliverySummary = deliveries.map((delivery) =>
    `${delivery.channel}:${delivery.ok ? 'ok' : 'failed'}:${delivery.status ?? 'null'}`,
  ).join(',');
  await auditNotice(c, day, `days=${day} domains=${claimed.length} deliveries=${deliverySummary}`);
}
