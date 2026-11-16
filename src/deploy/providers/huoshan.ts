import { hmacSha256Raw, hexOf, sha256Hex } from '../../dns/sign';
import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRaw } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const encoder = new TextEncoder();

interface VolcClient {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  service: string;
  version: string;
  region: string;
}

function escape(value: string): string {
  return encodeURIComponent(value).replaceAll('+', '%20').replaceAll('*', '%2A').replaceAll('%7E', '~');
}

function buildQuery(query: Record<string, string>): string {
  return Object.keys(query).sort().map((key) => `${escape(key)}=${escape(query[key] ?? '')}`).join('&');
}

function volcDate(now: number): string {
  return new Date(now * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function sign(
  client: VolcClient, method: string, query: Record<string, string>, headers: Record<string, string>, body: string, now: number,
): Promise<string> {
  const algorithm = client.service === 'tos' ? 'TOS4-HMAC-SHA256' : 'HMAC-SHA256';
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value.trim();
  const names = Object.keys(normalized).sort();
  const canonicalHeaders = names.map((name) => `${name}:${normalized[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method, '/', buildQuery(query), canonicalHeaders, signedHeaders, await sha256Hex(body),
  ].join('\n');
  const date = volcDate(now);
  const shortDate = date.slice(0, 8);
  const scope = `${shortDate}/${client.region}/${client.service}/request`;
  const stringToSign = [algorithm, date, scope, await sha256Hex(canonicalRequest)].join('\n');
  const kDate = await hmacSha256Raw(encoder.encode(client.secretAccessKey), shortDate);
  const kRegion = await hmacSha256Raw(kDate, client.region);
  const kService = await hmacSha256Raw(kRegion, client.service);
  const kSigning = await hmacSha256Raw(kService, 'request');
  const signature = hexOf(await hmacSha256Raw(kSigning, stringToSign));
  return `${algorithm} Credential=${client.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function send(
  runtime: DeployRuntime, client: VolcClient, method: string, query: Record<string, string>,
  headers: Record<string, string>, body: string,
): Promise<unknown> {
  const now = Math.floor(Date.now() / 1000);
  const allHeaders: Record<string, string> = { host: client.endpoint, accept: 'application/json', ...headers };
  allHeaders[client.service === 'tos' ? 'x-tos-date' : 'x-date'] = volcDate(now);
  if (body) allHeaders['content-type'] = 'application/json';
  const queryString = buildQuery(query);
  const url = `https://${client.endpoint}/${queryString ? `?${queryString}` : ''}`;
  allHeaders.authorization = await sign(client, method, query, allHeaders, body, now);
  const response = await deployRaw(runtime, url, {
    method, headers: allHeaders, body: body || undefined, timeoutMs: 20_000,
  }, '火山引擎');
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { parsed = null; }
  const meta = parsed?.ResponseMetadata;
  const error = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).Error : undefined;
  if (error && typeof error === 'object') {
    const detail = error as Record<string, unknown>;
    const message = detail.MessageCN ?? detail.Message;
    if (typeof message === 'string' && message) throw new Error(message);
  }
  if (response.status === 200) return parsed?.Result ?? true;
  const fallback = parsed?.Message ?? parsed?.message;
  if (typeof fallback === 'string' && fallback) throw new Error(fallback);
  throw new Error(`返回数据解析失败(http_code=${response.status})`);
}

async function request(
  runtime: DeployRuntime, client: VolcClient, method: 'GET' | 'POST', action: string,
  params?: Record<string, unknown> | unknown[], querys?: Record<string, string>,
): Promise<unknown> {
  const query: Record<string, string> = { Action: action, Version: client.version };
  let body = '';
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue;
      query[key] = String(value);
    }
  } else {
    const hasParams = Array.isArray(params) ? params.length > 0 : Boolean(params && Object.keys(params).length > 0);
    body = hasParams ? JSON.stringify(params) : '';
    if (querys) Object.assign(query, querys);
  }
  return send(runtime, client, method, query, {}, body);
}

function client(config: DeployTaskConfig, endpoint: string, service: string, version: string, region: string): VolcClient {
  return {
    accessKeyId: requireField(config, 'AccessKeyId', 'AccessKeyId'),
    secretAccessKey: requireField(config, 'SecretAccessKey', 'SecretAccessKey'),
    endpoint, service, version, region,
  };
}

async function certId(
  runtime: DeployRuntime, config: DeployTaskConfig, material: { fullchain: string; privateKey: string },
): Promise<string> {
  const name = certificateName(material.fullchain);
  const params: Record<string, unknown> = {
    Tag: name,
    Repeatable: false,
    CertificateInfo: { CertificateChain: material.fullchain, PrivateKey: material.privateKey },
  };
  if (typeof config.project_name === 'string' && config.project_name) params.ProjectName = config.project_name;
  let data: Record<string, unknown>;
  try {
    const value = await request(runtime, client(config, 'certificate-service.volcengineapi.com', 'certificate_service', '2024-10-01', 'cn-beijing'),
      'POST', 'ImportCertificate', params);
    data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const instanceId = typeof data.InstanceId === 'string' ? data.InstanceId : '';
  if (instanceId) {
    runtime.log(`上传证书成功 CertId=${instanceId}`);
    await delay(1000);
    await request(runtime, client(config, 'certificate-service.volcengineapi.com', 'certificate_service', '2024-10-01', 'cn-beijing'),
      'POST', 'CertificateUpdateInstance', { InstanceId: instanceId, Options: { ExpiredNotice: 'Disabled' } });
    return instanceId;
  }
  const repeatId = typeof data.RepeatId === 'string' ? data.RepeatId : '';
  if (!repeatId) throw new Error('获取证书ID失败');
  runtime.log(`找到已上传的证书 CertId=${repeatId}`);
  return repeatId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const huoshan: DeployProvider = {
  meta: deployMeta('huoshan'),

  async check(config, runtime) {
    await request(runtime, client(config, 'open.volcengineapi.com', 'cdn', '2021-03-01', 'cn-north-1'),
      'POST', 'ListCertInfo', { Source: 'volc_cert_center' });
  },

  async deploy(taskConfig, config, material, runtime) {
    const product = typeof taskConfig.product === 'string' && taskConfig.product ? taskConfig.product : 'cdn';
    const domains = splitList(taskConfig.domain);

    if (product === 'live') {
      requireField(taskConfig, 'domain', '绑定的域名');
      const live = client(config, 'live.volcengineapi.com', 'live', '2023-01-01', 'cn-north-1');
      const params: Record<string, unknown> = {
        CertName: certificateName(material.fullchain),
        Rsa: { Pubkey: material.fullchain, Prikey: material.privateKey },
        UseWay: 'https',
      };
      if (typeof taskConfig.project_name === 'string' && taskConfig.project_name) params.ProjectName = taskConfig.project_name;
      const created = await request(runtime, live, 'POST', 'CreateCert', params);
      const chainId = created && typeof created === 'object' ? (created as Record<string, unknown>).ChainID : undefined;
      runtime.log(`上传证书成功 ChainID=${String(chainId ?? '')}`);
      for (const domain of domains) {
        await request(runtime, live, 'POST', 'BindCert', { ChainID: chainId, Domain: domain, HTTPS: true, HTTP2: true });
        runtime.log(`视频直播域名 ${domain} 部署证书成功！`);
      }
      return;
    }

    const id = await certId(runtime, config, material);
    runtime.state.cert_id = id;

    if (product === 'upload') return;
    if (product === 'cdn') {
      requireField(taskConfig, 'domain', '绑定的域名');
      const data = await request(runtime, client(config, 'cdn.volcengineapi.com', 'cdn', '2021-03-01', 'cn-north-1'),
        'POST', 'BatchDeployCert', { CertId: id, Domain: taskConfig.domain });
      const results = data && typeof data === 'object' ? (data as Record<string, unknown>).DeployResult : undefined;
      if (!Array.isArray(results) || results.length === 0) throw new Error('部署证书失败：DeployResult为空');
      for (const row of results) {
        const item = row as Record<string, unknown>;
        if (item.Status === 'success') runtime.log(`CDN域名 ${String(item.Domain)} 部署证书成功！`);
        else runtime.log(`CDN域名 ${String(item.Domain)} 部署证书失败：${String(item.ErrorMsg ?? '')}`);
      }
      return;
    }
    if (product === 'dcdn') {
      requireField(taskConfig, 'domain', '绑定的域名');
      await request(runtime, client(config, 'open.volcengineapi.com', 'dcdn', '2021-04-01', 'cn-north-1'),
        'POST', 'CreateCertBind', { CertId: id, DomainNames: domains });
      runtime.log(`DCDN域名 ${taskConfig.domain} 部署证书成功！`);
      return;
    }
    if (product === 'tos') {
      const bucketDomain = requireField(taskConfig, 'bucket_domain', 'Bucket域名');
      requireField(taskConfig, 'domain', '绑定的域名');
      const tos = client(config, bucketDomain, 'tos', '2021-04-01', 'cn-beijing');
      for (const domain of domains) {
        const body = JSON.stringify({ CustomDomainRule: { Domain: domain, CertId: id } });
        await send(runtime, tos, 'PUT', { customdomain: '' }, {
          'x-tos-content-sha256': await sha256Hex(body),
        }, body);
        runtime.log(`对象存储域名 ${domain} 部署证书成功！`);
      }
      return;
    }
    if (product === 'imagex') {
      requireField(taskConfig, 'domain', '绑定的域名');
      for (const domain of domains) {
        const data = await request(runtime, client(config, 'imagex.volcengineapi.com', 'imagex', '2018-08-01', 'cn-north-1'),
          'POST', 'UpdateImageBatchDomainCert', [{ domain, cert_id: id }]);
        const result = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const failed = Array.isArray(result.FailedDomains) ? result.FailedDomains : [];
        if (Array.isArray(result.SuccessDomains) && result.SuccessDomains.length > 0) {
          runtime.log(`veImageX域名 ${domain} 部署证书成功！`);
        } else if (failed.length > 0) {
          const first = failed[0] as Record<string, unknown>;
          runtime.log(`veImageX域名 ${domain} 部署证书失败：${String(first.ErrMsg ?? '')}`);
        } else {
          runtime.log(`veImageX域名 ${domain} 部署证书失败`);
        }
      }
      return;
    }
    if (product === 'clb' || product === 'alb') {
      const listenerId = requireField(taskConfig, 'listener_id', '监听器ID');
      await request(runtime, client(config, 'open.volcengineapi.com', product, '2020-04-01', 'cn-beijing'),
        'GET', 'ModifyListenerAttributes', {
          ListenerId: listenerId, CertificateSource: 'cert_center', CertCenterCertificateId: id,
        });
      runtime.log(`${product.toUpperCase()}监听器 ${listenerId} 部署证书成功！`);
      return;
    }
    if (product === 'vod') {
      requireField(taskConfig, 'domain', '绑定的域名');
      const spaceName = requireField(taskConfig, 'vod_space_name', '点播空间名称');
      const domainType = typeof taskConfig.vod_domain_type === 'string' && taskConfig.vod_domain_type ? taskConfig.vod_domain_type : 'play';
      const vod = client(config, 'vod.volcengineapi.com', 'vod', '2023-07-01', 'cn-north-1');
      for (const domain of domains) {
        await request(runtime, vod, 'POST', 'UpdateDomainConfig', {
          SpaceName: spaceName,
          DomainType: domainType,
          Domain: domain,
          Config: { HTTPS: { Switch: true, CertInfo: { CertId: id } } },
        });
        runtime.log(`视频点播域名 ${domain} 部署证书成功！`);
      }
    }
  },
};
