import { asArray, asRecord, num, sendJson } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';

export interface CloudflareConfig {
  apikey: string;
  email?: string;
}

interface Envelope {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result?: unknown;
  result_info?: { total_count?: number };
}

const BASE = 'https://api.cloudflare.com/client/v4';

/** Cloudflare 没有“暂停”概念，沿用旧版实现：停用记录在名称后加 `_pause`，根域名用 `__root__` 占位。 */
export function createCloudflareProvider(config: CloudflareConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.email) {
    headers['X-Auth-Email'] = config.email;
    headers['X-Auth-Key'] = config.apikey;
  } else {
    headers.Authorization = `Bearer ${config.apikey}`;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Envelope> {
    const response = await sendJson(fetchImpl, `${BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = asRecord(response.body);
    if (payload.success !== true) {
      const first = asArray(payload.errors)[0];
      const message = first && typeof asRecord(first).message === 'string' ? String(asRecord(first).message) : `Cloudflare 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 200 ? 502 : response.status);
    }
    return payload as unknown as Envelope;
  }

  function zone(domain: DnsDomain): string {
    if (!domain.id) throw new DnsError('该域名缺少 Cloudflare Zone ID，请重新同步域名', 409, 'DNS_DOMAIN_NOT_SYNCED');
    return domain.id;
  }

  function decodeName(domain: DnsDomain, full: string): { name: string; status: 0 | 1 } {
    let name = full;
    let status: 0 | 1 = 1;
    // 停用标记可能追加在域名后缀之前，也可能直接追加在完整域名之后。
    if (name.endsWith('_pause')) {
      status = 0;
      name = name.slice(0, -'_pause'.length);
    }
    const suffix = `.${domain.name.toLowerCase()}`;
    if (name.toLowerCase() === domain.name.toLowerCase()) name = '@';
    else if (name.toLowerCase().endsWith(suffix)) name = name.slice(0, -suffix.length);
    if (name.endsWith('_pause')) {
      status = 0;
      name = name.slice(0, -'_pause'.length);
    }
    if (name === '__root__') name = '@';
    return { name, status };
  }

  function encodeName(domain: DnsDomain, name: string, enabled: boolean): string {
    if (name === '@') return enabled ? domain.name : '__root___pause';
    const full = `${name}.${domain.name}`;
    return enabled ? full : `${full}_pause`;
  }

  function convertType(type: string): string {
    if (type === 'URL') return 'URI';
    if (type === 'FORWARD_URL') return 'URI';
    if (type === 'REDIRECT_URL') return 'URI';
    return type;
  }

  function convertData(type: string, value: string): Record<string, unknown> | null {
    if (type === 'SRV') {
      const parts = value.trim().split(/\s+/);
      if (parts.length === 4) {
        return { priority: num(parts[0]), weight: num(parts[1]), port: num(parts[2]), target: parts[3] };
      }
      if (parts.length === 3) return { weight: num(parts[0]), port: num(parts[1]), target: parts[2] };
      throw new DnsError('SRV 记录值应为「优先级 权重 端口 目标」', 400, 'INVALID_RECORD_VALUE');
    }
    if (type === 'CAA') {
      const parts = value.trim().split(/\s+/);
      if (parts.length < 3) throw new DnsError('CAA 记录值应为「flags tag value」', 400, 'INVALID_RECORD_VALUE');
      return { flags: num(parts[0]), tag: parts[1], value: parts.slice(2).join(' ').replace(/^"|"$/g, '') };
    }
    return null;
  }

  function toRecord(domain: DnsDomain, raw: unknown): DnsRecord {
    const row = asRecord(raw);
    const decoded = decodeName(domain, String(row.name ?? ''));
    const type = String(row.type ?? 'A');
    const value = type === 'SRV' && row.data && typeof row.data === 'object'
      ? `${num(asRecord(row.data).priority)} ${num(asRecord(row.data).weight)} ${num(asRecord(row.data).port)} ${String(asRecord(row.data).target ?? '')}`
      : String(row.content ?? '');
    return {
      id: String(row.id ?? ''),
      name: decoded.name,
      type: type === 'URI' ? 'URL' : type,
      value,
      line: row.proxied === true ? '1' : '0',
      ttl: num(row.ttl, 1),
      mx: row.priority === undefined || row.priority === null ? null : num(row.priority),
      weight: null,
      remark: typeof row.comment === 'string' && row.comment ? row.comment : null,
      status: decoded.status,
      updatedAt: typeof row.modified_on === 'string' ? row.modified_on : null,
    };
  }

  function recordBody(domain: DnsDomain, input: DnsRecordInput, enabled: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: encodeName(domain, input.name, enabled),
      type: convertType(input.type),
      ttl: input.ttl,
      proxied: input.line === '1',
    };
    if (input.remark) body.comment = input.remark;
    const structured = convertData(input.type, input.value);
    if (structured) body.data = structured;
    else body.content = input.value;
    if (input.type === 'MX') body.priority = input.mx ?? 10;
    return body;
  }

  async function recordInfo(domain: DnsDomain, recordId: string): Promise<DnsRecord> {
    const envelope = await call('GET', `/zones/${zone(domain)}/dns_records/${encodeURIComponent(recordId)}`);
    return toRecord(domain, envelope.result);
  }

  return {
    type: 'cloudflare',

    async check() {
      await call('GET', '/zones?per_page=1');
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const query = new URLSearchParams({ page: String(page.page), per_page: String(page.pageSize) });
      if (page.keyword) query.set('name', page.keyword);
      const envelope = await call('GET', `/zones?${query}`);
      const items = asArray(envelope.result).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.id ?? ''), name: String(row.name ?? ''), recordCount: 0 };
      });
      return { total: num(envelope.result_info?.total_count, items.length), items };
    },

    async addDomain(name) {
      const envelope = await call('POST', '/zones', { name, jump_start: false });
      const row = asRecord(envelope.result);
      return { id: String(row.id ?? ''), name: String(row.name ?? name), recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const params = new URLSearchParams({ page: String(query.page), per_page: String(query.pageSize) });
      if (query.type) params.set('type', convertType(query.type));
      if (query.keyword) params.set('search', query.keyword);
      if (query.value) params.set('search', query.value);
      if (query.name) params.set('name', encodeName(domain, query.name, true));
      if (query.line) params.set('proxied', query.line === '1' ? 'true' : 'false');
      const envelope = await call('GET', `/zones/${zone(domain)}/dns_records?${params}`);
      const items = asArray(envelope.result).map((raw) => toRecord(domain, raw));
      return { total: num(envelope.result_info?.total_count, items.length), items };
    },

    async addRecord(domain, input) {
      const envelope = await call('POST', `/zones/${zone(domain)}/dns_records`, recordBody(domain, input, true));
      const row = asRecord(envelope.result);
      return String(row.id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await call('PATCH', `/zones/${zone(domain)}/dns_records/${encodeURIComponent(recordId)}`, recordBody(domain, input, true));
    },

    async deleteRecord(domain, recordId) {
      await call('DELETE', `/zones/${zone(domain)}/dns_records/${encodeURIComponent(recordId)}`);
    },

    async setRecordStatus(domain, recordId, enabled) {
      const current = await recordInfo(domain, recordId);
      await call('PATCH', `/zones/${zone(domain)}/dns_records/${encodeURIComponent(recordId)}`, {
        name: encodeName(domain, current.name, enabled),
      });
    },

    async setRecordRemark(domain, recordId, remark) {
      await call('PATCH', `/zones/${zone(domain)}/dns_records/${encodeURIComponent(recordId)}`, { comment: remark ?? '' });
    },

    async recordLines(): Promise<DnsLine[]> {
      return [{ id: '0', name: '仅 DNS', parent: null }, { id: '1', name: '已代理', parent: null }];
    },

    async minTtl(): Promise<number | null> {
      return 1;
    },
  };
}
