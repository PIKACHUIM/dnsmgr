import { asArray, asRecord, num, sendJson } from '../http';
import { bceEscape, hmacSha256Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface BaiduConfig {
  AccessKeyId: string;
  SecretAccessKey: string;
}

const HOST = 'dns.baidubce.com';

export function createBaiduProvider(config: BaiduConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const LINES: DnsLine[] = [
    { id: 'default', name: '默认', parent: null },
    { id: 'ct', name: '电信', parent: null },
    { id: 'cnc', name: '联通', parent: null },
    { id: 'cmnet', name: '移动', parent: null },
    { id: 'edu', name: '教育网', parent: null },
    { id: 'search', name: '搜索引擎(百度)', parent: null },
  ];

  async function request(method: string, path: string, query: Record<string, string> = {}, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const params = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== '' && value !== undefined));
    const sortedQuery = Object.keys(params).sort().map((key) => `${bceEscape(key)}=${bceEscape(params[key] ?? '')}`).join('&');
    const payload = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      host: HOST,
      'x-bce-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    if (payload) headers['content-type'] = 'application/json';

    const canonicalHeaders = Object.keys(headers).sort().map((key) => `${bceEscape(key)}:${bceEscape(headers[key] ?? '')}`).join('\n');
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalRequest = [method, path, sortedQuery, canonicalHeaders].join('\n');
    const authString = `bce-auth-v1/${config.AccessKeyId}/${headers['x-bce-date']}/1800`;
    const signingKey = await hmacSha256Hex(config.SecretAccessKey, authString);
    headers.Authorization = `${authString}/${signedHeaders}/${await hmacSha256Hex(signingKey, canonicalRequest)}`;

    const response = await sendJson(fetchImpl, `https://${HOST}${path}${sortedQuery ? `?${sortedQuery}` : ''}`, {
      method,
      headers,
      ...(payload ? { body: payload } : {}),
    });
    const data = response.body;
    if (!response.ok) {
      const error = asRecord(data ?? {});
      const message = typeof error.message === 'string' ? error.message : `百度云 DNS 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 || response.status === 403 ? 401 : 502);
    }
    return data === null || data === undefined ? {} : asRecord(data);
  }

  function toRecord(raw: unknown): DnsRecord {
    const row = asRecord(raw);
    return {
      id: String(row.id ?? ''),
      name: String(row.rr ?? '@') || '@',
      type: String(row.type ?? 'A').toUpperCase(),
      value: String(row.value ?? ''),
      line: typeof row.line === 'string' && row.line ? row.line : 'default',
      ttl: num(row.ttl, 600),
      mx: row.priority === undefined || row.priority === null ? null : num(row.priority),
      weight: null,
      remark: typeof row.description === 'string' && row.description ? row.description : null,
      status: String(row.status ?? '') === 'running' ? 1 : 0,
      updatedAt: null,
    };
  }

  function matches(record: DnsRecord, query: RecordQuery): boolean {
    if (query.name && record.name.toLowerCase() !== query.name.toLowerCase()) return false;
    if (query.type && record.type !== query.type) return false;
    if (query.value && record.value !== query.value) return false;
    if (query.status && String(record.status) !== query.status) return false;
    if (query.keyword) {
      const needle = query.keyword.toLowerCase();
      if (!record.name.toLowerCase().includes(needle) && !record.value.toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  const zonePath = (domain: DnsDomain) => `/v1/dns/zone/${encodeURIComponent(domain.name)}/record`;

  function recordBody(input: DnsRecordInput): Record<string, unknown> {
    return {
      rr: input.name,
      type: input.type,
      value: input.value,
      line: input.line === 'default' ? 'default' : input.line,
      ttl: input.ttl,
      ...(input.type === 'MX' ? { priority: input.mx ?? 10 } : {}),
      ...(input.remark === null ? {} : { description: input.remark }),
    };
  }

  return {
    type: 'baidu',

    async check() {
      await request('GET', '/v1/dns/zone');
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('GET', '/v1/dns/zone', page.keyword ? { name: page.keyword } : {});
      let items = asArray(data.zones).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.id ?? ''), name: String(row.name ?? '').replace(/\.$/, ''), recordCount: 0 };
      });
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      const start = (page.page - 1) * page.pageSize;
      return { total: items.length, items: items.slice(start, start + page.pageSize) };
    },

    async addDomain(name) {
      await request('POST', '/v1/dns/zone', { clientToken: crypto.randomUUID() }, { name });
      const data = await request('GET', '/v1/dns/zone', { name });
      const found = asArray(data.zones).map(asRecord).find((row) => String(row.name ?? '').replace(/\.$/, '') === name);
      return { id: found ? String(found.id ?? '') : '', name, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const data = await request('GET', zonePath(domain), query.name ? { rr: query.name.toLowerCase() } : {});
      const all = asArray(data.records).map(toRecord).filter((record) => matches(record, query));
      const start = (query.page - 1) * query.pageSize;
      return { total: all.length, items: all.slice(start, start + query.pageSize) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('POST', zonePath(domain), { clientToken: crypto.randomUUID() }, recordBody(input));
      return String(data.id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await request('PUT', `${zonePath(domain)}/${encodeURIComponent(recordId)}`, { clientToken: crypto.randomUUID() }, recordBody(input));
    },

    async deleteRecord(domain, recordId) {
      await request('DELETE', `${zonePath(domain)}/${encodeURIComponent(recordId)}`, { clientToken: crypto.randomUUID() });
    },

    async setRecordStatus(domain, recordId, enabled) {
      await request('PUT', `${zonePath(domain)}/${encodeURIComponent(recordId)}`, {
        clientToken: crypto.randomUUID(),
        [enabled ? 'enable' : 'disable']: '',
      });
    },

    async setRecordRemark() {
      unsupported('单独设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return LINES;
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
