import { asArray, asRecord, num, sendJson } from '../http';
import { bceEscape, hmacSha256Hex, sha256Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';

export interface HuaweiConfig {
  AccessKeyId: string;
  SecretAccessKey: string;
}

const HOST = 'dns.myhuaweicloud.com';

export function createHuaweiProvider(config: HuaweiConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function request(method: string, path: string, query: Record<string, string | number | undefined> = {}, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entries = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const canonicalQuery = entries.map(([key, value]) => `${bceEscape(key)}=${bceEscape(value)}`).join('&');
    const payload = body ? JSON.stringify(body) : '';
    const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const headers: Record<string, string> = { host: HOST, 'x-sdk-date': date };
    if (payload) headers['content-type'] = 'application/json';

    const canonicalUri = `${path.split('/').map(bceEscape).join('/')}${path.endsWith('/') ? '' : '/'}`;
    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = `${sortedKeys.map((key) => `${key}:${headers[key]}`).join('\n')}\n`;
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, await sha256Hex(payload)].join('\n');
    const signature = await hmacSha256Hex(config.SecretAccessKey, ['SDK-HMAC-SHA256', date, await sha256Hex(canonicalRequest)].join('\n'));
    headers.Authorization = `SDK-HMAC-SHA256 Access=${config.AccessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await sendJson(fetchImpl, `https://${HOST}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`, {
      method, headers, ...(payload ? { body: payload } : {}),
    });
    const data = response.body === null || response.body === undefined ? {} : asRecord(response.body);
    if (!response.ok || data.error_msg || data.message) {
      const message = String(data.error_msg ?? data.message ?? `华为云 DNS 请求失败（HTTP ${response.status}）`);
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    return data;
  }

  const hostName = (name: string, domain: string) => `${name === '@' ? '' : `${name}.`}${domain}.`;

  const relativeName = (full: string, domain: string) => {
    const suffix = `.${domain}.`;
    if (full === `${domain}.`) return '@';
    return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full.replace(/\.$/, '');
  };

  const recordValue = (type: string, value: string) => {
    if (type !== 'TXT' || value.startsWith('"')) return value;
    return `"${value}"`;
  };

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    const type = String(row.type ?? 'A').toUpperCase();
    const value = Array.isArray(row.records) ? row.records.map(String).join(',') : String(row.records ?? '');
    return {
      id: String(row.id ?? ''),
      name: relativeName(String(row.name ?? ''), domain.name),
      type,
      value,
      line: String(row.line ?? 'default') || 'default',
      ttl: num(row.ttl, 300),
      mx: row.mx === undefined || row.mx === null ? null : num(row.mx),
      weight: row.weight === undefined || row.weight === null ? null : num(row.weight),
      remark: typeof row.description === 'string' && row.description ? row.description : null,
      status: String(row.status ?? '') === 'ACTIVE' ? 1 : 0,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    };
  }

  const zonePath = (domain: DnsDomain) => `/v2.1/zones/${encodeURIComponent(domain.id)}/recordsets`;

  function recordBody(input: DnsRecordInput, domain: string): Record<string, unknown> {
    return {
      name: hostName(input.name, domain),
      type: input.type,
      records: [recordValue(input.type, input.value)],
      line: input.line === 'default' ? undefined : input.line,
      ttl: input.ttl,
      ...(input.remark ? { description: input.remark } : {}),
      ...(input.weight && input.weight > 0 ? { weight: input.weight } : {}),
    };
  }

  return {
    type: 'huawei',

    async check() {
      await request('GET', '/v2/zones', { offset: 0, limit: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('GET', '/v2/zones', {
        offset: (page.page - 1) * page.pageSize, limit: page.pageSize, name: page.keyword,
      });
      const items = asArray(data.zones).map((raw) => {
        const row = asRecord(raw);
        return {
          id: String(row.id ?? ''),
          name: String(row.name ?? '').replace(/\.$/, ''),
          recordCount: num(row.record_num),
        };
      });
      return { total: num(asRecord(data.metadata ?? {}).total_count, items.length), items };
    },

    async addDomain(name) {
      const data = await request('POST', '/v2/zones', {}, { name: `${name}.` });
      return { id: String(data.id ?? ''), name: String(data.name ?? name).replace(/\.$/, ''), recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const params: Record<string, string | number | undefined> = {
        offset: (query.page - 1) * query.pageSize,
        limit: query.pageSize,
        type: query.type,
        line_id: query.line,
        records: query.value,
        name: query.name ? hostName(query.name, domain.name) : query.keyword,
      };
      if (query.name) params.search_mode = 'equal';
      if (query.status) params.status = query.status === '1' ? 'ACTIVE' : 'DISABLE';
      const data = await request('GET', zonePath(domain), params);
      const items = asArray(data.recordsets).map((raw) => toRecord(raw, domain))
        .filter((record) => !query.name || record.name.toLowerCase() === query.name.toLowerCase());
      return { total: num(asRecord(data.metadata ?? {}).total_count, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('POST', zonePath(domain), {}, recordBody(input, domain.name));
      return String(data.id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await request('PUT', `${zonePath(domain)}/${encodeURIComponent(recordId)}`, {}, recordBody(input, domain.name));
    },

    async deleteRecord(domain, recordId) {
      await request('DELETE', `${zonePath(domain)}/${encodeURIComponent(recordId)}`);
    },

    async setRecordStatus(_domain, recordId, enabled) {
      await request('PUT', `/v2.1/recordsets/${encodeURIComponent(recordId)}/statuses/set`, {}, {
        status: enabled ? 'ENABLE' : 'DISABLE',
      });
    },

    async setRecordRemark() {
      throw new DnsError('华为云需在编辑记录时一并提交备注，请使用编辑功能', 400, 'DNS_REMARK_REQUIRES_EDIT');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return null;
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
