export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR', 'URL', 'REDIRECT_URL', 'FORWARD_URL'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export interface DnsLine {
  id: string;
  name: string;
  parent: string | null;
}

export interface DnsRecordInput {
  name: string;
  type: string;
  value: string;
  line: string;
  ttl: number;
  mx: number | null;
  weight: number | null;
  remark: string | null;
}

export interface DnsRecord extends DnsRecordInput {
  id: string;
  status: 0 | 1;
  updatedAt: string | null;
}

export interface DnsRecordLog {
  time: string | null;
  action: string;
}

export interface DnsDomainAlias {
  id: string;
  name: string;
}

export interface DnsDomain {
  id: string;
  name: string;
  recordCount: number;
}

export interface PageResult<T> {
  total: number;
  items: T[];
}

export interface RecordQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  name?: string;
  value?: string;
  type?: string;
  line?: string;
  status?: '0' | '1';
}

/** 平台驱动只需实现真实存在的能力；不支持的操作必须抛错，不能静默成功。 */
export interface DnsProvider {
  readonly type: string;
  /** 校验凭据可用，失败抛出 DnsError */
  check(): Promise<void>;
  listDomains(page: { page: number; pageSize: number; keyword?: string }): Promise<PageResult<DnsDomain>>;
  addDomain(name: string): Promise<DnsDomain>;
  listRecords(domain: DnsDomain, query: RecordQuery): Promise<PageResult<DnsRecord>>;
  addRecord(domain: DnsDomain, input: DnsRecordInput): Promise<string>;
  updateRecord(domain: DnsDomain, recordId: string, input: DnsRecordInput): Promise<void>;
  deleteRecord(domain: DnsDomain, recordId: string): Promise<void>;
  setRecordStatus(domain: DnsDomain, recordId: string, enabled: boolean): Promise<void>;
  setRecordRemark(domain: DnsDomain, recordId: string, remark: string | null): Promise<void>;
  /** 返回 null 表示平台没有可枚举的线路 */
  recordLines(domain: DnsDomain): Promise<DnsLine[] | null>;
  /** 返回 null 表示平台不限制/不公开最小 TTL */
  minTtl(domain: DnsDomain): Promise<number | null>;
  /** 可选：厂商侧解析操作日志；未实现表示平台不提供 */
  recordLogs?(domain: DnsDomain, page: { page: number; pageSize: number }): Promise<PageResult<DnsRecordLog>>;
  /** 可选：厂商侧域名别名（多个域名共用同一套解析） */
  listDomainAliases?(domain: DnsDomain): Promise<DnsDomainAlias[]>;
  addDomainAlias?(domain: DnsDomain, alias: string): Promise<void>;
  deleteDomainAlias?(domain: DnsDomain, aliasId: string): Promise<void>;
}

export class DnsError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'DNS_PROVIDER_ERROR') {
    super(message);
    this.name = 'DnsError';
  }
}

export function isRecordType(value: string): value is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(value);
}
