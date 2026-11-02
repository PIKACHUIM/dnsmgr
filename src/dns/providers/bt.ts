import { asArray, asRecord, num, sendJson } from '../http';
import { hmacSha256Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';

export interface BtConfig {
  AccountID: string;
  AccessKey: string;
  SecretKey: string;
}

const BASE = 'https://dmp.bt.cn';
const MIN_TTL = 300;

export function createBtProvider(config: BtConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function execute(path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(params);
    const signature = await hmacSha256Hex(config.SecretKey, [config.AccountID, timestamp, 'POST', path, body].join('\n'));
    const response = await sendJson(fetchImpl, `${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Account-ID': config.AccountID,
        'X-Access-Key': config.AccessKey,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
      body,
    });
    const payload = asRecord(response.body ?? {});
    if (!response.ok || num(payload.code, -1) !== 0) {
      const message = typeof payload.msg === 'string' && payload.msg ? payload.msg : `宝塔 DNS 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    const data = payload.data;
    return data === null || data === undefined ? {} : asRecord(data);
  }

  /** domainId 由 `本地域名 ID|域名类型` 组成，与旧版存储格式保持一致。 */
  function splitDomain(domain: DnsDomain): { id: number; type: number } {
    const [rawId, rawType] = domain.id.split('|');
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new DnsError('宝塔域名 ID 无效，请重新同步域名', 409, 'DNS_DOMAIN_NOT_SYNCED');
    const type = rawType === undefined || rawType === '' ? 1 : Number(rawType);
    return { id, type: Number.isSafeInteger(type) ? type : 1 };
  }

  function toRecord(raw: unknown): DnsRecord {
    const row = asRecord(raw);
    return {
      id: String(row.record_id ?? ''),
      name: String(row.record ?? '@') || '@',
      type: String(row.type ?? 'A').toUpperCase(),
      value: String(row.value ?? ''),
      line: row.viewID === undefined || row.viewID === null ? 'default' : String(row.viewID),
      ttl: num(row.TTL, MIN_TTL),
      mx: row.MX === undefined || row.MX === null ? null : num(row.MX),
      weight: row.MX === undefined || row.MX === null ? null : num(row.MX),
      remark: typeof row.remark === 'string' && row.remark ? row.remark : null,
      // 宝塔接口以 state=1 表示暂停。
      status: num(row.state, 0) === 1 ? 0 : 1,
      updatedAt: typeof row.created_at === 'string' ? row.created_at : null,
    };
  }

  function recordParams(domain: DnsDomain, input: DnsRecordInput): Record<string, unknown> {
    const { id, type } = splitDomain(domain);
    const weight = input.weight && input.weight > 0 ? input.weight : 1;
    return {
      domain_id: id,
      domain_type: type,
      type: input.type,
      record: input.name,
      value: input.value,
      ttl: input.ttl,
      view_id: input.line === 'default' ? 0 : Number(input.line) || 0,
      mx: input.type === 'MX' ? input.mx ?? 10 : weight,
      ...(input.remark ? { remark: input.remark } : {}),
    };
  }

  return {
    type: 'bt',

    async check() {
      await execute('/api/v1/dns/manage/list_domains', { p: 1, rows: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await execute('/api/v1/dns/manage/list_domains', {
        p: page.page, rows: page.pageSize, keyword: page.keyword,
      });
      const items = asArray(data.data).map((raw) => {
        const row = asRecord(raw);
        return {
          id: `${String(row.local_id ?? '')}|${String(row.domain_type ?? 1)}`,
          name: String(row.full_domain ?? ''),
          recordCount: num(row.record_count),
        };
      });
      return { total: num(data.total, items.length), items };
    },

    async addDomain(name) {
      const data = await execute('/api/v1/dns/manage/add_external_domain', { full_domain: name });
      return {
        id: `${String(data.domain_id ?? '')}|1`,
        name: String(data.full_domain ?? name),
        recordCount: 0,
      };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const { id, type } = splitDomain(domain);
      const params: Record<string, unknown> = { domain_id: id, domain_type: type, p: query.page, rows: query.pageSize };
      const search = query.name ?? query.keyword;
      if (search) { params.searchKey = 'record'; params.searchValue = search; }
      else if (query.value) { params.searchKey = 'value'; params.searchValue = query.value; }
      else if (query.type) { params.searchKey = 'type'; params.searchValue = query.type; }
      else if (query.status) { params.searchKey = 'state'; params.searchValue = query.status === '0' ? '1' : '0'; }
      else if (query.line) { params.searchKey = 'line'; params.searchValue = query.line; }
      const data = await execute('/api/v1/dns/record/list', params);
      return { total: num(data.count), items: asArray(data.data).map(toRecord) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await execute('/api/v1/dns/record/create', recordParams(domain, input));
      return String(data.record_id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await execute('/api/v1/dns/record/update', { ...recordParams(domain, input), record_id: recordId });
    },

    async deleteRecord(domain, recordId) {
      const { id, type } = splitDomain(domain);
      await execute('/api/v1/dns/record/delete', { id: recordId, domain_id: id, domain_type: type });
    },

    async setRecordStatus(domain, recordId, enabled) {
      const { id, type } = splitDomain(domain);
      await execute(enabled ? '/api/v1/dns/record/start' : '/api/v1/dns/record/pause', {
        record_id: recordId, domain_id: id, domain_type: type,
      });
    },

    async setRecordRemark() {
      throw new DnsError('宝塔需要在编辑记录时一并提交备注，请使用编辑功能', 400, 'DNS_REMARK_REQUIRES_EDIT');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      const data = await execute('/api/v1/dns/record/get_views', {});
      const lines: DnsLine[] = [];
      const walk = (nodes: unknown[], parent: string | null) => {
        for (const node of asArray(nodes)) {
          const row = asRecord(node);
          const viewId = String(row.viewId ?? '');
          if (!row.free || !viewId || lines.some((line) => line.id === viewId)) continue;
          lines.push({ id: viewId, name: String(row.name ?? viewId), parent });
          walk(asArray(row.children), viewId);
        }
      };
      walk(asArray(data.data ?? data), null);
      return lines.length ? lines : null;
    },

    async minTtl(): Promise<number | null> {
      return MIN_TTL;
    },
  };
}
