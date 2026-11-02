import { DnsError, type DnsProvider } from './types';
import { createAliyunProvider } from './providers/aliyun';
import { createAliyunEsaProvider } from './providers/aliyunesa';
import { createAwsProvider } from './providers/aws';
import { createBaiduProvider } from './providers/baidu';
import { createBtProvider } from './providers/bt';
import { createCloudflareProvider } from './providers/cloudflare';
import { createDnslaProvider } from './providers/dnsla';
import { createDnsmgrProvider } from './providers/dnsmgr';
import { createDnspodProvider } from './providers/dnspod';
import { createDynv6Provider } from './providers/dynv6';
import { createGoEdgeProvider } from './providers/goedge';
import { createHenetProvider } from './providers/henet';
import { createHuaweiProvider } from './providers/huawei';
import { createHuoshanProvider } from './providers/huoshan';
import { createJdcloudProvider } from './providers/jdcloud';
import { createNamesiloProvider } from './providers/namesilo';
import { createPowerDnsProvider } from './providers/powerdns';
import { createQingcloudProvider } from './providers/qingcloud';
import { createSpaceshipProvider } from './providers/spaceship';
import { createTechnitiumProvider } from './providers/technitium';
import { createTencentEoProvider } from './providers/tencenteo';
import { createWestProvider } from './providers/west';

export interface ProviderField {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
}

export interface ProviderMeta {
  type: string;
  name: string;
  supported: boolean;
  fields: ProviderField[];
  capabilities: { status: boolean; remark: boolean; weight: boolean; lines: boolean; addDomain: boolean };
}

const akSk = (idLabel: string, secretLabel: string): ProviderField[] => [
  { key: 'AccessKeyId', label: idLabel, required: true },
  { key: 'SecretAccessKey', label: secretLabel, required: true, secret: true },
];

