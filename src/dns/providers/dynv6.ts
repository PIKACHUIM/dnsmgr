import { asArray, asRecord, num, sendJson } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface Dynv6Config {
  token: string;
}

const BASE = 'https://dynv6.com/api/v2';

export function createDynv6Provider(config: Dynv6Config, fetchImpl: typeof fetch = fetch): DnsProvider {
  const cache = new Map<string, string>();

  async function request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const response = await sendJson(fetchImpl, `${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, 30000);
    if (!response.ok) {
      const payload = asRecord(response.body ?? {});
      const message = typeof payload.error === 'string' ? payload.error
        : typeof payload.message === 'string' ? payload.message
        : `dynv6 接口请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    return response.body;
  }

  async function zoneId(domain: DnsDomain): Promise<string> {
    const cached = cache.get(domain.name);
    if (cached) return cached;
    const data = asRecord(await request('GET', `/zones/by-name/${encodeURIComponent(domain.name)}`));
    const id = data.id === undefined || data.id === null ? '' : String(data.id);
    if (!id) throw new DnsError('无法获取 dynv6 区域 ID，请确认域名已添加到 dynv6', 409, 'DNS_DOMAIN_NOT_SYNCED');
    cache.set(domain.name, id);
    return id;
  }

  /** dynv6 对空列表、单条记录和多条记录返回三种不同结构。 */
  function rows(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    return record.id === undefined ? [] : [record];
  }

  const relative = (full: string, domain: string) => {
    if (!full || full.toLowerCase() === domain.toLowerCase()) return '@';
    const suffix = `.${domain.toLowerCase()}`;
    return full.toLowerCase().endsWith(suffix) ? full.slice(0, -suffix.length) : full;
  };

  const absolute = (name: string, domain: string) => (name === '@' || name === '' ? domain : name);

  const fqdnValue = (type: string, value: string) => {
    if (type !== 'CNAME' && type !== 'MX') return value;
    if (!value || value.endsWith('.') || !value.includes('.')) return value;
    return `${value}.`;
  };

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    const type = String(row.type ?? 'A').toUpperCase();
    return {
      id: String(row.id ?? ''),
      name: relative(String(row.name ?? ''), domain.name),
      type,
      value: String(row.data ?? ''),
      line: 'default',
      ttl: 600,
      mx: type === 'MX' && row.priority !== undefined && row.priority !== null ? num(row.priority) : null,
      weight: null,
      remark: null,
      status: 1,
      updatedAt: null,
    };
  }

  return {
    type: 'dynv6',

    async check() {
      await request('GET', '/zones');
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const list = asArray(await request('GET', '/zones')).map(asRecord);
      let items = list
        .filter((row) => String(row.name ?? '') !== '')
        .map((row) => ({ id: String(row.id ?? ''), name: String(row.name ?? ''), recordCount: 0 }));
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      const start = (page.page - 1) * page.pageSize;
      return { total: items.length, items: items.slice(start, start + page.pageSize) };
    },

    async addDomain(name) {
      await request('POST', '/zones', { name });
      return { id: '', name, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const id = await zoneId(domain);
      const all = rows(await request('GET', `/zones/${id}/records`)).map((raw) => toRecord(raw, domain))
        .filter((record) => {
          if (query.name && record.name.toLowerCase() !== query.name.toLowerCase()) return false;
          if (query.type && record.type !== query.type) return false;
          if (query.value && record.value !== query.value) return false;
          if (query.keyword) {
            const needle = query.keyword.toLowerCase();
            if (!record.name.toLowerCase().includes(needle) && !record.value.toLowerCase().includes(needle)) return false;
          }
          return true;
        });
      const start = (query.page - 1) * query.pageSize;
      return { total: all.length, items: all.slice(start, start + query.pageSize) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const id = await zoneId(domain);
      const data = asRecord(await request('POST', `/zones/${id}/records`, {
        name: absolute(input.name, domain.name),
        type: input.type,
        data: fqdnValue(input.type, input.value),
        ...(input.type === 'MX' ? { priority: input.mx ?? 10 } : {}),
      }));
      return String(data.id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      const id = await zoneId(domain);
      await request('PATCH', `/zones/${id}/records/${recordId}`, {
        name: absolute(input.name, domain.name),
        type: input.type,
        data: fqdnValue(input.type, input.value),
        ...(input.type === 'MX' ? { priority: input.mx ?? 10 } : {}),
      });
    },

    async deleteRecord(domain, recordId) {
      const id = await zoneId(domain);
      await request('DELETE', `/zones/${id}/records/${recordId}`);
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
