import { hmacSha256Raw, base64Of, sha256Hex } from '../../dns/sign';
import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRaw, withQuery } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const encoder = new TextEncoder();

interface CtyunClient {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
}

function escape(value: string): string {
  return encodeURIComponent(value).replaceAll('+', '%20').replaceAll('*', '%2A').replaceAll('%7E', '~');
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${escape(key)}=${escape(query[key] ?? '')}`)
    .join('&');
}

async function authorization(
  client: CtyunClient, date: string, query: Record<string, string>, headers: Record<string, string>, body: string,
): Promise<string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value.trim();
  const names = Object.keys(normalized).sort();
  const canonicalHeaders = names.map((name) => `${name}:${normalized[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const stringToSign = [canonicalHeaders, canonicalQuery(query), await sha256Hex(body)].join('\n');
  const kTime = await hmacSha256Raw(encoder.encode(client.secretAccessKey), date);
  const kAk = await hmacSha256Raw(kTime, client.accessKeyId);
  const kDate = await hmacSha256Raw(kAk, date.slice(0, 8));
  const signature = base64Of(await hmacSha256Raw(kDate, stringToSign));
  return `${client.accessKeyId} Headers=${signedHeaders} Signature=${signature}`;
}

function ctyunDate(now = Date.now()): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

async function request(
  runtime: DeployRuntime, client: CtyunClient, method: string, path: string,
  query?: Record<string, string>, params?: Record<string, unknown>,
): Promise<unknown> {
  const date = ctyunDate();
  const body = params && Object.keys(params).length > 0 ? JSON.stringify(params) : '';
  const headers: Record<string, string> = {
    accept: 'application/json',
    host: client.endpoint,
    'eop-date': date,
    'ctyun-eop-request-id': crypto.randomUUID().replace(/-/g, ''),
  };
  if (body) headers['content-type'] = 'application/json';
  headers['eop-authorization'] = await authorization(client, date, query ?? {}, headers, body);
  const url = withQuery(`https://${client.endpoint}${path}`, query ?? {});
  const response = await deployRaw(runtime, url, {
    method, headers, body: body || undefined, timeoutMs: 20_000,
  }, '天翼云');
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad');
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error('返回数据解析失败');
  }
  const statusCode = Number(parsed.statusCode ?? NaN);
  if (statusCode === 100000 || (statusCode === 0 && client.endpoint === 'cf-global.ctapi.ctyun.cn')) {
    return parsed.returnObj ?? true;
  }
  const message = parsed.errorMessage ?? parsed.message;
  if (typeof message === 'string' && message) throw new Error(message);
  throw new Error('返回数据解析失败');
}

function client(config: DeployTaskConfig, endpoint: string): CtyunClient {
  return {
    accessKeyId: requireField(config, 'AccessKeyId', 'AccessKeyId'),
    secretAccessKey: requireField(config, 'SecretAccessKey', 'SecretAccessKey'),
    endpoint,
  };
}

async function uploadCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, endpoint: string, path: string,
  name: string, material: { fullchain: string; privateKey: string },
): Promise<void> {
  try {
    await request(runtime, client(config, endpoint), 'POST', path, undefined, {
      name, key: material.privateKey, certs: material.fullchain,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('已存在重名的证书')) {
      runtime.log(`已存在重名的证书 cert_name=${name}`);
    } else {
      throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
  }
  runtime.log(`上传证书成功 cert_name=${name}`);
}

async function bindDomain(
  runtime: DeployRuntime, config: DeployTaskConfig, endpoint: string, domain: string, name: string,
): Promise<void> {
  try {
    await request(runtime, client(config, endpoint), 'POST', '/v1/domain/update-domain', undefined, {
      domain, https_status: 'on', cert_name: name,
    });
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('请求已提交，请勿重复操作！'))) throw error;
  }
  runtime.log(`CDN域名 ${domain} 部署证书成功！`);
}

const ACCESSONE_EXCLUDE = new Set([
  'status', 'area_scope', 'cname', 'insert_date', 'status_date', 'record_status', 'record_num',
  'customer_name', 'outlink_replace_filter', 'website_ipv6_access_mark', 'websocket_speed',
  'dynamic_config', 'dynamic_ability',
]);

