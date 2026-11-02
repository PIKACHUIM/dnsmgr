import { DnsError, type DnsProvider } from './types';
import { createAliyunProvider } from './providers/aliyun';
import { createCloudflareProvider } from './providers/cloudflare';
import { createDnspodProvider } from './providers/dnspod';

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
];

// 旧版还有 19 个驱动（aws/baidu/bt/dnsla/dnsmgr/dynv6/goedge/henet/huawei/huoshan/jdcloud/
// namesilo/powerdns/qingcloud/spaceship/technitium/tencenteo/west/aliyunesa）尚未移植。
// 这里显式标注，避免 UI 让人误以为可用。
export const unportedProviders = [
  'aliyunesa', 'aws', 'baidu', 'bt', 'dnsla', 'dnsmgr', 'dynv6', 'goedge', 'henet', 'huawei',
  'huoshan', 'jdcloud', 'namesilo', 'powerdns', 'qingcloud', 'spaceship', 'technitium', 'tencenteo', 'west',
];

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
    default:
      throw new DnsError(`DNS 驱动 ${type} 尚未移植`, 501, 'DNS_PROVIDER_NOT_PORTED');
  }
}