const catalog: ProviderMeta[] = [
  {
    type: 'cloudflare', name: 'Cloudflare', supported: true,
    fields: [
      { key: 'apikey', label: 'API Token / Global API Key', required: true, secret: true },
      { key: 'email', label: '账号邮箱（仅 Global API Key 需要）', required: false },
    ],
    capabilities: { status: true, remark: true, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'aliyun', name: '阿里云', supported: true,
    fields: [
      { key: 'AccessKeyId', label: 'AccessKeyId', required: true },
      { key: 'AccessKeySecret', label: 'AccessKeySecret', required: true, secret: true },
    ],
    capabilities: { status: true, remark: true, weight: true, lines: true, addDomain: true },
  },
  {
    type: 'dnspod', name: '腾讯云 DNSPod', supported: true,
    fields: [
      { key: 'SecretId', label: 'SecretId', required: true },
      { key: 'SecretKey', label: 'SecretKey', required: true, secret: true },
    ],
    capabilities: { status: true, remark: true, weight: true, lines: true, addDomain: true },
  },
  {
    type: 'tencenteo', name: '腾讯云 EdgeOne', supported: true,
    fields: [
      { key: 'SecretId', label: 'SecretId', required: true },
      { key: 'SecretKey', label: 'SecretKey', required: true, secret: true },
      { key: 'site_type', label: '站点类型（intl 表示国际站）', required: false },
    ],
    capabilities: { status: true, remark: false, weight: true, lines: true, addDomain: false },
  },
  {
    type: 'aliyunesa', name: '阿里云 ESA', supported: true,
    fields: [
      { key: 'AccessKeyId', label: 'AccessKeyId', required: true },
      { key: 'AccessKeySecret', label: 'AccessKeySecret', required: true, secret: true },
      { key: 'region', label: '地域（可选，如 ap-southeast-1）', required: false },
    ],
    capabilities: { status: false, remark: true, weight: false, lines: true, addDomain: false },
  },
  {
    type: 'aws', name: 'AWS Route 53', supported: true,
    fields: akSk('AccessKeyId', 'SecretAccessKey'),
    capabilities: { status: false, remark: false, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'baidu', name: '百度云 DNS', supported: true,
    fields: akSk('AccessKeyId', 'SecretAccessKey'),
    capabilities: { status: true, remark: true, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'huawei', name: '华为云 DNS', supported: true,
    fields: akSk('AccessKeyId', 'SecretAccessKey'),
    capabilities: { status: true, remark: false, weight: true, lines: false, addDomain: true },
  },
  {
    type: 'huoshan', name: '火山引擎 DNS', supported: true,
    fields: akSk('AccessKeyId', 'SecretAccessKey'),
    capabilities: { status: true, remark: false, weight: true, lines: true, addDomain: true },
  },
  {
    type: 'jdcloud', name: '京东云 DNS', supported: true,
    fields: [
      { key: 'AccessKeyId', label: 'AccessKeyId', required: true },
      { key: 'AccessKeySecret', label: 'AccessKeySecret', required: true, secret: true },
    ],
    capabilities: { status: true, remark: false, weight: true, lines: true, addDomain: true },
  },
  {
    type: 'qingcloud', name: '青云 DNS', supported: true,
    fields: [
      { key: 'access_key_id', label: 'access_key_id', required: true },
      { key: 'secret_access_key', label: 'secret_access_key', required: true, secret: true },
    ],
    capabilities: { status: true, remark: false, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'namesilo', name: 'NameSilo', supported: true,
    fields: [{ key: 'apikey', label: 'API Key', required: true, secret: true }],
    capabilities: { status: false, remark: false, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'spaceship', name: 'Spaceship', supported: true,
    fields: [
      { key: 'apikey', label: 'API Key', required: true },
      { key: 'apisecret', label: 'API Secret', required: true, secret: true },
    ],
    capabilities: { status: false, remark: false, weight: false, lines: true, addDomain: false },
  },
  {
    type: 'west', name: '西部数码', supported: true,
    fields: [
      { key: 'username', label: '用户名', required: true },
      { key: 'api_password', label: 'API 密码', required: true, secret: true },
    ],
    capabilities: { status: true, remark: false, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'bt', name: '宝塔 DNS', supported: true,
    fields: [
      { key: 'AccountID', label: 'AccountID', required: true },
      { key: 'AccessKey', label: 'AccessKey', required: true },
      { key: 'SecretKey', label: 'SecretKey', required: true, secret: true },
    ],
    capabilities: { status: true, remark: false, weight: true, lines: true, addDomain: true },
  },
  {
    type: 'dnsla', name: 'DNSLA', supported: true,
    fields: [
      { key: 'apiid', label: 'API ID', required: true },
      { key: 'apisecret', label: 'API Secret', required: true, secret: true },
    ],
    capabilities: { status: true, remark: false, weight: true, lines: true, addDomain: true },
  },
  {
    type: 'dnsmgr', name: 'DNSMGR', supported: true,
    fields: [
      { key: 'base_url', label: '面板地址', required: true },
      { key: 'uid', label: 'UID', required: true },
      { key: 'key', label: '通信密钥', required: true, secret: true },
    ],
    capabilities: { status: true, remark: true, weight: true, lines: true, addDomain: false },
  },
  {
    type: 'dynv6', name: 'dynv6', supported: true,
    fields: [{ key: 'token', label: 'HTTP Token', required: true, secret: true }],
    capabilities: { status: false, remark: false, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'goedge', name: 'GoEdge', supported: true,
    fields: [
      { key: 'base_url', label: 'API 地址', required: true },
      { key: 'accessKeyId', label: 'AccessKey ID', required: true },
      { key: 'accessKey', label: 'AccessKey', required: true, secret: true },
      { key: 'type', label: 'AccessKey 类型（admin/user）', required: false },
      { key: 'nsClusterId', label: 'DNS 集群 ID', required: true },
      { key: 'userId', label: '用户 ID（管理员代管时填写）', required: false },
    ],
    capabilities: { status: true, remark: true, weight: true, lines: true, addDomain: true },
  },
  {
    type: 'henet', name: 'HE.net', supported: true,
    fields: [
      { key: 'username', label: '用户名', required: true },
      { key: 'password', label: '密码', required: true, secret: true },
    ],
    capabilities: { status: false, remark: false, weight: false, lines: true, addDomain: false },
  },
  {
    type: 'powerdns', name: 'PowerDNS', supported: true,
    fields: [
      { key: 'ip', label: 'API 地址', required: true },
      { key: 'port', label: 'API 端口', required: true },
      { key: 'apikey', label: 'API Key', required: true, secret: true },
    ],
    capabilities: { status: true, remark: true, weight: false, lines: true, addDomain: true },
  },
  {
    type: 'technitium', name: 'Technitium DNS', supported: true,
    fields: [
      { key: 'url', label: '面板地址', required: true },
      { key: 'token', label: 'API Token', required: true, secret: true },
    ],
    capabilities: { status: true, remark: true, weight: false, lines: true, addDomain: true },
  },
];

export const unportedProviders: string[] = [];

export function providerCatalog(): { providers: ProviderMeta[]; unported: string[] } {
  return { providers: catalog, unported: unportedProviders };
}

export function providerMeta(type: string): ProviderMeta {
  const meta = catalog.find((item) => item.type === type);
  if (!meta) {
    if (unportedProviders.includes(type)) throw new DnsError(`DNS 驱动 ${type} 尚未移植`, 501, 'DNS_PROVIDER_NOT_PORTED');
    throw new DnsError('未知的 DNS 驱动', 400, 'INVALID_DNS_PROVIDER');
  }
  return meta;
}

export function validateProviderConfig(type: string, config: unknown): Record<string, string> {
  const meta = providerMeta(type);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new DnsError('账户配置必须是对象', 400, 'INVALID_ACCOUNT_CONFIG');
  const source = config as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const field of meta.fields) {
    const value = source[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new DnsError(`缺少配置项 ${field.label}`, 400, 'INVALID_ACCOUNT_CONFIG');
      continue;
    }
    if (typeof value !== 'string' || value.length > 512) throw new DnsError(`配置项 ${field.label} 格式无效`, 400, 'INVALID_ACCOUNT_CONFIG');
    result[field.key] = value;
  }
  return result;
}

export function createProvider(type: string, config: Record<string, string>, fetchImpl: typeof fetch = fetch): DnsProvider {
  providerMeta(type);
  switch (type) {
    case 'cloudflare':
      return createCloudflareProvider({ apikey: config.apikey ?? '', email: config.email }, fetchImpl);
    case 'aliyun':
      return createAliyunProvider({ AccessKeyId: config.AccessKeyId ?? '', AccessKeySecret: config.AccessKeySecret ?? '' }, fetchImpl);
    case 'dnspod':
      return createDnspodProvider({ SecretId: config.SecretId ?? '', SecretKey: config.SecretKey ?? '' }, fetchImpl);
    case 'tencenteo':
      return createTencentEoProvider({ SecretId: config.SecretId ?? '', SecretKey: config.SecretKey ?? '', site_type: config.site_type }, fetchImpl);
    case 'aliyunesa':
      return createAliyunEsaProvider({
        AccessKeyId: config.AccessKeyId ?? '', AccessKeySecret: config.AccessKeySecret ?? '', region: config.region,
      }, fetchImpl);
    case 'aws':
      return createAwsProvider({ AccessKeyId: config.AccessKeyId ?? '', SecretAccessKey: config.SecretAccessKey ?? '' }, fetchImpl);
    case 'baidu':
      return createBaiduProvider({ AccessKeyId: config.AccessKeyId ?? '', SecretAccessKey: config.SecretAccessKey ?? '' }, fetchImpl);
    case 'huawei':
      return createHuaweiProvider({ AccessKeyId: config.AccessKeyId ?? '', SecretAccessKey: config.SecretAccessKey ?? '' }, fetchImpl);
    case 'huoshan':
      return createHuoshanProvider({ AccessKeyId: config.AccessKeyId ?? '', SecretAccessKey: config.SecretAccessKey ?? '' }, fetchImpl);
    case 'jdcloud':
      return createJdcloudProvider({ AccessKeyId: config.AccessKeyId ?? '', AccessKeySecret: config.AccessKeySecret ?? '' }, fetchImpl);
    case 'qingcloud':
      return createQingcloudProvider({
        access_key_id: config.access_key_id ?? '', secret_access_key: config.secret_access_key ?? '',
      }, fetchImpl);
    case 'namesilo':
      return createNamesiloProvider({ apikey: config.apikey ?? '' }, fetchImpl);
    case 'spaceship':
      return createSpaceshipProvider({ apikey: config.apikey ?? '', apisecret: config.apisecret ?? '' }, fetchImpl);
    case 'west':
      return createWestProvider({ username: config.username ?? '', api_password: config.api_password ?? '' }, fetchImpl);
    case 'bt':
      return createBtProvider({ AccountID: config.AccountID ?? '', AccessKey: config.AccessKey ?? '', SecretKey: config.SecretKey ?? '' }, fetchImpl);
    case 'dnsla':
      return createDnslaProvider({ apiid: config.apiid ?? '', apisecret: config.apisecret ?? '' }, fetchImpl);
    case 'dnsmgr':
      return createDnsmgrProvider({ base_url: config.base_url ?? '', uid: config.uid ?? '', key: config.key ?? '' }, fetchImpl);
    case 'dynv6':
      return createDynv6Provider({ token: config.token ?? '' }, fetchImpl);
    case 'goedge':
      return createGoEdgeProvider({
        base_url: config.base_url ?? '',
        accessKeyId: config.accessKeyId ?? '',
        accessKey: config.accessKey ?? '',
        type: config.type,
        nsClusterId: config.nsClusterId,
        userId: config.userId,
      }, fetchImpl);
    case 'henet':
      return createHenetProvider({ username: config.username ?? '', password: config.password ?? '' }, fetchImpl);
    case 'powerdns':
      return createPowerDnsProvider({ ip: config.ip ?? '', port: config.port ?? '', apikey: config.apikey ?? '' }, fetchImpl);
    case 'technitium':
      return createTechnitiumProvider({ url: config.url ?? '', token: config.token ?? '' }, fetchImpl);
    default:
      throw new DnsError('未知的 DNS 驱动', 400, 'INVALID_DNS_PROVIDER');
  }
}
