import { asArray, asRecord, num, sendJson } from '../http';
import { aliyunSignature } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord, type DnsRecordGroup, type DnsRecordLog,
  type DnsRecordInput, type DnsWeightStatusInput, type DnsWeightSubdomain, type PageResult, type RecordQuery,
} from '../types';

export interface AliyunConfig {
  AccessKeyId: string;
  AccessKeySecret: string;
}

const ENDPOINT = 'https://alidns.aliyuncs.com/';
const VERSION = '2015-01-09';

export function createAliyunProvider(config: AliyunConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function request(action: string, params: Record<string, string | number | undefined> = {}): Promise<Record<string, unknown>> {
    const query: Record<string, string> = {
      Format: 'JSON',
      Version: VERSION,
      AccessKeyId: config.AccessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Action: action,
    };
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query[key] = String(value);
    }
    query.Signature = await aliyunSignature(config.AccessKeySecret, query);
    const search = new URLSearchParams(Object.entries(query)).toString();
    const response = await sendJson(fetchImpl, `${ENDPOINT}?${search}`, { method: 'GET' });
    const payload = asRecord(response.body);
    if (!response.ok || payload.Code) {
      const message = typeof payload.Message === 'string' ? payload.Message : `阿里云 DNS 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.ok ? 502 : response.status);
    }
    return payload;
  }

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    const status = String(row.Status ?? '').toUpperCase() === 'ENABLE' ? 1 : 0;
    return {
      id: String(row.RecordId ?? ''),
      name: String(row.RR ?? '@'),
      type: String(row.Type ?? 'A'),
      value: String(row.Value ?? ''),
      line: String(row.Line ?? 'default'),
      ttl: num(row.TTL, 600),
      mx: row.Priority === undefined || row.Priority === null ? null : num(row.Priority),
      weight: row.Weight === undefined || row.Weight === null ? null : num(row.Weight),
      remark: typeof row.Remark === 'string' && row.Remark ? row.Remark : null,
      status: status as 0 | 1,
      updatedAt: typeof row.UpdateDate === 'string' ? row.UpdateDate : null,
    };
  }

  function domainOf(domain: DnsDomain): string {
    if (!domain.name) throw new DnsError('域名信息缺失', 409, 'DNS_DOMAIN_NOT_SYNCED');
    return domain.name;
  }

  return {
    type: 'aliyun',

    async check() {
      await request('DescribeDomains', { PageNumber: 1, PageSize: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('DescribeDomains', {
        PageNumber: page.page, PageSize: page.pageSize, ...(page.keyword ? { KeyWord: page.keyword } : {}),
      });
      const items = asArray(asRecord(data.Domains ?? {}).Domain).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.DomainId ?? ''), name: String(row.DomainName ?? ''), recordCount: num(row.RecordCount) };
      });
      return { total: num(data.TotalCount, items.length), items };
    },

    async addDomain(name) {
      await request('AddDomain', { DomainName: name });
      return { id: '', name, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const params: Record<string, string | number | undefined> = {
        DomainName: domainOf(domain),
        PageNumber: query.page,
        PageSize: query.pageSize,
      };
      if (query.name) params.RRKeyWord = query.name;
      if (query.type) params.TypeKeyWord = query.type === 'URL' ? 'REDIRECT_URL' : query.type;
      if (query.value) params.ValueKeyWord = query.value;
      if (query.line) params.Line = query.line;
      if (query.keyword) params.KeyWord = query.keyword;
      if (query.status) params.Status = query.status === '1' ? 'Enable' : 'Disable';
      if (query.name || query.value || query.type || query.line) params.SearchMode = 'ADVANCED';
      const data = await request('DescribeDomainRecords', params);
      const items = asArray(asRecord(data.DomainRecords ?? {}).Record).map((raw) => toRecord(raw, domain));
      return { total: num(data.TotalCount, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('AddDomainRecord', {
        DomainName: domainOf(domain),
        RR: input.name,
        Type: input.type === 'URL' ? 'REDIRECT_URL' : input.type,
        Value: input.value,
        Line: input.line || 'default',
        TTL: input.ttl,
        ...(input.type === 'MX' ? { Priority: input.mx ?? 10 } : {}),
      });
      return String(data.RecordId ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await request('UpdateDomainRecord', {
        RecordId: recordId,
        RR: input.name,
        Type: input.type === 'URL' ? 'REDIRECT_URL' : input.type,
        Value: input.value,
        Line: input.line || 'default',
        TTL: input.ttl,
        ...(input.type === 'MX' ? { Priority: input.mx ?? 10 } : {}),
      });
    },

    async deleteRecord(_domain, recordId) {
      await request('DeleteDomainRecord', { RecordId: recordId });
    },

    async setRecordStatus(_domain, recordId, enabled) {
      await request('SetDomainRecordStatus', { RecordId: recordId, Status: enabled ? 'Enable' : 'Disable' });
    },

    async setRecordRemark(_domain, recordId, remark) {
      await request('UpdateDomainRecordRemark', { RecordId: recordId, Remark: remark ?? '' });
    },

    async recordLines(domain): Promise<DnsLine[] | null> {
      const data = await request('DescribeDomainInfo', { DomainName: domainOf(domain), NeedDetailAttributes: 'true', Lang: 'zh' });
      const lines = asArray(asRecord(data.RecordLines ?? {}).RecordLine);
      if (lines.length === 0) return null;
      return lines.map((raw) => {
        const row = asRecord(raw);
        return {
          id: String(row.LineCode ?? 'default'),
          name: String(row.LineDisplayName ?? row.Line ?? '默认'),
          parent: typeof row.FatherCode === 'string' && row.FatherCode ? row.FatherCode : null,
        };
      });
    },

    async minTtl(domain): Promise<number | null> {
      const data = await request('DescribeDomainInfo', { DomainName: domainOf(domain) });
      return data.MinTtl === undefined ? null : num(data.MinTtl);
    },

    async recordLogs(domain, page): Promise<PageResult<DnsRecordLog>> {
      const data = await request('DescribeRecordLogs', {
        DomainName: domainOf(domain), PageNumber: page.page, PageSize: page.pageSize, Lang: 'zh',
      });
      const items = asArray(asRecord(data.RecordLogs ?? {}).RecordLog).map((raw) => {
        const row = asRecord(raw);
        const stamp = num(row.ActionTimestamp, 0);
        return {
          time: stamp > 0 ? new Date(stamp).toISOString() : null,
          action: String(row.Message ?? ''),
        };
      });
      return { total: num(data.TotalCount, items.length), items };
    },

    async listRecordGroups(domain): Promise<DnsRecordGroup[]> {
      const data = await request('DescribeRecordGroups', { DomainName: domainOf(domain), PageSize: 100, Lang: 'zh' });
      return asArray(asRecord(data.RecordGroups ?? {}).RecordGroup).map((raw) => {
        const row = asRecord(raw);
        return {
          id: String(row.GroupId ?? ''),
          name: String(row.GroupName ?? ''),
          count: row.RecordCount === undefined || row.RecordCount === null ? null : num(row.RecordCount),
        };
      }).filter((group) => group.id && group.name);
    },

    async changeRecordGroup(domain, recordIds, groupId) {
      if (recordIds.length === 0) throw new DnsError('记录编号不能为空', 400, 'INVALID_RECORD_IDS');
      if (!/^\d{1,20}$/.test(groupId)) throw new DnsError('分组编号无效', 400, 'INVALID_GROUP_ID');
      await request('ChangeRecordGroup', {
        DomainName: domainOf(domain), RecordIdList: JSON.stringify(recordIds), GroupId: groupId,
      });
    },

    async listWeightSubdomains(domain, page): Promise<PageResult<DnsWeightSubdomain>> {
      const data = await request('DescribeDNSSLBSubDomains', {
        DomainName: domainOf(domain), PageNumber: page.page, PageSize: page.pageSize,
        ...(page.keyword ? { Rr: page.keyword } : {}),
      });
      const zone = domainOf(domain);
      const items = asArray(asRecord(data.SlbSubDomains ?? {}).SlbSubDomain).map((raw) => {
        const row = asRecord(raw);
        const subdomain = String(row.SubDomain ?? '');
        const rr = subdomain === zone ? '@' : subdomain.endsWith(`.${zone}`) ? subdomain.slice(0, -zone.length - 1) : subdomain;
        return {
          subdomain, rr,
          type: String(row.Type ?? 'A'),
          line: String(row.Line ?? 'default'),
          count: num(row.RecordCount),
          enabled: row.Open === true || row.Open === 1 || row.Open === 'true' || row.Open === '1',
        };
      });
      return { total: num(data.TotalCount, items.length), items };
    },

    async setWeightStatus(domain, input: DnsWeightStatusInput) {
      await request('SetDNSSLBStatus', {
        DomainName: domainOf(domain),
        SubDomain: input.subdomain,
        Open: input.enabled ? 'true' : 'false',
        ...(input.type ? { Type: input.type } : {}),
        ...(input.line ? { Line: input.line } : {}),
      });
    },

    async updateRecordWeight(_domain, recordId, weight) {
      await request('UpdateDNSSLBWeight', { RecordId: recordId, Weight: weight });
    },
  };
}
