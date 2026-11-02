import { asArray, asRecord, num, sendJson } from '../http';
import { bceEscape, hexOf, hmacSha256Raw, sha256Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';

export interface HuoshanConfig {
  AccessKeyId: string;
  SecretAccessKey: string;
}

const HOST = 'open.volcengineapi.com';
const SERVICE = 'DNS';
const REGION = 'cn-north-1';
const VERSION = '2018-08-01';

const TRADE: Record<string, { level: number; ttl: number }> = {
  free_inner: { level: 1, ttl: 600 },
  professional_inner: { level: 2, ttl: 300 },
  enterprise_inner: { level: 3, ttl: 60 },
  ultimate_inner: { level: 4, ttl: 1 },
  ultimate_exclusive_inner: { level: 5, ttl: 1 },
};

export function createHuoshanProvider(config: HuoshanConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const zoneCache = new Map<string, Record<string, unknown>>();

  async function request(method: 'GET' | 'POST', action: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Record<string, unknown>> {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
    const query: Record<string, string> = { Action: action, Version: VERSION };
    let payload = '';
    if (method === 'GET') {
      for (const [key, value] of entries) query[key] = String(value);
    } else {
      payload = entries.length ? JSON.stringify(Object.fromEntries(entries.map(([key, value]) => [key, value]))) : '';
    }
    const canonicalQuery = Object.keys(query).sort()
      .map((key) => `${bceEscape(key)}=${bceEscape(query[key] ?? '')}`).join('&');
    const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const headers: Record<string, string> = { host: HOST, 'x-date': date };
    if (payload) headers['content-type'] = 'application/json';
    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = `${sortedKeys.map((key) => `${key}:${headers[key]}`).join('\n')}\n`;
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = [method, '/', canonicalQuery, canonicalHeaders, signedHeaders, await sha256Hex(payload)].join('\n');
    const shortDate = date.slice(0, 8);
    const scope = `${shortDate}/${REGION}/${SERVICE}/request`;
    const stringToSign = ['HMAC-SHA256', date, scope, await sha256Hex(canonicalRequest)].join('\n');
    const kDate = await hmacSha256Raw(new TextEncoder().encode(config.SecretAccessKey), shortDate);
    const kRegion = await hmacSha256Raw(kDate, REGION);
    const kService = await hmacSha256Raw(kRegion, SERVICE);
    const kSigning = await hmacSha256Raw(kService, 'request');
    const signature = hexOf(await hmacSha256Raw(kSigning, stringToSign));
    headers.Authorization = `HMAC-SHA256 Credential=${config.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await sendJson(fetchImpl, `https://${HOST}/?${canonicalQuery}`, {
      method, headers, ...(payload ? { body: payload } : {}),
    });
    const data = asRecord(response.body ?? {});
    const meta = asRecord(data.ResponseMetadata ?? {});
    const error = asRecord(meta.Error ?? {});
    if (!response.ok || Object.keys(error).length > 0) {
      const message = String(error.MessageCN ?? error.Message ?? `火山引擎 DNS 请求失败（HTTP ${response.status}）`);
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    return meta === undefined ? data : (data.Result === undefined ? data : asRecord(data.Result));
  }

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    const type = String(row.Type ?? 'A').toUpperCase();
    let value = String(row.Value ?? '');
    let mx: number | null = null;
    if (type === 'MX') {
      const [priority, ...rest] = value.split(' ');
      mx = Number(priority) || 0;
      value = rest.join(' ');
    }
    return {
      id: String(row.RecordID ?? ''),
      name: String(row.Host ?? '@') || '@',
      type,
      value,
      line: String(row.Line ?? 'default') || 'default',
      ttl: num(row.TTL, 600),
      mx,
      weight: row.Weight === undefined || row.Weight === null ? null : num(row.Weight),
      remark: typeof row.Remark === 'string' && row.Remark ? row.Remark : null,
      status: row.Enable ? 1 : 0,
      updatedAt: typeof row.UpdatedAt === 'string' ? row.UpdatedAt : null,
    };
  }

  async function zone(domain: DnsDomain): Promise<Record<string, unknown>> {
    const cached = zoneCache.get(domain.id);
    if (cached) return cached;
    const data = await request('GET', 'QueryZone', { ZID: Number(domain.id) || 0 });
    zoneCache.set(domain.id, data);
    return data;
  }

  function recordBody(input: DnsRecordInput): Record<string, unknown> {
    return {
      Host: input.name,
      Type: input.type,
      Value: input.type === 'MX' ? `${input.mx ?? 10} ${input.value}` : input.value,
      Line: input.line === 'default' ? 'default' : input.line,
      TTL: input.ttl,
      ...(input.remark ? { Remark: input.remark } : {}),
      ...(input.weight && input.weight > 0 ? { Weight: input.weight } : {}),
    };
  }

  return {
    type: 'huoshan',

    async check() {
      await request('GET', 'ListZones', { PageNumber: 1, PageSize: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('GET', 'ListZones', {
        PageNumber: page.page, PageSize: page.pageSize, Key: page.keyword,
      });
      const items = asArray(data.Zones).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.ZID ?? ''), name: String(row.ZoneName ?? ''), recordCount: num(row.RecordCount) };
      });
      return { total: num(data.Total, items.length), items };
    },

    async addDomain(name) {
      const data = await request('POST', 'CreateZone', { ZoneName: name });
      return { id: String(data.ZID ?? ''), name: String(data.ZoneName ?? name), recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const params: Record<string, string | number | undefined> = {
        ZID: Number(domain.id) || 0,
        PageNumber: query.page,
        PageSize: query.pageSize,
        SearchOrder: 'desc',
      };
      if (query.name || query.type || query.line || query.value) {
        params.Host = query.name;
        params.Value = query.value;
        params.Type = query.type;
        params.Line = query.line;
        params.SearchMode = 'exact';
      } else if (query.keyword) {
        params.Host = query.keyword;
      }
      const data = await request('GET', 'ListRecords', params);
      let items = asArray(data.Records).map((raw) => toRecord(raw, domain));
      if (query.status) items = items.filter((record) => String(record.status) === query.status);
      return { total: num(data.TotalCount, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('POST', 'CreateRecord', { ZID: Number(domain.id) || 0, ...recordBody(input) });
      return String(data.RecordID ?? '');
    },

    async updateRecord(_domain, recordId, input) {
      await request('POST', 'UpdateRecord', { RecordID: recordId, ...recordBody(input) });
    },

    async deleteRecord(_domain, recordId) {
      await request('POST', 'DeleteRecord', { RecordID: recordId });
    },

    async setRecordStatus(_domain, recordId, enabled) {
      await request('POST', 'UpdateRecordStatus', { RecordID: recordId, Enable: enabled });
    },

    async setRecordRemark() {
      throw new DnsError('火山引擎需在编辑记录时一并提交备注，请使用编辑功能', 400, 'DNS_REMARK_REQUIRES_EDIT');
    },

    async recordLines(domain): Promise<DnsLine[] | null> {
      const info = await zone(domain);
      const code = String(info.TradeCode ?? '');
      const level = (TRADE[code] ?? TRADE.free_inner!).level;
      const data = await request('GET', 'ListLines', {});
      const lines: DnsLine[] = [{ id: 'default', name: '默认', parent: null }];
      for (const raw of asArray(data.Lines)) {
        const row = asRecord(raw);
        const value = String(row.Value ?? '');
        if (!value || value === 'default' || num(row.Level) > level) continue;
        lines.push({
          id: value,
          name: String(row.Name ?? value),
          parent: row.FatherValue ? String(row.FatherValue) : null,
        });
      }
      const custom = await request('GET', 'ListCustomLines', {});
      if (num(custom.TotalCount) > 0) {
        lines.push({ id: 'N.customer_lines', name: '自定义线路', parent: null });
        for (const raw of asArray(custom.CustomerLines)) {
          const row = asRecord(raw);
          lines.push({ id: String(row.Line ?? ''), name: String(row.NameCN ?? row.Line ?? ''), parent: 'N.customer_lines' });
        }
      }
      return lines;
    },

    async minTtl(domain): Promise<number | null> {
      const info = await zone(domain);
      const code = String(info.TradeCode ?? '');
      return (TRADE[code] ?? TRADE.free_inner!).ttl;
    },
  };
}
