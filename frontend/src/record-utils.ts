import { request, type Session } from './api';

export interface DomainSummary {
  id: number;
  name: string;
  accountName: string;
  accountType: string;
  recordCount?: number;
}

export interface DnsLine { id: string; name: string; parent: string | null }

export interface RecordRow {
  id: string;
  name: string;
  type: string;
  value: string;
  line: string;
  ttl: number;
  mx: number | null;
  weight: number | null;
  remark: string | null;
  status: 0 | 1;
}

export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR', 'URL', 'REDIRECT_URL', 'FORWARD_URL'];
export const TYPE_LABELS: { [key: string]: string } = { URL: 'URL', REDIRECT_URL: '显性URL', FORWARD_URL: '隐性URL' };

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

export function guessRecordType(value: string): string {
  const text = value.trim().toLowerCase();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return 'A';
  if (/^[0-9a-f:.]+$/.test(text) && text.includes(':')) return 'AAAA';
  if (/^\d+$/.test(text) && Number(text) <= 65535) return 'MX';
  if (/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,}$/i.test(text)) return 'CNAME';
  return 'TXT';
}

/** 逐页读取当前用户可见的域名，最多 500 个，避免一次渲染过多入口。 */
export async function loadDomains(signal: AbortSignal): Promise<DomainSummary[]> {
  const items: DomainSummary[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await request<{ code: 0; total: number; items: DomainSummary[] }>(
      `/api/v1/dns/domains?page=${page}&pageSize=100`, { signal },
    );
    items.push(...result.items);
    if (result.items.length < 100 || items.length >= result.total) break;
  }
  return items;
}

export function recordInfo(record: RecordRow) {
  return {
    RecordId: record.id, Name: record.name, Type: record.type, Value: record.value,
    Line: record.line, TTL: record.ttl, MX: record.mx, Weight: record.weight, Remark: record.remark,
  };
}

export function headers(session: Session): Record<string, string> {
  return { 'X-CSRF-Token': session.csrfToken };
}
