import { asArray, asRecord, num, sendJson } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';

export interface TechnitiumConfig {
  url: string;
  token: string;
}

export function createTechnitiumProvider(config: TechnitiumConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const base = `${config.url.replace(/\/+$/, '')}/api`;

  async function request(method: 'GET' | 'POST', path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Record<string, unknown>> {
    const form = new URLSearchParams({ token: config.token });
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      form.set(key, String(value));
    }
    const response = method === 'GET'
      ? await sendJson(fetchImpl, `${base}${path}?${form.toString()}`, { method: 'GET' })
      : await sendJson(fetchImpl, `${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    const payload = asRecord(response.body ?? {});
    if (!response.ok || payload.status !== 'ok') {
      const message = typeof payload.errorMessage === 'string' && payload.errorMessage
        ? payload.errorMessage : `Technitium 接口请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 || response.status === 403 ? 401 : 502);
    }
    return asRecord(payload.response ?? {});
  }

  interface RawRecord {
    name: string;
    type: string;
    ttl: number;
    disabled: boolean;
    comments?: string;
    rData: Record<string, unknown>;
  }

  async function zoneRecords(domain: DnsDomain): Promise<RawRecord[]> {
    const data = await request('GET', '/zones/records/get', { domain: domain.name, listZone: true });
    return asArray(data.records).map((raw) => {
      const row = asRecord(raw);
      return {
        name: String(row.name ?? '').replace(/\.$/, ''),
        type: String(row.type ?? 'A').toUpperCase(),
        ttl: num(row.ttl, 600),
        disabled: Boolean(row.disabled),
        comments: typeof row.comments === 'string' ? row.comments : undefined,
        rData: asRecord(row.rData ?? {}),
      };
    });
  }

  function valueOf(record: RawRecord): { value: string; mx: number | null } {
    const data = record.rData;
    const text = (key: string, fallback = '') => String(data[key] ?? fallback);
    switch (record.type) {
      case 'A':
      case 'AAAA':
        return { value: text('ipAddress'), mx: null };
      case 'CNAME': return { value: text('cname'), mx: null };
      case 'NS': return { value: text('nameServer'), mx: null };
      case 'MX': return { value: text('exchange'), mx: num(data.preference, 1) };
      case 'TXT': return { value: text('text'), mx: null };
      case 'SRV':
        return {
          value: `${text('priority', '0')} ${text('weight', '0')} ${text('port', '0')} ${text('target')}`.trim(),
          mx: null,
        };
      case 'PTR': return { value: text('ptrName'), mx: null };
      case 'CAA':
        return { value: `${text('flags', '0')} ${text('tag')} "${text('value')}"`, mx: null };
      case 'ANAME': return { value: text('aname'), mx: null };
      case 'DNAME': return { value: text('dname'), mx: null };
      default: return { value: '', mx: null };
    }
  }

  function relative(name: string, domain: string) {
    const trimmed = name.replace(/\.$/, '');
    return trimmed === domain ? '@' : trimmed.endsWith(`.${domain}`) ? trimmed.slice(0, -domain.length - 1) : trimmed;
  }

  const fqdn = (name: string, domain: string) => (name === '@' ? domain : `${name}.${domain}`);

  function recordParams(type: string, value: string, mx: number | null, prefix = ''): Record<string, string> {
    const key = (name: string) => `${prefix}${name}`;
    switch (type) {
      case 'A':
      case 'AAAA': return { [key('IpAddress')]: value };
      case 'CNAME': return { [key('Cname')]: value };
      case 'NS': return { [key('NameServer')]: value };
      case 'MX': return { [key('Exchange')]: value, [key('Preference')]: String(mx ?? 10) };
      case 'TXT': return { [key('Text')]: value };
      case 'SRV': {
        const [priority, weight, port, ...rest] = value.split(/\s+/);
        return {
          [key('Priority')]: priority ?? '0',
          [key('Weight')]: weight ?? '0',
          [key('Port')]: port ?? '0',
          [key('Target')]: rest.join(' '),
        };
      }
      case 'PTR': return { [key('PtrName')]: value };
      case 'CAA': {
        const [flags, tag, ...rest] = value.split(/\s+/);
        return {
          [key('Flags')]: flags ?? '0',
          [key('Tag')]: tag ?? 'issue',
          [key('Value')]: rest.join(' ').replace(/^"|"$/g, ''),
        };
      }
      case 'ANAME': return { [key('AName')]: value };
      case 'DNAME': return { [key('DName')]: value };
      default: throw new DnsError(`Technitium 不支持记录类型 ${type}`, 400, 'DNS_UNSUPPORTED_RECORD_TYPE');
    }
  }

  /** 已有记录的字段名与新增字段不同：ipAddress / cname / aname / dname 等。 */
  const OLD_FIELD: Record<string, string> = {
    IpAddress: 'ipAddress', Cname: 'cname', NameServer: 'nameServer', Exchange: 'exchange',
    Preference: 'preference', Text: 'text', Priority: 'priority', Weight: 'weight', Port: 'port',
    Target: 'target', PtrName: 'ptrName', Flags: 'flags', Tag: 'tag', Value: 'value',
    AName: 'aname', DName: 'dname',
  };

  function oldParams(record: RawRecord): Record<string, string> {
    const { value } = valueOf(record);
    const params = recordParams(record.type, value, num(record.rData.preference, 1));
    return Object.fromEntries(Object.entries(params).map(([key, item]) => [OLD_FIELD[key] ?? key, item]));
  }

  async function locate(domain: DnsDomain, recordId: string): Promise<{ record: RawRecord; index: number }> {
    const records = await zoneRecords(domain);
    const index = Number(recordId);
    if (!Number.isSafeInteger(index) || index < 0 || index >= records.length) {
      throw new DnsError('记录不存在，请刷新后重试', 404, 'DNS_RECORD_NOT_FOUND');
    }
    return { record: records[index]!, index };
  }

  return {
    type: 'technitium',

    async check() {
      await request('GET', '/zones/list');
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('GET', '/zones/list');
      let items = asArray(data.zones).map((raw) => {
        const row = asRecord(raw);
        const name = String(row.name ?? '').replace(/\.$/, '');
        return { id: name, name, recordCount: 0 };
      });
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      const start = (page.page - 1) * page.pageSize;
      return { total: items.length, items: items.slice(start, start + page.pageSize) };
    },

    async addDomain(name) {
      const data = await request('POST', '/zones/create', { zone: name, type: 'Primary' });
      const created = String(data.domain ?? name).replace(/\.$/, '');
      return { id: created, name: created, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const records = await zoneRecords(domain);
      const items: DnsRecord[] = records.map((record, index) => {
        const { value, mx } = valueOf(record);
        return {
          id: String(index),
          name: relative(record.name, domain.name),
          type: record.type,
          value,
          line: 'default',
          ttl: record.ttl,
          mx,
          weight: null,
          remark: record.comments ?? null,
          status: (record.disabled ? 0 : 1) as 0 | 1,
          updatedAt: null,
        };
      }).filter((record) => {
        if (query.name && record.name.toLowerCase() !== query.name.toLowerCase()) return false;
        if (query.type && record.type !== query.type) return false;
        if (query.value && record.value !== query.value) return false;
        if (query.status && String(record.status) !== query.status) return false;
        if (query.keyword) {
          const needle = query.keyword.toLowerCase();
          if (!record.name.toLowerCase().includes(needle) && !record.value.toLowerCase().includes(needle)) return false;
        }
        return true;
      });
      const start = (query.page - 1) * query.pageSize;
      return { total: items.length, items: items.slice(start, start + query.pageSize) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      await request('POST', '/zones/records/add', {
        domain: fqdn(input.name, domain.name),
        zone: domain.name,
        type: input.type,
        ttl: input.ttl,
        ...(input.remark ? { comments: input.remark } : {}),
        ...recordParams(input.type, input.value, input.mx),
      });
      // Technitium 以列表下标标识记录，写后重新定位新记录。
      const records = await zoneRecords(domain);
      const index = records.findIndex((record) =>
        record.name === fqdn(input.name, domain.name) &&
        record.type === input.type &&
        valueOf(record).value === input.value);
      if (index < 0) throw new DnsError('记录已提交但未能重新定位，请刷新列表确认', 502, 'DNS_RECORD_ID_UNKNOWN');
      return String(index);
    },

    async updateRecord(domain, recordId, input) {
      const { record } = await locate(domain, recordId);
      await request('POST', '/zones/records/update', {
        domain: record.name,
        zone: domain.name,
        type: record.type,
        ttl: input.ttl,
        ...(record.name !== fqdn(input.name, domain.name) ? { newDomain: fqdn(input.name, domain.name) } : {}),
        comments: input.remark ?? '',
        ...oldParams(record),
        ...recordParams(input.type, input.value, input.mx, 'new'),
      });
    },

    async deleteRecord(domain, recordId) {
      const { record } = await locate(domain, recordId);
      await request('POST', '/zones/records/delete', {
        domain: record.name,
        zone: domain.name,
        type: record.type,
        ...oldParams(record),
      });
    },

    async setRecordStatus(domain, recordId, enabled) {
      const { record } = await locate(domain, recordId);
      await request('POST', '/zones/records/update', {
        domain: record.name,
        zone: domain.name,
        type: record.type,
        disable: !enabled,
        ...oldParams(record),
      });
    },

    async setRecordRemark(domain, recordId, remark) {
      const { record } = await locate(domain, recordId);
      await request('POST', '/zones/records/update', {
        domain: record.name,
        zone: domain.name,
        type: record.type,
        comments: remark ?? '',
        ...oldParams(record),
      });
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return [{ id: 'default', name: '默认', parent: null }];
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
