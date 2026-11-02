import { asArray, asRecord, num, sendJson } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface NamesiloConfig {
  apikey: string;
}

const BASE = 'https://www.namesilo.com/api/';

export function createNamesiloProvider(config: NamesiloConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function request(operation: string, params: Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ version: '1', type: 'json', key: config.apikey });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const response = await sendJson(fetchImpl, `${BASE}${operation}?${query.toString()}`, { method: 'GET' });
    const reply = asRecord(asRecord(response.body).reply ?? {});
    if (!response.ok || num(reply.code, 0) !== 300) {
      const message = typeof reply.detail === 'string' && reply.detail ? reply.detail : `NameSilo 接口请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.ok ? 502 : response.status);
    }
    return reply;
  }

  function toRecord(raw: unknown): DnsRecord {
    const row = asRecord(raw);
    return {
      id: String(row.record_id ?? ''),
      name: String(row.host ?? '') || '@',
      type: String(row.type ?? 'A').toUpperCase(),
      value: String(row.value ?? ''),
      line: 'default',
      ttl: num(row.ttl, 3600),
      mx: row.distance === undefined || row.distance === null || row.distance === '' ? null : num(row.distance),
      weight: null,
      remark: null,
      status: 1,
      updatedAt: null,
    };
  }

  function matches(record: DnsRecord, query: RecordQuery): boolean {
    if (query.name && record.name.toLowerCase() !== query.name.toLowerCase()) return false;
    if (query.type && record.type !== query.type) return false;
    if (query.value && record.value !== query.value) return false;
    if (query.keyword) {
      const needle = query.keyword.toLowerCase();
      if (!record.name.toLowerCase().includes(needle) && !record.value.toLowerCase().includes(needle)) return false;
    }
    return true;
  }

  return {
    type: 'namesilo',

    async check() {
      await request('listDomains', { page: 1, pageSize: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('listDomains', { page: page.page, pageSize: page.pageSize });
      let items = asArray(data.domains).map((raw) => {
        const name = String(asRecord(raw).domain ?? '');
        return { id: name, name, recordCount: 0 };
      });
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      return { total: num(asRecord(data.pager ?? {}).total, items.length), items };
    },

    async addDomain(name) {
      await request('addDomain', { domain: name });
      return { id: name, name, recordCount: 0 };
    },

    async listRecords(domain, query): Promise<PageResult<DnsRecord>> {
      const data = await request('dnsListRecords', { domain: domain.name });
      const all = asArray(data.resource_record).map(toRecord).filter((record) => matches(record, query));
      const start = (query.page - 1) * query.pageSize;
      return { total: all.length, items: all.slice(start, start + query.pageSize) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('dnsAddRecord', {
        domain: domain.name,
        rrtype: input.type,
        rrhost: input.name === '@' ? '' : input.name,
        rrvalue: input.value,
        rrttl: input.ttl,
        rrdistance: input.type === 'MX' ? input.mx ?? 10 : undefined,
      });
      return String(data.record_id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await request('dnsUpdateRecord', {
        domain: domain.name,
        rrid: recordId,
        rrtype: input.type,
        rrhost: input.name === '@' ? '' : input.name,
        rrvalue: input.value,
        rrttl: input.ttl,
        rrdistance: input.type === 'MX' ? input.mx ?? 10 : undefined,
      });
    },

    async deleteRecord(domain, recordId) {
      await request('dnsDeleteRecord', { domain: domain.name, rrid: recordId });
    },

    async setRecordStatus() {
      unsupported('启用或停用解析记录');
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return [{ id: 'default', name: '默认', parent: null }];
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
