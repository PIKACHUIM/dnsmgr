import { asArray, asRecord, num, sendJson } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface SpaceshipConfig {
  apikey: string;
  apisecret: string;
}

const BASE = 'https://spaceship.dev/api/v1';

export function createSpaceshipProvider(config: SpaceshipConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function request(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const response = await sendJson(fetchImpl, `${BASE}${path}`, {
      method,
      headers: {
        'X-API-Key': config.apikey,
        'X-API-Secret': config.apisecret,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const payload = asRecord(response.body ?? {});
      const message = typeof payload.detail === 'string' ? payload.detail : `Spaceship 接口请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, response.status === 401 || response.status === 403 ? 401 : 502);
    }
    return response.body;
  }

  function toRecord(raw: unknown): DnsRecord {
    const row = asRecord(raw);
    const type = String(row.type ?? 'A').toUpperCase();
    let value = String(row.address ?? '');
    let mx: number | null = null;
    if (type === 'MX') { value = String(row.exchange ?? ''); mx = num(row.preference); }
    else if (type === 'CNAME') value = String(row.cname ?? '');
    else if (type === 'TXT') value = String(row.value ?? '');
    else if (type === 'PTR') value = String(row.pointer ?? '');
    else if (type === 'NS') value = String(row.nameserver ?? '');
    else if (type === 'CAA') value = `${num(row.flag)} ${String(row.tag ?? '')} ${String(row.value ?? '')}`.trim();
    else if (type === 'SRV') value = `${num(row.priority)} ${num(row.weight)} ${num(row.port)} ${String(row.target ?? '')}`.trim();
    else if (type === 'ALIAS') value = String(row.aliasName ?? '');
    return {
      id: `${type}|${String(row.name ?? '@')}|${value}|${mx ?? 0}`,
      name: String(row.name ?? '@') || '@',
      type,
      value,
      line: 'default',
      ttl: num(row.ttl, 600),
      mx,
      weight: null,
      remark: null,
      status: 1,
      updatedAt: null,
    };
  }

  function item(name: string, type: string, value: string, mx: number | null, ttl: number): Record<string, unknown> {
    const base: Record<string, unknown> = { type, name, ttl };
    if (type === 'MX') return { ...base, exchange: value, preference: mx ?? 10 };
    if (type === 'TXT') return { ...base, value };
    if (type === 'CNAME') return { ...base, cname: value };
    if (type === 'ALIAS') return { ...base, aliasName: value };
    if (type === 'NS') return { ...base, nameserver: value };
    if (type === 'PTR') return { ...base, pointer: value };
    if (type === 'CAA') {
      const [flag, tag, ...rest] = value.split(/\s+/);
      return { ...base, flag: Number(flag) || 0, tag: tag ?? 'issue', value: rest.join(' ').replace(/^"|"$/g, '') };
    }
    if (type === 'SRV') {
      const [priority, weight, port, ...rest] = value.split(/\s+/);
      return { ...base, priority: Number(priority) || 0, weight: Number(weight) || 0, port: Number(port) || 0, target: rest.join(' ') };
    }
    return { ...base, address: value };
  }

  function fromId(recordId: string): { name: string; type: string; value: string; mx: number | null } {
    const [type, name, value, mx] = recordId.split('|');
    if (!type || name === undefined || value === undefined) {
      throw new DnsError('记录编号格式无效，请刷新列表后重试', 400, 'INVALID_RECORD_ID');
    }
    return { type, name, value, mx: mx === undefined || mx === '' ? null : Number(mx) || 0 };
  }

  return {
    type: 'spaceship',

    async check() {
      await request('GET', '/domains?take=1&skip=0');
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = asRecord(await request('GET', `/domains?take=${Math.min(page.pageSize, 100)}&skip=${(page.page - 1) * Math.min(page.pageSize, 100)}`));
      let items = asArray(data.items).map((raw) => {
        const name = String(asRecord(raw).name ?? '');
        return { id: name, name, recordCount: 0 };
      });
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      return { total: num(data.total, items.length), items };
    },

    async addDomain() {
      unsupported('在 Spaceship 中新建域名');
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const hasName = Boolean(query.name);
      const take = hasName ? 100 : Math.min(query.pageSize, 100);
      const skip = hasName ? 0 : (query.page - 1) * take;
      const data = asRecord(await request('GET', `/dns/records/${encodeURIComponent(domain.name)}?take=${take}&skip=${skip}`));
      let items = asArray(data.items).map(toRecord);
      if (hasName) items = items.filter((record) => record.name.toLowerCase() === query.name!.toLowerCase());
      items = items.filter((record) => {
        if (query.type && record.type !== query.type) return false;
        if (query.value && record.value !== query.value) return false;
        if (query.keyword) {
          const needle = query.keyword.toLowerCase();
          if (!record.name.toLowerCase().includes(needle) && !record.value.toLowerCase().includes(needle)) return false;
        }
        return true;
      });
      return { total: hasName ? items.length : num(data.total, items.length), items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      await request('PUT', `/dns/records/${encodeURIComponent(domain.name)}`, {
        force: false, items: [item(input.name, input.type, input.value, input.mx, input.ttl)],
      });
      const listed = await request('GET', `/dns/records/${encodeURIComponent(domain.name)}?take=100&skip=0`);
      const found = asArray(asRecord(listed).items).map(toRecord).find((record) =>
        record.name === input.name && record.type === input.type && record.value === input.value);
      if (!found) throw new DnsError('记录已提交但未能重新定位，请刷新列表确认', 502, 'DNS_RECORD_ID_UNKNOWN');
      return found.id;
    },

    async updateRecord(domain, recordId, input) {
      const old = fromId(recordId);
      await request('PUT', `/dns/records/${encodeURIComponent(domain.name)}`, {
        force: true, items: [item(input.name, input.type, input.value, input.mx, input.ttl)],
      });
      if (old.type !== input.type || old.name !== input.name || old.value !== input.value) {
        // PUT 只做新增/覆盖，旧组合需显式删除，避免改名后留下重复记录。
        await request('DELETE', `/dns/records/${encodeURIComponent(domain.name)}`, [
          item(old.name, old.type, old.value, old.mx, input.ttl),
        ]);
      }
    },

    async deleteRecord(domain, recordId) {
      const old = fromId(recordId);
      await request('DELETE', `/dns/records/${encodeURIComponent(domain.name)}`, [
        item(old.name, old.type, old.value, old.mx, 600),
      ]);
    },

    async setRecordStatus() {
      unsupported('启用或停用解析记录');
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return [{ id: 'default', name: '默认', parent: null }];
    },

    async minTtl(): Promise<number | null> {
      return null;
    },
  };
}
