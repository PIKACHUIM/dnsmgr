import { asArray, asRecord, num, sendJson } from '../http';
import { bceEscape, hexOf, hmacSha256Raw, sha256Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface JdcloudConfig {
  AccessKeyId: string;
  AccessKeySecret: string;
}

const HOST = 'domainservice.jdcloud-api.com';
const SERVICE = 'domainservice';
const REGION = 'cn-north-1';
const ALGORITHM = 'JDCLOUD2-HMAC-SHA256';

export function createJdcloudProvider(config: JdcloudConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function request(method: string, action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
    const query = method === 'GET' || method === 'DELETE'
      ? entries.map(([key, value]) => [key, String(value)] as const)
      : [];
    const body = method === 'GET' || method === 'DELETE'
      ? ''
      : entries.length ? JSON.stringify(Object.fromEntries(entries.map(([key, value]) => [key, value]))) : '';
    const path = `/v2/regions/${REGION}${action}`;
    const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const headers: Record<string, string> = {
      host: HOST,
      'x-jdcloud-algorithm': ALGORITHM,
      'x-jdcloud-date': date,
      'x-jdcloud-nonce': crypto.randomUUID(),
    };
    if (body) headers['content-type'] = 'application/json';

    const canonicalQuery = [...query].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${bceEscape(key)}=${bceEscape(value)}`).join('&');
    const sortedKeys = Object.keys(headers).sort();
    const canonicalHeaders = `${sortedKeys.map((key) => `${key}:${(headers[key] ?? '').trim()}`).join('\n')}\n`;
    const signedHeaders = sortedKeys.join(';');
    const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, await sha256Hex(body)].join('\n');

    const shortDate = date.slice(0, 8);
    const scope = `${shortDate}/${REGION}/${SERVICE}/jdcloud2_request`;
    const stringToSign = [ALGORITHM, date, scope, await sha256Hex(canonicalRequest)].join('\n');
    const kDate = await hmacSha256Raw(new TextEncoder().encode(`JDCLOUD2${config.AccessKeySecret}`), shortDate);
    const kRegion = await hmacSha256Raw(kDate, REGION);
    const kService = await hmacSha256Raw(kRegion, SERVICE);
    const kSigning = await hmacSha256Raw(kService, 'jdcloud2_request');
    const signature = hexOf(await hmacSha256Raw(kSigning, stringToSign));
    headers.authorization = `${ALGORITHM} Credential=${config.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `https://${HOST}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    const response = await sendJson(fetchImpl, url, { method, headers, ...(body ? { body } : {}) });
    if (!response.ok) {
      const error = asRecord(asRecord(response.body ?? {}).error ?? {});
      const message = typeof error.message === 'string' ? error.message : `京东云 DNS 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    const payload = asRecord(response.body ?? {});
    return payload.result === undefined ? payload : asRecord(payload.result);
  }

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    const type = String(row.type ?? 'A').toUpperCase();
    const normalized = type === 'EXPLICIT_URL' ? 'REDIRECT_URL' : type === 'IMPLICIT_URL' ? 'FORWARD_URL' : type;
    const views = Array.isArray(row.viewValue) ? row.viewValue : [];
    const value = normalized === 'SRV'
      ? `${num(row.mxPriority)} ${num(row.weight)} ${num(row.port)} ${String(row.hostValue ?? '')}`
      : String(row.hostValue ?? '');
    return {
      id: String(row.id ?? ''),
      name: String(row.hostRecord ?? '@') || '@',
      type: normalized,
      value,
      line: views.length ? String(views[views.length - 1]) : 'default',
      ttl: num(row.ttl, 600),
      mx: row.mxPriority === undefined || row.mxPriority === null ? null : num(row.mxPriority),
      weight: row.weight === undefined || row.weight === null ? null : num(row.weight),
      remark: null,
      status: num(row.resolvingStatus, 0) === 2 ? 1 : 0,
      updatedAt: row.updateTime ? new Date(num(row.updateTime) * 1000).toISOString() : null,
    };
  }

  const recordPath = (domain: DnsDomain) => `/domain/${encodeURIComponent(domain.id)}/ResourceRecord`;

  function recordBody(input: DnsRecordInput, withDomain: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      hostRecord: input.name,
      type: input.type === 'REDIRECT_URL' || input.type === 'URL' ? 'EXPLICIT_URL' : input.type === 'FORWARD_URL' ? 'IMPLICIT_URL' : input.type,
      hostValue: input.value,
      viewValue: input.line === 'default' ? 0 : Number(input.line) || 0,
      ttl: input.ttl,
    };
    if (withDomain) body.domainName = '';
    if (input.type === 'MX') body.mxPriority = input.mx ?? 10;
    if (input.weight !== null) body.weight = input.weight;
    if (input.type === 'SRV') {
      const parts = input.value.split(/\s+/);
      if (parts.length >= 4) {
        body.mxPriority = Number(parts[0]) || 0;
        body.weight = Number(parts[1]) || 0;
        body.port = Number(parts[2]) || 0;
        body.hostValue = parts.slice(3).join(' ');
      }
    }
    return body;
  }

  return {
    type: 'jdcloud',

    async check() {
      await request('GET', '/domain', { pageNumber: 1, pageSize: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('GET', '/domain', {
        pageNumber: page.page, pageSize: page.pageSize, domainName: page.keyword,
      });
      const items = asArray(data.dataList).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.id ?? ''), name: String(row.domainName ?? ''), recordCount: 0 };
      });
      return { total: num(data.totalCount, items.length), items };
    },

    async addDomain(name) {
      const data = await request('POST', '/domain', { packId: 0, domainName: name });
      const created = asRecord(data.data ?? {});
      return { id: String(created.id ?? ''), name: String(created.domainName ?? name), recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const search = query.name ?? query.keyword;
      const data = await request('GET', recordPath(domain), {
        pageNumber: query.page,
        pageSize: Math.min(query.pageSize, 99),
        search: search ? search.toLowerCase() : undefined,
      });
      let items = asArray(data.dataList).map((raw) => toRecord(raw, domain));
      items = items.filter((record) => {
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
      return { total: num(data.totalCount, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('POST', recordPath(domain), { req: recordBody(input, false) });
      const list = asRecord(data.dataList ?? {});
      return String(list.id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      const body = recordBody(input, true);
      body.domainName = domain.name;
      await request('PUT', `${recordPath(domain)}/${encodeURIComponent(recordId)}`, { req: body });
    },

    async deleteRecord(domain, recordId) {
      await request('DELETE', `${recordPath(domain)}/${encodeURIComponent(recordId)}`);
    },

    async setRecordStatus(domain, recordId, enabled) {
      await request('PUT', `${recordPath(domain)}/${encodeURIComponent(recordId)}/status`, {
        action: enabled ? 'enable' : 'disable',
      });
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(domain): Promise<DnsLine[] | null> {
      const info = await request('GET', '/domain', { domainId: Number(domain.id) || 0 });
      const row = asArray(info.dataList).map(asRecord)[0];
      if (!row) return null;
      const tree = await request('GET', `/domain/${encodeURIComponent(domain.id)}/viewTree`, {
        packId: num(row.packId), viewId: '0',
      });
      const lines: DnsLine[] = [];
      const walk = (nodes: unknown[], parent: string | null) => {
        for (const node of asArray(nodes)) {
          const item = asRecord(node);
          if (item.disabled) continue;
          const key = String(item.value ?? '');
          if (lines.some((line) => line.id === key)) continue;
          lines.push({ id: key === '0' || key === '' ? 'default' : key, name: String(item.label ?? key), parent });
          if (!item.leaf) walk(asArray(item.children), key);
        }
      };
      walk(asArray(tree.data), null);
      return lines.length ? lines : null;
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
