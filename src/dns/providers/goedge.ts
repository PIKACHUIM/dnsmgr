import { asArray, asRecord, num, sendJson } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';

export interface GoEdgeConfig {
  base_url: string;
  accessKeyId: string;
  accessKey: string;
  type?: string;
  nsClusterId?: string;
  userId?: string;
}

export function createGoEdgeProvider(config: GoEdgeConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  const baseUrl = config.base_url.replace(/\/+$/, '');
  const userType = (config.type ?? 'admin').toLowerCase() === 'user' ? 'user' : 'admin';
  const nsClusterId = Number(config.nsClusterId ?? 0) || 0;
  const userId = Number(config.userId ?? 0) || 0;
  let token: string | null = null;

  async function accessToken(): Promise<string> {
    if (token) return token;
    const response = await sendJson(fetchImpl, `${baseUrl}/APIAccessTokenService/getAPIAccessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: userType, accessKeyId: config.accessKeyId, accessKey: config.accessKey }),
    });
    const payload = asRecord(response.body ?? {});
    const created = asRecord(payload.data ?? {});
    if (!response.ok || num(payload.code, 0) !== 200 || !created.token) {
      const message = typeof payload.message === 'string' && payload.message ? payload.message : '获取 GoEdge AccessToken 失败';
      throw new DnsError(message, response.status === 401 ? 401 : 502);
    }
    token = String(created.token);
    return token;
  }

  async function request(path: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await sendJson(fetchImpl, `${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Edge-Access-Token': await accessToken() },
      body: JSON.stringify(payload),
    });
    const data = asRecord(response.body ?? {});
    if (!response.ok || num(data.code, 0) !== 200) {
      const message = typeof data.message === 'string' && data.message ? data.message : `GoEdge API 请求失败（HTTP ${response.status}）`;
      throw new DnsError(message, /token/i.test(message) ? 401 : 502);
    }
    return data.data === null || data.data === undefined ? {} : asRecord(data.data);
  }

  const withUser = (payload: Record<string, unknown>) =>
    (userType === 'admin' && userId > 0 ? { ...payload, userId } : payload);

  const routeCodes = (line: string) => {
    const codes = line.split(',').map((item) => item.trim()).filter(Boolean);
    return codes.length ? [...new Set(codes)] : ['default'];
  };

  function toRecord(raw: unknown): DnsRecord {
    const row = asRecord(raw);
    const routes = asArray(row.nsRoutes).map(asRecord).filter((route) => route.code);
    const codes = routes.map((route) => String(route.code));
    const mxPriority = num(row.mxPriority);
    return {
      id: String(row.id ?? ''),
      name: String(row.name ?? '@') || '@',
      type: String(row.type ?? 'A').toUpperCase(),
      value: String(row.value ?? ''),
      line: codes.length ? codes.join(',') : 'default',
      ttl: num(row.ttl, 600),
      mx: mxPriority > 0 ? mxPriority : null,
      weight: num(row.weight) > 0 ? num(row.weight) : null,
      remark: typeof row.description === 'string' && row.description ? row.description : null,
      status: row.isOn ? 1 : 0,
      updatedAt: num(row.createdAt) > 0 ? new Date(num(row.createdAt) * 1000).toISOString() : null,
    };
  }

  function recordPayload(domain: DnsDomain, input: DnsRecordInput, extra: Record<string, unknown> = {}): Record<string, unknown> {
    if (!domain.id) throw new DnsError('GoEdge 域名 ID 缺失，请重新同步域名', 409, 'DNS_DOMAIN_NOT_SYNCED');
    return {
      nsDomainId: Number(domain.id) || 0,
      name: input.name,
      type: input.type,
      value: input.value,
      ttl: Math.max(1, input.ttl),
      nsRouteCodes: routeCodes(input.line),
      weight: input.weight ?? 0,
      mxPriority: input.type === 'MX' ? Math.max(0, input.mx ?? 10) : 0,
      description: input.remark ?? '',
      ...extra,
    };
  }

  return {
    type: 'goedge',

    async check() {
      if (!baseUrl || !config.accessKeyId || !config.accessKey) throw new DnsError('API 地址与 AccessKey 不能为空', 400, 'INVALID_ACCOUNT_CONFIG');
      if (nsClusterId <= 0) throw new DnsError('DNS 集群 ID 必须大于 0', 400, 'INVALID_ACCOUNT_CONFIG');
      const data = await request('/NSClusterService/findNSCluster', { nsClusterId });
      if (!data.nsCluster) throw new DnsError('未找到指定的 DNS 集群', 404, 'DNS_CLUSTER_NOT_FOUND');
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const query = withUser({ nsClusterId, ...(page.keyword ? { keyword: page.keyword } : {}) });
      const count = await request('/NSDomainService/countAllNSDomains', query);
      const list = await request('/NSDomainService/listNSDomains', {
        ...query, offset: (page.page - 1) * page.pageSize, size: page.pageSize,
      });
      const items = asArray(list.nsDomains).map(asRecord).map((row) => ({
        id: String(row.id ?? ''), name: String(row.name ?? ''), recordCount: 0,
      }));
      return { total: num(count.count, items.length), items };
    },

    async addDomain(name) {
      const data = await request('/NSDomainService/createNSDomain', withUser({ nsClusterId, name }));
      return { id: String(data.nsDomainId ?? ''), name, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      if (!domain.id) throw new DnsError('GoEdge 域名 ID 缺失，请重新同步域名', 409, 'DNS_DOMAIN_NOT_SYNCED');
      const hasLocalFilter = Boolean(query.name || query.value || query.status);
      const payload: Record<string, unknown> = {
        nsDomainId: Number(domain.id) || 0,
        offset: hasLocalFilter ? 0 : (query.page - 1) * query.pageSize,
        size: hasLocalFilter ? 1000 : query.pageSize,
      };
      if (query.keyword) payload.keyword = query.keyword;
      if (query.type) payload.type = query.type;
      if (query.line) payload.nsRouteCode = routeCodes(query.line)[0];
      const data = await request('/NSRecordService/listNSRecords', payload);
      let items = asArray(data.nsRecords).map(asRecord).map(toRecord);
      items = items.filter((record) => {
        if (query.name && record.name.toLowerCase() !== query.name.toLowerCase()) return false;
        if (query.value && !record.value.toLowerCase().includes(query.value.toLowerCase())) return false;
        if (query.status && String(record.status) !== query.status) return false;
        return true;
      });
      const total = items.length;
      if (hasLocalFilter) {
        const offset = (query.page - 1) * query.pageSize;
        items = items.slice(offset, offset + query.pageSize);
      }
      return { total, items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const data = await request('/NSRecordService/createNSRecord', recordPayload(domain, input));
      return String(data.nsRecordId ?? '');
    },

    async updateRecord(domain, recordId, input) {
      const current = toRecord(asRecord((await request('/NSRecordService/findNSRecord', { nsRecordId: Number(recordId) })).nsRecord ?? {}));
      await request('/NSRecordService/updateNSRecord', recordPayload(domain, input, {
        nsRecordId: Number(recordId),
        isOn: current.status === 1,
        weight: input.weight ?? current.weight ?? 0,
      }));
    },

    async deleteRecord(_domain, recordId) {
      await request('/NSRecordService/deleteNSRecord', { nsRecordId: Number(recordId) });
    },

    async setRecordStatus(domain, recordId, enabled) {
      const raw = asRecord((await request('/NSRecordService/findNSRecord', { nsRecordId: Number(recordId) })).nsRecord ?? {});
      const current = toRecord(raw);
      await request('/NSRecordService/updateNSRecord', recordPayload(domain, {
        name: current.name, type: current.type, value: current.value, line: current.line,
        ttl: current.ttl, mx: current.mx, weight: current.weight, remark: current.remark,
      }, { nsRecordId: Number(recordId), isOn: enabled }));
    },

    async setRecordRemark(_domain, recordId, remark) {
      const raw = asRecord((await request('/NSRecordService/findNSRecord', { nsRecordId: Number(recordId) })).nsRecord ?? {});
      const current = toRecord(raw);
      await request('/NSRecordService/updateNSRecord', {
        nsRecordId: Number(recordId),
        isOn: current.status === 1,
        name: current.name,
        type: current.type,
        value: current.value,
        ttl: Math.max(1, current.ttl),
        nsRouteCodes: routeCodes(current.line),
        weight: current.weight ?? 0,
        mxPriority: current.type === 'MX' ? current.mx ?? 0 : 0,
        description: remark ?? '',
      });
    },

    async recordLines(): Promise<DnsLine[] | null> {
      const lines = new Map<string, DnsLine>();
      for (const path of [
        '/NSRouteService/findAllDefaultWorldRegionRoutes',
        '/NSRouteService/findAllDefaultChinaProvinceRoutes',
        '/NSRouteService/findAllDefaultISPRoutes',
        '/NSRouteService/findAllAgentNSRoutes',
        '/NSRouteService/findAllNSRoutes',
      ]) {
        const data = await request(path, {});
        for (const raw of asArray(data.nsRoutes)) {
          const row = asRecord(raw);
          const code = String(row.code ?? '');
          if (!code || lines.has(code)) continue;
          lines.set(code, {
            id: code,
            name: String(row.name ?? code),
            parent: typeof row.parent === 'string' && row.parent ? row.parent : null,
          });
        }
      }
      const ordered: DnsLine[] = [{ id: 'default', name: '默认线路', parent: null }];
      for (const [code, line] of lines) {
        if (code === 'default') continue;
        if (!line.parent && code.includes(':')) {
          const parts = code.split(':');
          while (parts.length > 1) {
            parts.pop();
            const parent = parts.join(':');
            if (lines.has(parent)) { line.parent = parent; break; }
          }
        }
        ordered.push(line);
      }
      return ordered;
    },

    async minTtl(): Promise<number | null> {
      return 1;
    },
  };
}
