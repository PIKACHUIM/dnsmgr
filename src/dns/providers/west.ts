import { asArray, asRecord, gbkDecode, num, sendJson } from '../http';
import { md5Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface WestConfig {
  username: string;
  api_password: string;
}

const BASE = 'https://api.west.cn/api/v2/domain/';

export function createWestProvider(config: WestConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const LINES: DnsLine[] = [
    { id: 'default', name: '默认', parent: null },
    { id: 'LTEL', name: '电信', parent: null },
    { id: 'LCNC', name: '联通', parent: null },
    { id: 'LMOB', name: '移动', parent: null },
    { id: 'LEDU', name: '教育网', parent: null },
    { id: 'LSEO', name: '搜索引擎', parent: null },
    { id: 'LFOR', name: '境外', parent: null },
  ];

  async function execute(params: Record<string, string | number | undefined>): Promise<Record<string, unknown> | unknown[]> {
    const form: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') form[key] = String(value);
    }
    const time = String(Date.now());
    form.username = config.username;
    form.time = time;
    form.token = md5Hex(`${config.username}${config.api_password}${time}`);
    const response = await sendJson(fetchImpl, BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }, 20000, gbkDecode);
    const payload = asRecord(response.body);
    if (!response.ok || num(payload.result, 0) !== 200) {
      const message = typeof payload.msg === 'string' && payload.msg ? payload.msg : `西部数码接口请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.ok ? 502 : response.status);
    }
    return payload.data === undefined || payload.data === null ? {} : payload.data as Record<string, unknown> | unknown[];
  }

  function toRecord(raw: unknown, domain: DnsDomain): DnsRecord {
    const row = asRecord(raw);
    return {
      id: String(row.id ?? ''),
      name: String(row.item ?? '@') || '@',
      type: String(row.type ?? 'A').toUpperCase(),
      value: String(row.value ?? ''),
      line: typeof row.line === 'string' && row.line ? row.line : 'default',
      ttl: num(row.ttl, 600),
      mx: row.level === undefined || row.level === null ? null : num(row.level),
      weight: null,
      remark: null,
      status: num(row.pause, 0) === 1 ? 0 : 1,
      updatedAt: null,
    };
  }

  const line = (value: string) => (value === 'default' ? '' : value);

  return {
    type: 'west',

    async check() {
      await execute({ act: 'getdomains', page: 1, limit: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = asRecord(await execute({
        act: 'getdomains', page: page.page, limit: page.pageSize, domain: page.keyword,
      }));
      const items = asArray(data.items).map((raw) => {
        const row = asRecord(raw);
        const name = String(row.domain ?? '');
        return { id: name, name, recordCount: 0 };
      });
      return { total: num(data.total, items.length), items };
    },

    async addDomain(name) {
      await execute({ act: 'adddomain', domain: name });
      return { id: name, name, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const data = asRecord(await execute({
        act: 'getdnsrecord',
        domain: domain.name,
        type: query.type,
        line: query.line ? line(query.line) : undefined,
        host: query.name ?? query.keyword,
        value: query.value,
        pageno: query.page,
        limit: query.pageSize,
      }));
      const items = asArray(data.items).map((raw) => toRecord(raw, domain));
      return { total: num(data.total, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = asRecord(await execute({
        act: 'adddnsrecord',
        domain: domain.name,
        host: input.name,
        type: input.type,
        value: input.value,
        level: input.type === 'MX' ? input.mx ?? 10 : undefined,
        ttl: input.ttl,
        line: line(input.line),
      }));
      return String(data.id ?? '');
    },

    async updateRecord(domain, recordId, input) {
      await execute({
        act: 'moddnsrecord',
        domain: domain.name,
        id: recordId,
        type: input.type,
        value: input.value,
        level: input.type === 'MX' ? input.mx ?? 10 : undefined,
        ttl: input.ttl,
        line: line(input.line),
      });
    },

    async deleteRecord(domain, recordId) {
      await execute({ act: 'deldnsrecord', domain: domain.name, id: recordId });
    },

    async setRecordStatus(domain, recordId, enabled) {
      await execute({ act: 'pause', domain: domain.name, id: recordId, val: enabled ? '0' : '1' });
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return LINES;
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
