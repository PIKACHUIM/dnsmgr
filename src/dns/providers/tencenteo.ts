import { asArray, asRecord, num, sendJson } from '../http';
import { tencentAuthorization } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface TencentEoConfig {
  SecretId: string;
  SecretKey: string;
  site_type?: string;
}

const VERSION = '2022-09-01';

export function createTencentEoProvider(config: TencentEoConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const host = config.site_type === 'intl' ? 'teo.intl.tencentcloudapi.com' : 'teo.tencentcloudapi.com';

  async function request(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const authorization = await tencentAuthorization({
      secretId: config.SecretId,
      secretKey: config.SecretKey,
      service: 'teo',
      host,
      action,
      version: VERSION,
      payload: body,
      timestamp,
    });
    const response = await sendJson(fetchImpl, `https://${host}/`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': action,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': String(timestamp),
      },
      body,
    });
    const envelope = asRecord(response.body ?? {});
    const error = asRecord(envelope.Response ?? {});
    const detail = asRecord(error.Error ?? {});
    if (!response.ok || Object.keys(detail).length > 0) {
      const message = String(detail.Message ?? `腾讯云 EdgeOne 请求失败（HTTP ${response.status}）`);
      throw new DnsError(message, String(detail.Code ?? '').startsWith('AuthFailure') ? 401 : 502);
    }
    return asRecord(error);
  }

  const relativeName = (full: string, domain: string) => {
    if (full === domain) return '@';
    const suffix = `.${domain}`;
    return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
  };

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    return {
      id: String(row.RecordId ?? ''),
      name: relativeName(String(row.Name ?? ''), domain.name),
      type: String(row.Type ?? 'A').toUpperCase(),
      value: String(row.Content ?? ''),
      line: String(row.Location ?? 'Default') || 'Default',
      ttl: num(row.TTL, 600),
      mx: row.Priority === undefined || row.Priority === null ? null : num(row.Priority),
      weight: num(row.Weight, -1) === -1 ? null : num(row.Weight),
      remark: typeof row.Remark === 'string' && row.Remark ? row.Remark : null,
      status: String(row.Status ?? '') === 'enable' ? 1 : 0,
      updatedAt: typeof row.ModifiedOn === 'string' ? row.ModifiedOn : null,
    };
  }

  const fqdn = (name: string, domain: string) => (name === '@' ? domain : `${name}.${domain}`);

  function recordBody(domain: DnsDomain, input: DnsRecordInput): Record<string, unknown> {
    return {
      ZoneId: domain.id,
      Name: fqdn(input.name, domain.name),
      Type: input.type,
      Content: input.value,
      Location: input.line === 'default' ? 'Default' : input.line,
      TTL: input.ttl,
      Weight: input.weight ?? -1,
      ...(input.type === 'MX' ? { Priority: input.mx ?? 10 } : {}),
    };
  }

  return {
    type: 'tencenteo',

    async check() {
      await request('DescribeZones', { Offset: 0, Limit: 1, Filters: [{ Name: 'zone-type', Values: ['full'] }] });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const filters: unknown[] = [{ Name: 'zone-type', Values: ['full'] }];
      if (page.keyword) filters.push({ Name: 'zone-name', Values: [page.keyword] });
      const data = await request('DescribeZones', {
        Offset: (page.page - 1) * page.pageSize, Limit: page.pageSize, Filters: filters,
      });
      const items = asArray(data.Zones).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.ZoneId ?? ''), name: String(row.ZoneName ?? ''), recordCount: 0 };
      });
      return { total: num(data.TotalCount, items.length), items };
    },

    async addDomain() {
      unsupported('在 EdgeOne 中新建站点');
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const filters: unknown[] = [];
      const name = query.name ?? query.keyword;
      if (name) filters.push({ Name: 'name', Values: [fqdn(name, domain.name)] });
      if (query.value) filters.push({ Name: 'content', Values: [query.value], Fuzzy: true });
      if (query.type) filters.push({ Name: 'type', Values: [query.type] });
      const data = await request('DescribeDnsRecords', {
        ZoneId: domain.id,
        Offset: (query.page - 1) * query.pageSize,
        Limit: query.pageSize,
        Filters: filters,
      });
      let items = asArray(data.DnsRecords).map((raw) => toRecord(raw, domain));
      if (query.status) items = items.filter((record) => String(record.status) === query.status);
      return { total: num(data.TotalCount, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('CreateDnsRecord', recordBody(domain, input));
      return String(data.RecordId ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await request('ModifyDnsRecord', { ...recordBody(domain, input), DnsRecordId: recordId });
    },

    async deleteRecord(domain, recordId) {
      await request('DeleteDnsRecords', { ZoneId: domain.id, RecordIds: [recordId] });
    },

    async setRecordStatus(domain, recordId, enabled) {
      await request('ModifyDnsRecordsStatus', {
        ZoneId: domain.id,
        ...(enabled ? { RecordsToEnable: [recordId] } : { RecordsToDisable: [recordId] }),
      });
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return [{ id: 'Default', name: '默认', parent: null }];
    },

    async minTtl(): Promise<number | null> {
      return 60;
    },
  };
}
