import { asArray, asRecord, num, sendJson } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface PowerDnsConfig {
  ip: string;
  port: string;
  apikey: string;
}

interface Rrset {
  name: string;
  type: string;
  ttl: number;
  records: { content: string; disabled: boolean }[];
  comments?: { content: string }[];
  host?: string;
}

export function createPowerDnsProvider(config: PowerDnsConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const base = `http://${config.ip}:${config.port}/api/v1/servers/localhost`;

  async function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<unknown> {
    const response = await sendJson(fetchImpl, `${base}${path}`, {
      method,
      headers: { 'X-API-Key': config.apikey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const payload = asRecord(response.body ?? {});
      const message = typeof payload.error === 'string' ? payload.error
        : Array.isArray(payload.errors) ? payload.errors.map(String).join(',')
        : `PowerDNS 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    return response.body;
  }

  async function rrsets(domain: DnsDomain): Promise<Rrset[]> {
    const zoneName = domain.id || `${domain.name}.`;
    const data = asRecord(await request('GET', `/zones/${encodeURIComponent(zoneName)}`));
    return asArray(data.rrsets).map((raw) => {
      const row = asRecord(raw);
      return {
        name: String(row.name ?? '').replace(/\.$/, ''),
        type: String(row.type ?? 'A').toUpperCase(),
        ttl: num(row.ttl, 600),
        records: asArray(row.records).map((rawRecord) => {
          const record = asRecord(rawRecord);
          return { content: String(record.content ?? ''), disabled: Boolean(record.disabled) };
        }),
        comments: asArray(row.comments).map((rawComment) => ({ content: String(asRecord(rawComment).content ?? '') })),
      };
    });
  }

  function normalizeValue(type: string, value: string, mx: number | null): string {
    let output = value;
    if (type === 'TXT' && !output.startsWith('"')) output = `"${output}"`;
    if (['CNAME', 'MX', 'ALIAS'].includes(type) && !output.endsWith('.')) output = `${output}.`;
    if (type === 'MX') output = `${mx ?? 10} ${output}`;
    return output;
  }

  function toRecord(rrset: Rrset, rrsetIndex: number, recordIndex: number, domain: DnsDomain): DnsRecord {
    const record = rrset.records[recordIndex]!;
    let value = record.content;
    let mx: number | null = null;
    if (rrset.type === 'MX') {
      const [priority, ...rest] = record.content.split(' ');
      mx = Number(priority) || 0;
      value = rest.join(' ');
    }
    return {
      id: `${rrsetIndex + 1}_${recordIndex + 1}`,
      name: rrset.host ?? '@',
      type: rrset.type,
      value,
      line: 'default',
      ttl: rrset.ttl,
      mx,
      weight: null,
      remark: rrset.comments?.[0]?.content ?? null,
      status: record.disabled ? 0 : 1,
      updatedAt: null,
    };
  }

  function flatten(sets: Rrset[], domain: DnsDomain): DnsRecord[] {
    const uniqueTypes = new Map<string, Rrset[]>();
    for (const set of sets) {
      const key = `${set.name}|${set.type}`;
      const list = uniqueTypes.get(key) ?? [];
      list.push(set);
      uniqueTypes.set(key, list);
    }
    const ordered: Rrset[] = [];
    for (const list of uniqueTypes.values()) ordered.push(list[0]!);
    return ordered.flatMap((set, setIndex) => {
      set.host = relativeName(set.name, domain);
      return set.records.map((_, recordIndex) => toRecord(set, setIndex, recordIndex, domain));
    });
  }

  const relativeName = (full: string, domain: DnsDomain) => {
    const zone = (domain.id || `${domain.name}.`).replace(/\.$/, '');
    if (full === zone) return '@';
    return full.endsWith(`.${zone}`) ? full.slice(0, -zone.length - 1) : full;
  };

  const zoneName = (domain: DnsDomain) => domain.id || `${domain.name}.`;

  const rrsetName = (name: string, domain: DnsDomain) => {
    const zone = zoneName(domain).replace(/\.$/, '');
    return name === '@' ? zone : `${name}.${zone}`;
  };

  async function replace(domain: DnsDomain, name: string, type: string, ttl: number, records: { content: string; disabled: boolean }[], remark?: string | null): Promise<void> {
    const rrset: Record<string, unknown> = {
      name: rrsetName(name, domain), type, ttl, changetype: 'REPLACE', records, comments: [],
    };
    if (remark) rrset.comments = [{ account: '', content: remark }];
    await request('PATCH', `/zones/${encodeURIComponent(zoneName(domain))}`, { rrsets: [rrset] });
  }

  async function remove(domain: DnsDomain, name: string, type: string): Promise<void> {
    await request('PATCH', `/zones/${encodeURIComponent(zoneName(domain))}`, {
      rrsets: [{ name: rrsetName(name, domain), type, changetype: 'DELETE' }],
    });
  }

  async function locate(domain: DnsDomain, recordId: string): Promise<{ set: Rrset; recordIndex: number; all: Rrset[]; setIndex: number }> {
    const sets = await rrsets(domain);
    const [rawSet, rawRecord] = recordId.split('_');
    const setIndex = Number(rawSet) - 1;
    const recordIndex = Number(rawRecord) - 1;
    const set = sets[setIndex];
    if (!set || !set.records[recordIndex]) throw new DnsError('记录不存在，请刷新后重试', 404, 'DNS_RECORD_NOT_FOUND');
    return { set, recordIndex, all: sets, setIndex };
  }

  async function addRecordImpl(domain: DnsDomain, input: DnsRecordInput): Promise<string> {
    const sets = await rrsets(domain);
    const existing = sets.find((set) => set.name === rrsetName(input.name, domain) && set.type === input.type);
    const content = normalizeValue(input.type, input.value, input.mx);
    const records = existing ? [...existing.records] : [];
    if (records.some((record) => record.content === content)) {
      throw new DnsError('已存在相同记录', 409, 'DNS_RECORD_EXISTS');
    }
    records.push({ content, disabled: false });
    await replace(domain, input.name, input.type, input.ttl, records, input.remark);
    const updated = await rrsets(domain);
    const index = updated.findIndex((set) => set.name === rrsetName(input.name, domain) && set.type === input.type);
    if (index < 0) throw new DnsError('记录已提交但未能重新定位，请刷新列表确认', 502, 'DNS_RECORD_ID_UNKNOWN');
    return `${index + 1}_${updated[index]!.records.length}`;
  }

  return {
    type: 'powerdns',

    async check() {
      await request('GET', '/zones');
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = asArray(await request('GET', '/zones')).map(asRecord);
      let items = data.map((row) => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? '').replace(/\.$/, ''),
        recordCount: 0,
      }));
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      const start = (page.page - 1) * page.pageSize;
      return { total: items.length, items: items.slice(start, start + page.pageSize) };
    },

    async addDomain(name) {
      const data = asRecord(await request('POST', '/zones', {
        name: name.endsWith('.') ? name : `${name}.`, kind: 'Native', soa_edit_api: 'INCREASE',
      }));
      return { id: String(data.id ?? ''), name: String(data.name ?? name).replace(/\.$/, ''), recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const items = flatten(await rrsets(domain), domain).filter((record) => {
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
      return addRecordImpl(domain, input);
    },

    async updateRecord(domain, recordId, input) {
      const { set, recordIndex } = await locate(domain, recordId);
      const content = normalizeValue(input.type, input.value, input.mx);
      const sameSet = set.name === rrsetName(input.name, domain) && set.type === input.type;
      if (sameSet) {
        const records = set.records.map((record, index) => (index === recordIndex ? { ...record, content } : record));
        await replace(domain, input.name, input.type, input.ttl, records, input.remark);
        return;
      }
      const remaining = set.records.filter((_, index) => index !== recordIndex);
      if (remaining.length > 0) await replace(domain, relativeName(set.name, domain), set.type, set.ttl, remaining, set.comments?.[0]?.content ?? null);
      else await remove(domain, relativeName(set.name, domain), set.type);
      await addRecordImpl(domain, input);
    },

    async deleteRecord(domain, recordId) {
      const { set, recordIndex } = await locate(domain, recordId);
      const remaining = set.records.filter((_, index) => index !== recordIndex);
      const host = relativeName(set.name, domain);
      if (remaining.length > 0) await replace(domain, host, set.type, set.ttl, remaining, set.comments?.[0]?.content ?? null);
      else await remove(domain, host, set.type);
    },

    async setRecordStatus(domain, recordId, enabled) {
      const { set, recordIndex } = await locate(domain, recordId);
      const records = set.records.map((record, index) => (index === recordIndex ? { ...record, disabled: !enabled } : record));
      await replace(domain, relativeName(set.name, domain), set.type, set.ttl, records, set.comments?.[0]?.content ?? null);
    },

    async setRecordRemark() {
      unsupported('单独设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return [{ id: 'default', name: '默认', parent: null }];
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
