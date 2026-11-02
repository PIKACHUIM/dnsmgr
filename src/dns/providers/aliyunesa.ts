import { asArray, asRecord, num, sendJson } from '../http';
import { aliyunSignature } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface AliyunEsaConfig {
  AccessKeyId: string;
  AccessKeySecret: string;
  region?: string;
}

const VERSION = '2024-09-10';

export function createAliyunEsaProvider(config: AliyunEsaConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const host = config.region ? `esa.${config.region}.aliyuncs.com` : 'esa.cn-hangzhou.aliyuncs.com';

  async function request(action: string, params: Record<string, string | number | boolean | undefined> = {}, method: 'GET' | 'POST' = 'GET'): Promise<Record<string, unknown>> {
    const all: Record<string, string> = {
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
      if (value !== undefined && value !== null && value !== '') all[key] = String(value);
    }
    all.Signature = await aliyunSignature(config.AccessKeySecret, all, method);
    const form = new URLSearchParams(all).toString();
    const response = method === 'GET'
      ? await sendJson(fetchImpl, `https://${host}/?${form}`, { method: 'GET' })
      : await sendJson(fetchImpl, `https://${host}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
    const payload = asRecord(response.body ?? {});
    if (!response.ok || payload.Code) {
      const message = typeof payload.Message === 'string' ? payload.Message : `阿里云 ESA 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 400 && String(payload.Code ?? '').includes('Unauthorized') ? 401 : 502);
    }
    return payload;
  }

  const relativeName = (full: string, domain: string) => {
    if (full === domain) return '@';
    const suffix = `.${domain}`;
    return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
  };

  const fqdn = (name: string, domain: string) => (name === '@' ? domain : `${name}.${domain}`);

  const isIpv4 = (value: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
  const isIpv6 = (value: string) => value.includes(':');

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    const data = asRecord(row.Data ?? {});
    let type = String(row.RecordType ?? 'A').toUpperCase();
    let value = String(data.Value ?? '');
    if (type === 'CAA') value = `${data.Flag ?? 0} ${data.Tag ?? 'issue'} ${data.Value ?? ''}`;
    else if (type === 'SRV') value = `${data.Priority ?? 0} ${data.Weight ?? 0} ${data.Port ?? 0} ${data.Value ?? ''}`;
    else if (type === 'A/AAAA') type = isIpv4(value) ? 'A' : isIpv6(value) ? 'AAAA' : 'A';
    return {
      id: String(row.RecordId ?? ''),
      name: relativeName(String(row.RecordName ?? ''), domain.name),
      type,
      value,
      line: row.Proxied ? '1' : '0',
      ttl: num(row.Ttl, 600),
      mx: data.Priority === undefined || data.Priority === null ? null : num(data.Priority),
      weight: null,
      remark: typeof row.Comment === 'string' && row.Comment ? row.Comment : null,
      status: 1,
      updatedAt: typeof row.UpdateTime === 'string' ? row.UpdateTime : null,
    };
  }

  function structuredData(type: string, value: string, mx: number | null): Record<string, unknown> {
    if (type === 'CAA') {
      const [flag, tag, ...rest] = value.split(' ');
      return { Flag: Number(flag) || 0, Tag: tag ?? 'issue', Value: rest.join(' ') };
    }
    if (type === 'SRV') {
      const [priority, weight, port, ...rest] = value.split(' ');
      return { Priority: Number(priority) || 0, Weight: Number(weight) || 0, Port: Number(port) || 0, Value: rest.join(' ') };
    }
    if (type === 'MX') return { Value: value, Priority: mx ?? 10 };
    return { Value: value };
  }

  function recordParams(domain: DnsDomain, input: DnsRecordInput): Record<string, string | number | boolean> {
    const proxied = input.line === '1';
    const type = input.type === 'A' || input.type === 'AAAA' ? 'A/AAAA' : input.type;
    return {
      RecordName: fqdn(input.name, domain.name),
      Type: type,
      Proxied: proxied,
      Ttl: input.ttl,
      Data: JSON.stringify(structuredData(input.type, input.value, input.mx)),
      ...(input.remark ? { Comment: input.remark } : {}),
      ...(proxied ? { BizName: 'web' } : {}),
    };
  }

  return {
    type: 'aliyunesa',

    async check() {
      await request('ListSites', { PageNumber: 1, PageSize: 1, AccessType: 'NS' });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('ListSites', {
        SiteName: page.keyword, PageNumber: page.page, PageSize: page.pageSize, AccessType: 'NS',
      });
      const items = asArray(data.Sites).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.SiteId ?? ''), name: String(row.SiteName ?? ''), recordCount: 0 };
      });
      return { total: num(data.TotalCount, items.length), items };
    },

    async addDomain() {
      unsupported('在阿里云 ESA 中新建站点');
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const params: Record<string, string | number | boolean> = {
        SiteId: domain.id, PageNumber: query.page, PageSize: query.pageSize,
      };
      const name = query.name ?? query.keyword;
      if (name) params.RecordName = fqdn(name, domain.name);
      if (query.type) params.Type = query.type === 'A' || query.type === 'AAAA' ? 'A/AAAA' : query.type;
      if (query.line === '0' || query.line === '1') params.Proxied = query.line === '1';
      const data = await request('ListRecords', params);
      return { total: num(data.TotalCount), items: asArray(data.Records).map((raw) => toRecord(raw, domain)) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('CreateRecord', { SiteId: domain.id, ...recordParams(domain, input) }, 'POST');
      return String(data.RecordId ?? '');
    },

    async updateRecord(domain, recordId, input) {
      const params = recordParams(domain, input);
      delete params.RecordName;
      await request('UpdateRecord', { RecordId: recordId, ...params }, 'POST');
    },

    async deleteRecord(_domain, recordId) {
      await request('DeleteRecord', { RecordId: recordId }, 'POST');
    },

    async setRecordStatus() {
      unsupported('启用或停用解析记录');
    },

    async setRecordRemark() {
      unsupported('单独设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return [
        { id: '0', name: '仅 DNS', parent: null },
        { id: '1', name: '已代理', parent: null },
      ];
    },

    async minTtl(): Promise<number | null> {
      return 1;
    },
  };
}
