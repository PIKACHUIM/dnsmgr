import { asArray, asRecord, num, sendJson } from '../http';
import { base64Of, hmacSha256Raw } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface QingcloudConfig {
  access_key_id: string;
  secret_access_key: string;
}

const BASE = 'https://api.routewize.com';

export function createQingcloudProvider(config: QingcloudConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function execute(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    const sorted = Object.keys(params).sort().map((key) => [key, String(params[key])] as const);
    const search = method === 'GET' ? sorted.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&') : '';
    const date = new Date().toUTCString();
    const stringToSign = `${method}\n${date}\n${path}${search ? `?${search}` : ''}`;
    const signature = base64Of(await hmacSha256Raw(new TextEncoder().encode(config.secret_access_key), stringToSign));
    const body = method === 'GET' ? undefined : JSON.stringify(params);
    const response = await sendJson(fetchImpl, `${BASE}${path}${search ? `?${search}` : ''}`, {
      method,
      headers: {
        Authorization: `QC-HMAC-SHA256 ${config.access_key_id}:${signature}`,
        Date: date,
        ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      ...(body ? { body } : {}),
    });
    const payload = response.body === null || response.body === undefined ? {} : asRecord(response.body);
    const code = payload.code === undefined ? null : num(payload.code);
    if (!response.ok || (code !== null && code !== 0)) {
      const message = String(payload.message ?? payload.msg ?? `青云 DNS 请求失败（HTTP ${response.status}）`);
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    return payload;
  }

  const relativeName = (full: string, domain: string) => {
    const suffix = `.${domain}`;
    if (full === domain) return '@';
    return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
  };

  const fqdn = (name: string, domain: string) => (name === '@' || name === '' ? `${domain}.` : `${name}.${domain}.`);

  function toRecord(host: Record<string, unknown>, raw: unknown, domain: DnsDomain, groupWeight: number): DnsRecord {
    const row = asRecord(raw);
    const type = String(host.rd_type ?? 'A').toUpperCase();
    let value = String(row.value ?? '');
    let mx: number | null = null;
    if (type === 'MX') {
      const [priority, ...rest] = value.split(' ');
      mx = Number(priority) || 0;
      value = rest.join(' ');
    }
    if (type === 'TXT') value = value.replace(/^"|"$/g, '');
    return {
      id: `${String(host.domain_record_id ?? '')}_${String(row.record_value_id ?? '')}`,
      name: relativeName(String(host.domain_name ?? ''), domain.name),
      type,
      value,
      line: host.view_id === undefined || host.view_id === null ? 'default' : String(host.view_id),
      ttl: num(host.ttl, 600),
      mx,
      weight: groupWeight > 0 ? groupWeight : null,
      remark: null,
      status: num(row.status, 0) === 1 ? 1 : 0,
      updatedAt: typeof host.create_time === 'string' ? host.create_time : null,
    };
  }

  type HostRecord = { host: Record<string, unknown>; records: DnsRecord[]; count: number };

  async function hostRecords(domain: DnsDomain, name: string): Promise<HostRecord[]> {
    const data = await execute('GET', '/v1/dns/host_info/', { zone_name: domain.id, domain_name: name });
    return asArray(data.records).map((entry) => {
      const host = asRecord(entry);
      const records: DnsRecord[] = [];
      for (const rawGroup of asArray(host.record)) {
        const group = asRecord(rawGroup);
        for (const rawValue of asArray(group.data)) {
          records.push(toRecord(host, rawValue, domain, num(group.weight)));
        }
      }
      return { host, records, count: records.length };
    });
  }

  async function hosts(domain: DnsDomain, page: number, pageSize: number, keyword?: string): Promise<{ total: number; items: HostRecord[] }> {
    const data = await execute('GET', '/v1/dns/host/', {
      zone_name: domain.id,
      offset: (page - 1) * pageSize,
      limit: pageSize,
      ...(keyword ? { search_word: keyword } : {}),
    });
    const items = asArray(data.domains).map((raw) => {
      const host = asRecord(raw);
      return {
        host,
        records: [] as DnsRecord[],
        count: num(host.count),
      };
    });
    return { total: num(data.total_count, items.length), items };
  }

  return {
    type: 'qingcloud',

    async check() {
      await execute('GET', '/v1/user/zones', { offset: 0, limit: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await execute('GET', '/v1/user/zones', {
        offset: (page.page - 1) * page.pageSize,
        limit: page.pageSize,
        ...(page.keyword ? { zone_name: page.keyword } : {}),
      });
      const items = asArray(data.zones).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.zone_name ?? ''), name: String(row.zone_name ?? '').replace(/\.$/, ''), recordCount: 0 };
      });
      return { total: num(data.total_count, items.length), items };
    },

    async addDomain(name) {
      const data = await execute('POST', '/v1/zone/', { zone_name: name });
      return { id: String(data.zone_name ?? name), name, recordCount: 0 };
    },

    /** 该接口按主机名分组返回，需逐个主机读取明细；total 为主机组数量而非记录条数。 */
    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      if (query.name) {
        const groups = await hostRecords(domain, fqdn(query.name, domain.name));
        let items = groups.flatMap((group) => group.records);
        if (query.type) items = items.filter((record) => record.type === query.type);
        if (query.value) items = items.filter((record) => record.value === query.value);
        if (query.status) items = items.filter((record) => String(record.status) === query.status);
        return { total: items.length, items };
      }
      const limited = Math.min(query.pageSize, 10);
      const groups = await hosts(domain, query.page, limited, query.keyword);
      const items: DnsRecord[] = [];
      for (const group of groups.items) {
        const details = await hostRecords(domain, String(group.host.domain_name ?? ''));
        for (const detail of details) items.push(...detail.records);
      }
      const filtered = items.filter((record) => !query.status || String(record.status) === query.status);
      return { total: groups.total, items: filtered };
    },

    async addRecord(domain, input: DnsRecordInput) {
      let value = input.value;
      if (input.type === 'MX') value = `${input.mx ?? 10} ${value}`;
      else if (input.type === 'TXT' && !value.startsWith('"')) value = `"${value}"`;
      const record = [{ weight: 0, values: value.split(',').map((item) => ({ value: item.trim(), status: 1 })) }];
      const data = await execute('POST', '/v1/record/', {
        zone_name: domain.id,
        domain_name: input.name,
        view_id: input.line === 'default' ? 0 : Number(input.line) || 0,
        type: input.type,
        ttl: input.ttl,
        record: JSON.stringify(record),
        mode: 1,
        auto_merge: 2,
      });
      const id = String(data.domain_record_id ?? '');
      return id ? `${id}_${String(asRecord(asArray(data.record)[0] ?? {}).record_value_id ?? '')}` : '';
    },

    async updateRecord(_domain, recordId, input) {
      const [domainRecordId, valueId] = recordId.split('_');
      if (!domainRecordId || !valueId) throw new DnsError('recordId 格式无效', 400, 'INVALID_RECORD_ID');
      const current = asRecord(await execute('GET', `/v1/dr_id/${encodeURIComponent(domainRecordId)}`));
      const detail = asRecord(current.data ?? {});
      let value = input.value;
      if (input.type === 'MX') value = `${input.mx ?? 10} ${value}`;
      else if (input.type === 'TXT' && !value.startsWith('"')) value = `"${value}"`;
      const record = asArray(detail.record).map((rawGroup) => {
        const group = asRecord(rawGroup);
        const values = asArray(group.data).map((rawValue) => {
          const row = asRecord(rawValue);
          const id = String(row.record_value_id ?? '');
          return { value: id === valueId ? value : String(row.value ?? ''), status: num(row.status, 1) };
        });
        return { weight: num(group.weight), values };
      });
      await execute('POST', `/v1/dr_id/${encodeURIComponent(domainRecordId)}`, {
        zone_name: String(detail.zone_name ?? ''),
        domain_name: relativeName(String(detail.domain_name ?? ''), String(detail.zone_name ?? '').replace(/\.$/, '')),
        view_id: num(detail.view_id),
        type: String(detail.rd_type ?? input.type),
        ttl: input.ttl,
        record: JSON.stringify(record),
        mode: num(detail.mode, 1),
      });
    },

    async deleteRecord(_domain, recordId) {
      const [domainRecordId, valueId] = recordId.split('_');
      if (!domainRecordId || !valueId) throw new DnsError('recordId 格式无效', 400, 'INVALID_RECORD_ID');
      const current = asRecord(await execute('GET', `/v1/dr_id/${encodeURIComponent(domainRecordId)}`));
      const detail = asRecord(current.data ?? {});
      const record: { weight: number; values: { value: string; status: number }[] }[] = [];
      for (const rawGroup of asArray(detail.record)) {
        const group = asRecord(rawGroup);
        const values = asArray(group.data)
          .map(asRecord)
          .filter((row) => String(row.record_value_id ?? '') !== valueId)
          .map((row) => ({ value: String(row.value ?? ''), status: num(row.status, 1) }));
        if (values.length > 0) record.push({ weight: num(group.weight), values });
      }
      if (record.length === 0) {
        await execute('POST', '/v1/change_record_status/', {
          ids: JSON.stringify([domainRecordId]), target: 'record', action: 'delete',
        });
        return;
      }
      await execute('POST', `/v1/dr_id/${encodeURIComponent(domainRecordId)}`, {
        zone_name: String(detail.zone_name ?? ''),
        domain_name: relativeName(String(detail.domain_name ?? ''), String(detail.zone_name ?? '').replace(/\.$/, '')),
        view_id: num(detail.view_id),
        type: String(detail.rd_type ?? ''),
        ttl: num(detail.ttl),
        record: JSON.stringify(record),
        mode: num(detail.mode, 1),
      });
    },

    async setRecordStatus(_domain, recordId, enabled) {
      const [, valueId] = recordId.split('_');
      if (!valueId) throw new DnsError('recordId 格式无效', 400, 'INVALID_RECORD_ID');
      await execute('POST', '/v1/change_record_status/', {
        ids: JSON.stringify([valueId]), target: 'value', action: enabled ? 'enable' : 'stop',
      });
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(domain): Promise<DnsLine[] | null> {
      const data = await execute('GET', '/v1/zone/view/', { zone_name: domain.id, type: 'GET_FULL' });
      const rows = asArray(data.zone_views).map(asRecord);
      if (rows.length === 0) return null;
      return rows.map((row) => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? '') === '*' ? '默认' : String(row.name ?? ''),
        parent: null,
      }));
    },

    async minTtl(): Promise<number | null> {
      return 60;
    },
  };
}
