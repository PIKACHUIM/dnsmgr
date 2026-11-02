import { asArray, asRecord, num, sendJson } from '../http';
import { md5Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface DnsmgrConfig {
  base_url: string;
  uid: string;
  key: string;
}

export function createDnsmgrProvider(config: DnsmgrConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const base = config.base_url.replace(/\/+$/, '');
  const infoCache = new Map<string, Record<string, unknown>>();

  async function request(path: string, params: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) form.set(key, String(value));
    form.set('uid', config.uid);
    form.set('timestamp', timestamp);
    form.set('sign', md5Hex(`${config.uid}${timestamp}${config.key}`));
    const response = await sendJson(fetchImpl, `${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const payload = asRecord(response.body ?? {});
    if (!response.ok) throw new DnsError(`DNSMGR 接口请求失败（HTTP ${response.status}）`, response.status === 401 ? 401 : 502);
    if (payload.code !== undefined && num(payload.code, -1) === 0) {
      const data = payload.data;
      return data === null || data === undefined ? {} : asRecord(data);
    }
    if (payload.rows !== undefined && payload.total !== undefined) return payload;
    throw new DnsError(String(payload.msg ?? 'DNSMGR 接口返回异常'), 502);
  }

  function toRecord(raw: unknown): DnsRecord {
    const row = asRecord(raw);
    return {
      id: String(row.RecordId ?? ''),
      name: String(row.Name ?? '@') || '@',
      type: String(row.Type ?? 'A').toUpperCase(),
      value: String(row.Value ?? ''),
      line: String(row.Line ?? 'default') || 'default',
      ttl: num(row.TTL, 600),
      mx: row.MX === undefined || row.MX === null || row.MX === '' ? null : num(row.MX),
      weight: row.Weight === undefined || row.Weight === null || row.Weight === '' ? null : num(row.Weight),
      remark: typeof row.Remark === 'string' && row.Remark ? row.Remark : null,
      status: String(row.Status ?? '1') === '1' ? 1 : 0,
      updatedAt: typeof row.UpdateTime === 'string' ? row.UpdateTime : null,
    };
  }

  async function domainInfo(domain: DnsDomain): Promise<Record<string, unknown>> {
    const cached = infoCache.get(domain.id);
    if (cached) return cached;
    const data = await request(`/api/domain/${encodeURIComponent(domain.id)}`, { loginurl: 0 });
    infoCache.set(domain.id, data);
    return data;
  }

  function recordBody(input: DnsRecordInput): Record<string, string | number> {
    return {
      name: input.name,
      type: input.type,
      value: input.value,
      line: input.line,
      ttl: input.ttl,
      ...(input.type === 'MX' && input.mx !== null ? { mx: input.mx } : {}),
      ...(input.weight !== null ? { weight: input.weight } : {}),
      ...(input.remark ? { remark: input.remark } : {}),
    };
  }

  return {
    type: 'dnsmgr',

    async check() {
      await request('/api/domain', { offset: 0, limit: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('/api/domain', {
        offset: (page.page - 1) * page.pageSize, limit: page.pageSize,
        ...(page.keyword ? { kw: page.keyword } : {}),
      });
      const items = asArray(data.rows).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.id ?? ''), name: String(row.name ?? ''), recordCount: num(row.recordcount) };
      });
      return { total: num(data.total, items.length), items };
    },

    async addDomain() {
      unsupported('在 DNSMGR 面板中新建域名');
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const data = await request(`/api/record/data/${encodeURIComponent(domain.id)}`, {
        offset: (query.page - 1) * query.pageSize,
        limit: query.pageSize,
        ...(query.keyword ? { keyword: query.keyword } : {}),
        ...(query.name ? { subdomain: query.name } : {}),
        ...(query.value ? { value: query.value } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.line ? { line: query.line } : {}),
        ...(query.status ? { status: query.status } : {}),
      });
      return { total: num(data.total), items: asArray(data.rows).map(toRecord) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request(`/api/record/add/${encodeURIComponent(domain.id)}`, recordBody(input));
      return String(data.RecordId ?? data.id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await request(`/api/record/update/${encodeURIComponent(domain.id)}`, { recordid: recordId, ...recordBody(input) });
    },

    async deleteRecord(domain, recordId) {
      await request(`/api/record/delete/${encodeURIComponent(domain.id)}`, { recordid: recordId });
    },

    async setRecordStatus(domain, recordId, enabled) {
      await request(`/api/record/status/${encodeURIComponent(domain.id)}`, {
        recordid: recordId, status: enabled ? '1' : '0',
      });
    },

    async setRecordRemark(domain, recordId, remark) {
      await request(`/api/record/remark/${encodeURIComponent(domain.id)}`, {
        recordid: recordId, remark: remark ?? '',
      });
    },

    async recordLines(domain): Promise<DnsLine[] | null> {
      const info = await domainInfo(domain);
      if (!Array.isArray(info.recordLine)) return null;
      const lines = info.recordLine.map((raw) => {
        const row = asRecord(raw);
        return {
          id: String(row.id ?? ''),
          name: String(row.name ?? row.id ?? ''),
          parent: row.parent === undefined || row.parent === null ? null : String(row.parent),
        };
      });
      return lines.length ? lines : null;
    },

    async minTtl(domain): Promise<number | null> {
      const info = await domainInfo(domain);
      return info.minTTL === undefined || info.minTTL === null ? null : num(info.minTTL);
    },
  };
}
