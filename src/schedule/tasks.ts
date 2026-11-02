export type ScheduleMode = 'once' | 'daily' | 'weekly' | 'monthly';
export type SwitchType = 0 | 1 | 2 | 3;

export interface ScheduleSpec {
  mode: ScheduleMode;
  runTime: string;
  runDate?: string | null;
  weekday?: number | null;
  monthDay?: number | null;
}

export interface ScheduleTaskRow {
  id: number;
  domain_id: number;
  record_id: string | null;
  record_name: string;
  record_type: string;
  switch_type: number;
  mode: ScheduleMode;
  run_date: string | null;
  weekday: number | null;
  month_day: number | null;
  run_time: string;
  value: string | null;
  line: string | null;
  ttl: number | null;
  mx: number | null;
  remark: string | null;
  active: number;
  next_run_at: number;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const DAY = 86_400;

export function parseRunTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function localParts(epoch: number, offsetMinutes: number) {
  const date = new Date((epoch + offsetMinutes * 60) * 1000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function wallTime(year: number, month: number, day: number, hour: number, minute: number, offsetMinutes: number): number {
  return Date.UTC(year, month, day, hour, minute) / 1000 - offsetMinutes * 60;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate() / 1;
}

/**
 * 计算下一次执行时间（epoch 秒）。时间为「本地墙上时间」，offsetMinutes 表示本地时区相对 UTC 的分钟数。
 * 一次性任务若已过期返回 null；循环任务始终返回未来时间。
 */
export function nextRunAt(spec: ScheduleSpec, after: number, offsetMinutes = 480): number | null {
  const time = parseRunTime(spec.runTime);
  if (!time) throw new Error('执行时间格式应为 HH:mm');
  const local = localParts(after, offsetMinutes);
  if (spec.mode === 'once') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(spec.runDate ?? '');
    if (!match) throw new Error('一次性任务需要 YYYY-MM-DD 日期');
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    if (month < 0 || month > 11 || day < 1 || day > daysInMonth(year, month)) throw new Error('运行日期无效');
    const target = wallTime(year, month, day, time.hour, time.minute, offsetMinutes);
    return target > after ? target : null;
  }
  if (spec.mode === 'daily') {
    const today = wallTime(local.year, local.month, local.day, time.hour, time.minute, offsetMinutes);
    return today > after ? today : today + DAY;
  }
  if (spec.mode === 'weekly') {
    if (spec.weekday === null || spec.weekday === undefined || spec.weekday < 0 || spec.weekday > 6) {
      throw new Error('每周任务需要 0–6 的星期值');
    }
    const base = wallTime(local.year, local.month, local.day, time.hour, time.minute, offsetMinutes);
    const diff = (spec.weekday - local.weekday + 7) % 7;
    const candidate = base + diff * DAY;
    return candidate > after ? candidate : candidate + 7 * DAY;
  }
  if (spec.monthDay === null || spec.monthDay === undefined || spec.monthDay < 1 || spec.monthDay > 31) {
    throw new Error('每月任务需要 1–31 的日期');
  }
  for (let offset = 0; offset < 24; offset += 1) {
    const month = local.month + offset;
    const year = local.year + Math.floor(month / 12);
    const normalized = ((month % 12) + 12) % 12;
    if (spec.monthDay > daysInMonth(year, normalized)) continue;
    const candidate = wallTime(year, normalized, spec.monthDay, time.hour, time.minute, offsetMinutes);
    if (candidate > after) return candidate;
  }
  return null;
}

export function modeLabel(mode: ScheduleMode): string {
  return { once: '一次性', daily: '每天', weekly: '每周', monthly: '每月' }[mode];
}

export function switchLabel(type: number): string {
  return { 0: '修改记录值', 1: '启用解析', 2: '暂停解析', 3: '删除解析记录' }[type] ?? `未知(${type})`;
}
