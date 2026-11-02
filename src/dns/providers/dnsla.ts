import { asArray, asRecord, num, sendJson } from '../http';
import { base64Encode } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface DnslaConfig {
  apiid: string;
  apisecret: string;
}

const BASE = 'https://api.dns.la';

/** DNSLA 使用数字化类型编号，256 表示 URL 转发。 */
const TYPE_BY_ID: Record<number, string> = {
  1: 'A', 2: 'NS', 5: 'CNAME', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 257: 'CAA',
};
const ID_BY_TYPE: Record<string, number> = {
  ...Object.fromEntries(Object.entries(TYPE_BY_ID).map(([id, type]) => [type, Number(id)])),
  URL: 256, REDIRECT_URL: 256, FORWARD_URL: 256,
};

export function createDnslaProvider(config: DnslaConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const authorization = `Basic ${base64Encode(`${config.apiid}:${config.apisecret}`)}`;

  async function execute(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const url = method === 'GET' || method === 'DELETE'
      ? `${BASE}${path}${search.size ? `?${search.toString()}` : ''}`
      : `${BASE}${path}`;
    const response = await sendJson(fetchImpl, url, {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json; charset=utf-8' },
      ...(method === 'POST' || method === 'PUT' ? { body: JSON.stringify(params) } : {}),
    });
    const payload = asRecord(response.body);
    if (!response.ok || num(payload.code, 0) !== 200) {
      const message = typeof payload.msg === 'string' && payload.msg ? payload.msg : `DNSLA 接口请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 ? 401 : response.ok ? 502 : response.status);
    }
    return payload.data;
  }

  const typeId = (type: string) => {
    const id = ID_BY_TYPE[type];
    if (!id) throw new DnsError(`DNSLA 不支持记录类型 ${type}`, 400, 'DNS_UNSUPPORTED_RECORD_TYPE');
    return id;
  };

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    const numeric = num(row.type, 1);
    const line = typeof row.lineId === 'string' ? row.lineId : '';
    const type = numeric === 256
      ? (row.dominant === false ? 'FORWARD_URL' : 'REDIRECT_URL')
      : TYPE_BY_ID[numeric] ?? 'A';
    return {
      id: String(row.id ?? ''),
      name: String(row.host ?? '@') || '@',
      type,
      value: String(row.data ?? ''),
      line: line === '' || line === '0' ? 'default' : line,
      ttl: num(row.ttl, 600),
      mx: row.preference === undefined || row.preference === null ? null : num(row.preference),
      weight: row.weight === undefined || row.weight === null ? null : num(row.weight),
      remark: null,
      status: row.disable ? 0 : 1,
      updatedAt: row.updatedAt ? new Date(num(row.updatedAt) * 1000).toISOString() : null,
    };
  }

  const lineOf = (value: string) => (value === 'default' ? '' : value);

  return {
    type: 'dnsla',

    async check() {
      await execute('GET', '/api/domainList', { pageIndex: 1, pageSize: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = asRecord(await execute('GET', '/api/domainList', { pageIndex: page.page, pageSize: page.pageSize }));
      const items = asArray(data.results).map((raw) => {
        const row = asRecord(raw);
        return {
          id: String(row.id ?? ''),
          name: String(row.displayDomain ?? '').replace(/\.$/, ''),
          recordCount: 0,
        };
      });
      return { total: num(data.total, items.length), items };
    },

    async addDomain(name) {
      const data = asRecord(await execute('POST', '/api/domain', { domain: name }));
      return { id: String(data.id ?? ''), name, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const params: Record<string, unknown> = {
        domainId: domain.id,
        pageIndex: query.page,
        pageSize: query.pageSize,
      };
      if (query.name ?? query.keyword) params.host = query.name ?? query.keyword;
      if (query.type) params.type = typeId(query.type);
      if (query.line) params.lineId = lineOf(query.line);
      if (query.value) params.data = query.value;
      const data = asRecord(await execute('GET', '/api/recordList', params));
      const items = asArray(data.results).map((raw) => toRecord(raw, domain));
      return { total: num(data.total, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const params: Record<string, unknown> = {
        domainId: domain.id,
        type: typeId(input.type),
        host: input.name,
        data: input.value,
        ttl: input.ttl,
        lineId: lineOf(input.line),
      };
      if (input.type === 'MX') params.preference = input.mx ?? 10;
      if (typeId(input.type) === 256) params.dominant = input.type !== 'FORWARD_URL';
      if (input.weight && input.weight > 0) params.weight = input.weight;
      const data = asRecord(await execute('POST', '/api/record', params));
      return String(data.id ?? '');
    },

    async updateRecord(_domain, recordId, input) {
      const params: Record<string, unknown> = {
        id: recordId,
        type: typeId(input.type),
        host: input.name,
        data: input.value,
        ttl: input.ttl,
        lineId: lineOf(input.line),
      };
      if (input.type === 'MX') params.preference = input.mx ?? 10;
      if (typeId(input.type) === 256) params.dominant = input.type !== 'FORWARD_URL';
      if (input.weight && input.weight > 0) params.weight = input.weight;
      await execute('PUT', '/api/record', params);
    },

    async deleteRecord(_domain, recordId) {
      await execute('DELETE', '/api/record', { id: recordId });
    },

    async setRecordStatus(_domain, recordId, enabled) {
      await execute('PUT', '/api/recordDisable', { id: recordId, disable: !enabled });
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(domain): Promise<DnsLine[] | null> {
      const data = await execute('GET', '/api/availableLine', { domain: domain.name });
      const rows = asArray(data).map(asRecord)
        .sort((left, right) => num(left.order) - num(right.order));
      if (rows.length === 0) return null;
      return rows.map((row) => {
        const id = String(row.id ?? '');
        return {
          id: id === '0' || id === '' ? 'default' : id,
          name: String(row.value ?? '默认'),
          parent: row.pid ? String(row.pid) : null,
        };
      });
    },

    async minTtl(domain): Promise<number | null> {
      const data = asRecord(await execute('GET', '/api/dnsMeasures', { id: domain.id }));
      return data.minTTL === undefined || data.minTTL === null ? null : num(data.minTTL);
    },
  };
}
