import type { SqlDatabase } from '../storage/sql';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from './settings';

/** 0=关闭，1=开启，2=仅在失败时（旧版 cert_notice_* 的取值）。 */
export type ChannelMode = '0' | '1' | '2';

export const CERT_NOTICE_CHANNELS = 'cert_notice_channels';
export const FAILOVER_NOTICE_CHANNELS = 'failover_notice_channels';

export function normalizeChannelModes(value: unknown): Record<NotificationChannel, ChannelMode> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = {} as Record<NotificationChannel, ChannelMode>;
  for (const channel of NOTIFICATION_CHANNELS) {
    const mode = source[channel];
    result[channel] = mode === '0' || mode === '2' ? mode : '1';
  }
  return result;
}

/** 旧版 notice_* 只有开关两态；这里把任何非 0 值都视为开启。 */
export function normalizeChannelSwitches(value: unknown): Record<NotificationChannel, boolean> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = {} as Record<NotificationChannel, boolean>;
  for (const channel of NOTIFICATION_CHANNELS) {
    const mode = source[channel];
    result[channel] = !(mode === '0' || mode === false || mode === 0);
  }
  return result;
}

async function readSetting(db: SqlDatabase, key: string): Promise<unknown> {
  const rows = await db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [key]);
  if (!rows[0]?.value) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

export async function loadChannelModes(db: SqlDatabase): Promise<Record<NotificationChannel, ChannelMode>> {
  return normalizeChannelModes(await readSetting(db, CERT_NOTICE_CHANNELS));
}

export async function loadChannelSwitches(db: SqlDatabase): Promise<Record<NotificationChannel, boolean>> {
  return normalizeChannelSwitches(await readSetting(db, FAILOVER_NOTICE_CHANNELS));
}

/** 按配置过滤渠道；`failureOnly` 为真时包含「仅失败时」模式。 */
export function allowedChannels(
  modes: Record<NotificationChannel, ChannelMode>, failureOnly = false,
): Set<NotificationChannel> {
  const allowed = new Set<NotificationChannel>();
  for (const channel of NOTIFICATION_CHANNELS) {
    const mode = modes[channel];
    if (mode === '0') continue;
    if (mode === '2' && !failureOnly) continue;
    allowed.add(channel);
  }
  return allowed;
}

export function switchChannels(switches: Record<NotificationChannel, boolean>): Set<NotificationChannel> {
  return new Set(NOTIFICATION_CHANNELS.filter((channel) => switches[channel]));
}