async function deployAccessOne(
  runtime: DeployRuntime, config: DeployTaskConfig, name: string, material: { fullchain: string; privateKey: string },
  domains: string[],
): Promise<void> {
  const endpoint = 'accessone-global.ctapi.ctyun.cn';
  await uploadCertificate(runtime, config, endpoint, '/ctapi/v1/accessone/cert/create', name, material);
  for (const domain of domains) {
    let result: Record<string, unknown>;
    try {
      const value = await request(runtime, client(config, endpoint), 'POST', '/ctapi/v1/accessone/domain/config', undefined, {
        domain, product_code: '020',
      });
      result = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
    } catch (error) {
      throw new Error(`查询域名配置失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    if (result.https_status === 'on' && result.cert_name === name) {
      runtime.log(`边缘安全加速域名 ${domain} 证书已部署，无需重复操作！`);
      return;
    }
    result.https_status = 'on';
    result.cert_name = name;
    for (const key of Object.keys(result)) {
      const value = result[key];
      if (ACCESSONE_EXCLUDE.has(key) || (Array.isArray(value) && value.length === 0)) delete result[key];
    }
    const origin = result.origin;
    if (Array.isArray(origin)) {
      for (const entry of origin) {
        if (entry && typeof entry === 'object' && 'weight' in entry) {
          (entry as Record<string, unknown>).weight = String((entry as Record<string, unknown>).weight ?? '');
        }
      }
    }
    try {
      await request(runtime, client(config, endpoint), 'POST', '/ctapi/v1/scdn/domain/modify_config', undefined, result);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('请求已提交，请勿重复操作！'))) throw error;
    }
    runtime.log(`边缘安全加速域名 ${domain} 部署证书成功！`);
  }
}

async function deployCf(
  runtime: DeployRuntime, config: DeployTaskConfig, name: string, material: { fullchain: string; privateKey: string },
  domains: string[],
): Promise<void> {
  const regionId = requireField(config, 'region_id', '所属地域');
  const endpoint = 'cf-global.ctapi.ctyun.cn';
  for (const domain of domains) {
    let data: Record<string, unknown>;
    try {
      const value = await request(runtime, client(config, endpoint), 'GET',
        `/openapi/v1/domains/customdomains/${encodeURIComponent(domain)}`, { regionId });
      data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch (error) {
      throw new Error(`获取自定义域名配置失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    const certConfig = (data.certConfig && typeof data.certConfig === 'object' ? data.certConfig : {}) as Record<string, unknown>;
    if (typeof certConfig.certificate === 'string' && certConfig.certificate.trim() === material.fullchain.trim()) {
      runtime.log(`函数计算域名 ${domain} 证书已部署，无需重复操作！`);
      return;
    }
    const protocol = data.protocol === 'HTTP' ? 'HTTP,HTTPS' : data.protocol;
    try {
      await request(runtime, client(config, endpoint), 'PUT',
        `/openapi/v1/domains/customdomains/${encodeURIComponent(domain)}`, { regionId }, {
          domainName: domain,
          description: data.description,
          protocol,
          certConfig: {
            certName: `cert${name.slice(name.indexOf('-') + 1)}`,
            certificate: material.fullchain,
            privateKey: material.privateKey,
          },
          authConfig: data.authConfig,
          routeConfig: data.routeConfig,
        });
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('请求已提交，请勿重复操作！'))) throw error;
    }
    runtime.log(`函数计算域名 ${domain} 部署证书成功！`);
  }
}

export const ctyun: DeployProvider = {
  meta: deployMeta('ctyun'),

  async check(config, runtime) {
    await request(runtime, client(config, 'ctcdn-global.ctapi.ctyun.cn'), 'GET', '/v1/cert/query-cert-list');
  },

  async deploy(taskConfig, config, material, runtime) {
    const product = typeof taskConfig.product === 'string' && taskConfig.product ? taskConfig.product : 'cdn';
    requireField(taskConfig, 'domain', '绑定的域名');
    const name = certificateName(material.fullchain);
    const domains = splitList(taskConfig.domain);

    if (product === 'cdn' || product === 'icdn') {
      const endpoint = product === 'cdn' ? 'ctcdn-global.ctapi.ctyun.cn' : 'icdn-global.ctapi.ctyun.cn';
      await uploadCertificate(runtime, config, endpoint, '/v1/cert/creat-cert', name, material);
      for (const domain of domains) await bindDomain(runtime, config, endpoint, domain, name);
      return;
    }
    if (product === 'accessone') {
      await deployAccessOne(runtime, config, name, material, domains);
      return;
    }
    if (product === 'cf') {
      await deployCf(runtime, config, name, material, domains);
      return;
    }
  },
};
