import { asArray, asRecord, num, sendJson } from '../http';
import { tencentAuthorization } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord, type DnsRecordGroup, type DnsRecordLog,
  type DnsDomainAlias, type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';

export interface DnspodConfig {
  SecretId: string;
  SecretKey: string;
}

const HOST = 'dnspod.tencentcloudapi.com';
const SERVICE = 'dnspod';
const VERSION = '2021-03-23';

export function createDnspodProvider(config: DnspodConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  let grade: string | null = null;
  let infoPromise: Promise<Record<string, unknown>> | null = null;

  async function request(action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = JSON.stringify(params);
    const timestamp = Math.floor(Date.now() / 1000);
    const authorization = await tencentAuthorization({
      secretId: config.SecretId, secretKey: config.SecretKey, service: SERVICE, host: HOST,
      action, version: VERSION, payload, timestamp,
    });
    const response = await sendJson(fetchImpl, `https://${HOST}/`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        'X-TC-Action': action,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': String(timestamp),
      },
      body: payload,
    });
    const envelope = asRecord(response.body);
    const result = envelope.Response;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new DnsError('腾讯云 DNS 响应格式异常', 502, 'DNS_INVALID_RESPONSE');
    }
    const body = asRecord(result);
    const error = body.Error;
    if (error) {
      const detail = asRecord(error);
      throw new DnsError(String(detail.Message ?? '腾讯云 DNS 请求失败'), response.ok ? 502 : response.status);
    }
    return body;
  }

  function domainName(domain: DnsDomain): string {
    if (!domain.name) throw new DnsError('域名信息缺失', 409, 'DNS_DOMAIN_NOT_SYNCED');
    return domain.name;
  }

  function toRecord(raw: unknown): DnsRecord {
    const row = asRecord(raw);
    return {
      id: String(row.RecordId ?? ''),
      name: String(row.Name ?? '@'),
      type: normalizeType(String(row.Type ?? 'A')),
      value: String(row.Value ?? ''),
      line: typeof row.LineId === 'string' && row.LineId ? row.LineId : String(row.Line ?? '0'),
      ttl: num(row.TTL, 600),
      mx: row.MX === undefined || row.MX === null ? null : num(row.MX),
      weight: row.Weight === undefined || row.Weight === null ? null : num(row.Weight),
      remark: typeof row.Remark === 'string' && row.Remark ? row.Remark : null,
      status: String(row.Status ?? '').toUpperCase() === 'DISABLE' ? 0 : 1,
      updatedAt: typeof row.UpdatedOn === 'string' ? row.UpdatedOn : null,
    };
  }

  function apiType(type: string): string {
    if (type === 'REDIRECT_URL' || type === 'URL') return '显性URL';
    if (type === 'FORWARD_URL') return '隐性URL';
    return type;
  }

  function normalizeType(type: string): string {
    if (type === '显性URL') return 'REDIRECT_URL';
    if (type === '隐性URL') return 'FORWARD_URL';
    return type;
  }

  function recordBody(domain: DnsDomain, input: DnsRecordInput): Record<string, unknown> {
    const line = input.line || '0';
    return {
      Domain: domainName(domain),
      SubDomain: input.name,
      RecordType: apiType(input.type),
      Value: input.value,
      RecordLine: line === '0' ? '默认' : line,
      RecordLineId: line,
      TTL: input.ttl,
      ...(input.type === 'MX' ? { MX: input.mx ?? 10 } : {}),
      ...(input.weight !== null ? { Weight: input.weight } : {}),
    };
  }

  /** 域名详情用于读取套餐等级与最小 TTL，同一实例内复用一次请求。 */
  async function domainInfo(domain: DnsDomain): Promise<Record<string, unknown>> {
    infoPromise ??= request('DescribeDomain', { Domain: domainName(domain) })
      .then((data) => asRecord(data.DomainInfo ?? {}));
    return infoPromise;
  }

  return {
    type: 'dnspod',

    async check() {
      await request('DescribeDomainList', { Offset: 0, Limit: 1 });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const data = await request('DescribeDomainList', {
        Offset: (page.page - 1) * page.pageSize,
        Limit: page.pageSize,
        ...(page.keyword ? { Keyword: page.keyword } : {}),
      });
      const items = asArray(data.DomainList).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.DomainId ?? ''), name: String(row.Name ?? ''), recordCount: num(row.RecordCount) };
      });
      const info = data.DomainCountInfo ? asRecord(data.DomainCountInfo) : {};
      return { total: num(info.DomainTotalNumber, items.length), items };
    },

    async addDomain(name) {
      const data = await request('CreateDomain', { Domain: name });
      const info = data.DomainInfo ? asRecord(data.DomainInfo) : {};
      return { id: String(info.Id ?? ''), name, recordCount: 0 };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const params: Record<string, unknown> = {
        Domain: domainName(domain),
        Offset: (query.page - 1) * query.pageSize,
        Limit: query.pageSize,
      };
      if (query.name) params.Subdomain = query.name;
      if (query.type) params.RecordType = apiType(query.type);
      if (query.value) params.Keyword = query.value;
      if (query.keyword) params.Keyword = query.keyword;
      if (query.line) params.RecordLineId = query.line;
      if (query.status) params.RecordStatus = [query.status === '1' ? 'ENABLE' : 'DISABLE'];
      const data = await request('DescribeRecordList', params);
      const items = asArray(data.RecordList).map(toRecord);
      const info = data.RecordCountInfo ? asRecord(data.RecordCountInfo) : {};
      return { total: num(info.TotalCount, items.length), items };
    },

    async addRecord(domain, input) {
      const data = await request('CreateRecord', recordBody(domain, input));
      return String(num(data.RecordId));
    },

    async updateRecord(domain, recordId, input) {
      await request('ModifyRecord', { ...recordBody(domain, input), RecordId: Number(recordId) });
    },

    async deleteRecord(domain, recordId) {
      await request('DeleteRecord', { Domain: domainName(domain), RecordId: Number(recordId) });
    },

    async setRecordStatus(domain, recordId, enabled) {
      await request('ModifyRecordStatus', {
        Domain: domainName(domain), RecordId: Number(recordId), Status: enabled ? 'ENABLE' : 'DISABLE',
      });
    },

    async setRecordRemark(domain, recordId, remark) {
      await request('ModifyRecordRemark', {
        Domain: domainName(domain), RecordId: Number(recordId), Remark: remark ?? '',
      });
    },

    async recordLines(domain): Promise<DnsLine[] | null> {
      // 新版分类接口在低版本套餐不可用，失败时退回按套餐读取平铺线路。
      let data: Record<string, unknown> | null = null;
      try {
        data = await request('DescribeRecordLineCategoryList', { Domain: domainName(domain) });
      } catch {
        data = null;
      }
      const lines: DnsLine[] = [];
      const walk = (raw: unknown, parent: string | null) => {
        for (const item of asArray(raw)) {
          const row = asRecord(item);
          if (!row.Useful) continue;
          const name = String(row.LineName ?? '');
          const id = row.LineId === undefined || row.LineId === null || row.LineId === ''
            ? `N.${name}` : String(row.LineId);
          if (lines.some((line) => line.id === id)) continue;
          lines.push({ id, name, parent });
          if (row.SubGroup) walk(row.SubGroup, id);
        }
      };
      walk(data?.LineList, null);
      if (lines.length > 0) return lines;

      if (grade === null) grade = String((await domainInfo(domain)).Grade ?? 'DP_FREE');
      const fallback = await request('DescribeRecordLineList', { Domain: domainName(domain), DomainGrade: grade });
      const rows = asArray(fallback.LineList);
      if (rows.length === 0) return null;
      return rows.map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.LineId ?? '0'), name: String(row.LineName ?? '默认'), parent: null };
      });
    },

    async minTtl(domain): Promise<number | null> {
      const ttl = num((await domainInfo(domain)).TTL, 0);
      if (ttl > 0) return ttl;
      // 部分套餐不返回 DomainInfo.TTL，退回读取域名权限列表中的最低 TTL。
      const data = await request('DescribeDomainPurview', { Domain: domainName(domain) });
      for (const raw of asArray(data.PurviewList)) {
        const row = asRecord(raw);
        const name = String(row.Name ?? '');
        if (name === '记录 TTL 最低' || name === 'Min TTL value') {
          const value = num(row.Value, 0);
          if (value > 0) return value;
        }
      }
      return null;
    },

    async listDomainAliases(domain): Promise<DnsDomainAlias[]> {
      const data = await request('DescribeDomainAliasList', { Domain: domainName(domain) });
      return asArray(data.DomainAliasList).map((raw) => {
        const row = asRecord(raw);
        return { id: String(row.Id ?? row.DomainAliasId ?? ''), name: String(row.DomainAlias ?? row.Name ?? '') };
      }).filter((item) => item.id && item.name);
    },

    async addDomainAlias(domain, alias) {
      await request('CreateDomainAlias', { Domain: domainName(domain), DomainAlias: alias });
    },

    async deleteDomainAlias(domain, aliasId) {
      await request('DeleteDomainAlias', { Domain: domainName(domain), DomainAliasId: Number(aliasId) });
    },

    async recordLogs(domain, page): Promise<PageResult<DnsRecordLog>> {
      const data = await request('DescribeDomainLogList', {
        Domain: domainName(domain), Offset: (page.page - 1) * page.pageSize, Limit: page.pageSize,
      });
      const items = asArray(data.LogList).map((raw) => {
        const text = String(raw);
        const time = text.slice(0, text.indexOf('(') >= 0 ? text.indexOf('(') : text.length).trim();
        return { time: time || null, action: text };
      });
      return { total: num(data.TotalCount, items.length), items };
    },

    async listRecordGroups(domain): Promise<DnsRecordGroup[]> {
      const data = await request('DescribeRecordGroupList', { Domain: domainName(domain) });
      return asArray(data.GroupList).map((raw) => {
        const row = asRecord(raw);
        return {
          id: String(row.GroupId ?? ''),
          name: String(row.GroupName ?? ''),
          count: row.RecordCount === undefined || row.RecordCount === null ? null : num(row.RecordCount),
        };
      }).filter((group) => group.id !== '' && group.name);
    },

    async changeRecordGroup(domain, recordIds, groupId) {
      if (recordIds.length === 0) throw new DnsError('记录编号不能为空', 400, 'INVALID_RECORD_IDS');
      if (!/^\d{1,20}$/.test(groupId || '0')) throw new DnsError('分组编号无效', 400, 'INVALID_GROUP_ID');
      await request('ModifyRecordToGroup', {
        Domain: domainName(domain), GroupId: Number(groupId || '0'), RecordId: recordIds.join('|'),
      });
    },
  };
}
