import { aliyunSignature, md5Hex, sha256Hex } from '../../dns/sign';
import { hmacSha1Base64 } from '../sign';
import { certificateInfo, certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRaw, formBody, withQuery } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function stringifyParams(params: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    result[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
  }
  return result;
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nonce(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

interface RpcClient {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  version: string;
}

async function rpc(
  runtime: DeployRuntime, client: RpcClient, params: Record<string, unknown>, method: 'GET' | 'POST' = 'POST',
): Promise<Record<string, unknown>> {
  const data = stringifyParams({
    Format: 'JSON',
    Version: client.version,
    AccessKeyId: client.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: timestamp(),
    SignatureVersion: '1.0',
    SignatureNonce: nonce(),
    ...params,
  });
  data.Signature = await aliyunSignature(client.accessKeySecret, data, method);
  const url = `https://${client.endpoint}/`;
  const response = await deployRaw(runtime, method === 'GET' ? withQuery(url, data) : url, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
    body: method === 'POST' ? formBody(data) : undefined,
    timeoutMs: 20_000,
  }, '阿里云');
  const body = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { parsed = null; }
  if (response.status === 200) return parsed ?? {};
  if (parsed && typeof parsed.Message === 'string') throw new Error(parsed.Message);
  throw new Error('返回数据解析失败');
}

function rpcClient(config: DeployTaskConfig, endpoint: string, version: string): RpcClient {
  return {
    accessKeyId: requireField(config, 'AccessKeyId', 'AccessKeyId'),
    accessKeySecret: requireField(config, 'AccessKeySecret', 'AccessKeySecret'),
    endpoint, version,
  };
}

function escapeAliyun(value: string): string {
  return encodeURIComponent(value).replaceAll('+', '%20').replaceAll('*', '%2A').replaceAll('%7E', '~');
}

interface RoaClient {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint: string;
  version: string;
}

async function roa(
  runtime: DeployRuntime, client: RoaClient, method: 'GET' | 'PUT', action: string, path: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = method === 'GET' ? stringifyParams(params ?? {}) : {};
  const body = method === 'GET' ? '' : params && Object.keys(params).length > 0 ? JSON.stringify(params) : '';
  const headers: Record<string, string> = {
    host: client.endpoint,
    'x-acs-action': action,
    'x-acs-version': client.version,
    'x-acs-signature-nonce': md5Hex(`${Math.random()}${Date.now()}`),
    'x-acs-date': timestamp(),
    'x-acs-content-sha256': await sha256Hex(body),
    accept: 'application/json',
  };
  if (body) headers['content-type'] = 'application/json; charset=utf-8';
  const canonicalUri = path.split('/').map((segment) => escapeAliyun(segment)).join('/');
  const canonicalQuery = Object.keys(query).sort()
    .map((key) => `${escapeAliyun(key)}=${escapeAliyun(query[key] ?? '')}`).join('&');
  const names = Object.keys(headers).map((key) => key.toLowerCase()).sort();
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value.trim();
  const canonicalHeaders = names.map((name) => `${name}:${normalized[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, await sha256Hex(body),
  ].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${await sha256Hex(canonicalRequest)}`;
  const signingKey = await importHmacKey(client.accessKeySecret);
  const signature = hex(await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(stringToSign)));
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${client.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  const url = `https://${client.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  const response = await deployRaw(runtime, url, {
    method, headers, body: body || undefined, timeoutMs: 20_000,
  }, '阿里云');
  const responseBody = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(responseBody);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { parsed = null; }
  if (response.status === 200) return parsed ?? {};
  if (parsed && typeof parsed.Message === 'string') {
    const message = parsed.Message;
    const dot = message.indexOf('.');
    throw new Error(dot > 0 ? message.slice(0, dot + 1) : message);
  }
  throw new Error('返回数据解析失败');
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * OSS 的 CNAME 证书绑定走 Bucket 域名 + HMAC-SHA1（VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedResource）。
 */
async function ossAddCnameCertificate(
  runtime: DeployRuntime, client: { accessKeyId: string; accessKeySecret: string; endpoint: string },
  bucket: string, domain: string, certId: string,
): Promise<void> {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<BucketCnameConfiguration><Cname><Domain>${domain}</Domain>`
    + `<CertificateConfiguration><CertId>${certId}</CertId><Force>true</Force></CertificateConfiguration>`
    + '</Cname></BucketCnameConfiguration>';
  const date = new Date().toUTCString();
  const contentType = 'application/xml';
  // CanonicalizedResource = /bucket/ + 按字典序排列的签名子资源（空值只保留键名）。
  const signature = await hmacSha1Base64(client.accessKeySecret,
    `POST\n\n${contentType}\n${date}\n/${bucket}/?cname&comp=add`);
  const response = await deployRaw(runtime, `https://${bucket}.${client.endpoint}/?cname&comp=add`, {
    method: 'POST',
    headers: {
      date,
      'content-type': contentType,
      authorization: `OSS ${client.accessKeyId}:${signature}`,
    },
    body,
    timeoutMs: 20_000,
  }, '阿里云OSS');
  const responseBody = await response.text();
  if (response.status >= 200 && response.status < 300) return;
  const message = /<Message>([\s\S]*?)<\/Message>/.exec(responseBody)?.[1];
  throw new Error(message ? message.trim() : `HTTP Code: ${response.status}`);
}

interface AliyunAccount {
  accessKeyId: string;
  accessKeySecret: string;
}

function account(config: DeployTaskConfig): AliyunAccount {
  return {
    accessKeyId: requireField(config, 'AccessKeyId', 'AccessKeyId'),
    accessKeySecret: requireField(config, 'AccessKeySecret', 'AccessKeySecret'),
  };
}

function casEndpoint(config: DeployTaskConfig): string {
  return config.region === 'ap-southeast-1' ? 'cas.ap-southeast-1.aliyuncs.com' : 'cas.aliyuncs.com';
}

async function certificateId(
  runtime: DeployRuntime, config: DeployTaskConfig, material: { fullchain: string; privateKey: string },
): Promise<{ id: string; name: string }> {
  const info = certificateInfo(material.fullchain);
  let name = certificateName(material.fullchain);
  const serial = info.serialNumber.toLowerCase();
  const client = rpcClient(config, casEndpoint(config), '2020-04-07');

  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, {
      Action: 'ListUserCertificateOrder', Keyword: info.commonName, OrderType: 'CERT',
    });
  } catch (error) {
    throw new Error(`查询证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  if (Number(data.TotalCount ?? 0) > 0) {
    for (const certificate of arr(data.CertificateOrderList)) {
      const serialNo = text(certificate.SerialNo).toLowerCase();
      if (serialNo === serial || serialNo.includes(serial)) {
        runtime.log(`找到已上传的证书 CertId=${text(certificate.CertificateId)}`);
        return { id: text(certificate.CertificateId), name: text(certificate.Name) };
      }
    }
  }

  try {
    data = await rpc(runtime, client, {
      Action: 'UploadUserCertificate', Name: name, Cert: material.fullchain, Key: material.privateKey,
    });
  } catch (error) {
    throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const certId = text(data.CertId);
  runtime.log(`证书上传成功！CertId=${certId}`);
  await delay(500);
  return { id: certId, name };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setSslCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, options: {
    label: string; endpoint: string; version: string; action: string;
    domains: string[]; certId: string; certName: string;
  },
): Promise<void> {
  const client = rpcClient(config, options.endpoint, options.version);
  for (const domain of options.domains) {
    await rpc(runtime, client, {
      Action: options.action,
      DomainName: domain,
      CertName: options.certName,
      CertType: 'cas',
      SSLProtocol: 'on',
      CertId: options.certId,
    });
    runtime.log(`${options.label}域名 ${domain} 部署证书成功！`);
  }
}

async function deployEsa(
  runtime: DeployRuntime, config: DeployTaskConfig, certId: string, certName: string, domains: string[],
): Promise<void> {
  const sitename = requireField(config, 'esa_sitename', 'ESA站点域名');
  const region = typeof config.region === 'string' && config.region ? config.region : 'cn-hangzhou';
  const client = rpcClient(config, region === 'ap-southeast-1' ? 'esa.ap-southeast-1.aliyuncs.com' : 'esa.cn-hangzhou.aliyuncs.com', '2024-09-10');

  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, { Action: 'ListSites', SiteName: sitename, SiteSearchType: 'exact' }, 'GET');
  } catch (error) {
    throw new Error(`查询ESA站点列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const sites = arr(data.Sites);
  if (Number(data.TotalCount ?? 0) === 0 || sites.length === 0) throw new Error(`ESA站点 ${sitename} 不存在`);
  runtime.log(`成功查询到${String(data.TotalCount)}个ESA站点`);
  const siteId = text(sites[0]!.SiteId);

  try {
    data = await rpc(runtime, client, { Action: 'ListCertificates', SiteId: siteId }, 'GET');
  } catch (error) {
    throw new Error(`查询ESA站点${sitename}证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  runtime.log(`ESA站点 ${sitename} 查询到${String(data.TotalCount ?? 0)}个SSL证书`);

  let exist: Record<string, unknown> | null = null;
  let oldest: Record<string, unknown> | null = null;
  for (const certificate of arr(data.Result)) {
    if (certificate.Type === 'free') continue;
    const sanDomains = text(certificate.SAN).split(',');
    if (sanDomains.every((domain) => domains.includes(domain))) { exist = certificate; break; }
    if (!oldest) oldest = certificate;
    else if (Date.parse(text(certificate.CreateTime)) < Date.parse(text(oldest.CreateTime))) oldest = certificate;
  }

  if (!exist) {
    try {
      const quota = await rpc(runtime, client, {
        Action: 'ListInstanceQuotasWithUsage', SiteId: siteId, QuotaNames: 'customHttpCert',
      }, 'GET');
      const quotas = arr(quota.Quotas);
      const first = quotas[0];
      if (first && Number(first.Usage ?? 0) >= Number(first.QuotaValue ?? 0) && oldest) {
        await rpc(runtime, client, { Action: 'DeleteCertificate', SiteId: siteId, Id: text(oldest.Id) }, 'GET');
        runtime.log(`ESA站点 ${sitename} 删除证书 ${text(oldest.Name)} 成功`);
      }
    } catch (error) {
      throw new Error(`查询或清理ESA站点证书配额失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
  }

  const params: Record<string, unknown> = {
    Action: 'SetCertificate', SiteId: siteId, Type: 'cas', CasId: certId, Name: certName, Region: region,
  };
  if (exist) {
    if (text(exist.CasId) === certId) {
      runtime.log(`ESA站点 ${sitename} 证书已配置，无需重复操作`);
      return;
    }
    params.Id = exist.Id;
  }
  await rpc(runtime, client, params);
  if (exist) runtime.log(`ESA站点 ${sitename} 证书 ${text(exist.Name)} 更新成功`);
  else runtime.log(`ESA站点 ${sitename} 证书添加成功！`);
}

async function deployEsaSaas(
  runtime: DeployRuntime, config: DeployTaskConfig, certId: string,
): Promise<void> {
  const sitename = requireField(config, 'esa_sitename', 'ESA站点域名');
  const saasNames = splitList(config.esa_saas_sitename).map((domain) => domain.toLowerCase());
  if (saasNames.length === 0) throw new Error('ESA SAAS域名不能为空');
  const region = typeof config.region === 'string' && config.region ? config.region : 'cn-hangzhou';
  const client = rpcClient(config, region === 'ap-southeast-1' ? 'esa.ap-southeast-1.aliyuncs.com' : 'esa.cn-hangzhou.aliyuncs.com', '2024-09-10');

  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, { Action: 'ListSites', SiteName: sitename, SiteSearchType: 'exact' }, 'GET');
  } catch (error) {
    throw new Error(`查询ESA站点列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const sites = arr(data.Sites);
  if (Number(data.TotalCount ?? 0) === 0 || sites.length === 0) throw new Error(`ESA站点 ${sitename} 不存在`);
  const siteId = Number(sites[0]!.SiteId);
  if (!Number.isSafeInteger(siteId) || siteId < 1) throw new Error(`ESA站点 ${sitename} 返回的站点ID无效`);
  runtime.log(`成功查询到${String(data.TotalCount)}个ESA站点`);

  let success = 0;
  let failed = 0;
  let firstError = '';
  for (const saasName of [...new Set(saasNames)]) {
    let stage = '查询';
    try {
      const listing = await rpc(runtime, client, {
        Action: 'ListCustomHostnames', Hostname: saasName, SiteId: siteId, NameMatchType: 'exact',
      }, 'GET');
      if (!Number.isInteger(Number(listing.TotalCount)) || !Array.isArray(listing.Hostnames)) {
        throw new Error('返回的域名列表无效');
      }
      if (Number(listing.TotalCount) === 0 || arr(listing.Hostnames).length === 0) throw new Error('域名不存在');
      const matches = arr(listing.Hostnames).filter((hostname) =>
        text(hostname.Hostname).toLowerCase() === saasName && text(hostname.SiteId) === String(siteId));
      if (matches.length === 0) throw new Error('返回的域名或站点不匹配');
      if (matches.length > 1) throw new Error('返回多个匹配域名，无法确定部署目标');
      const hostnameId = Number(matches[0]!.HostnameId);
      if (!Number.isSafeInteger(hostnameId) || hostnameId < 1) throw new Error('返回的HostnameId无效');

      stage = '部署';
      await rpc(runtime, client, {
        Action: 'UpdateCustomHostname',
        HostnameId: hostnameId,
        SslFlag: 'on',
        CertType: 'cas',
        CasId: certId,
        CasRegion: region,
      });
      runtime.log(`ESA SAAS站点 ${saasName} 证书添加成功！`);
      success += 1;
    } catch (error) {
      const message = `ESA SAAS站点 ${saasName} ${stage}失败：${error instanceof Error ? error.message : '请求失败'}`;
      runtime.log(`[Error] ${message}`);
      if (!firstError) firstError = message;
      failed += 1;
    }
  }
  runtime.log(`ESA SAAS证书部署完成：成功 ${success} 个，失败 ${failed} 个`);
  if (failed > 0) throw new Error(`ESA SAAS证书部署完成：成功 ${success} 个，失败 ${failed} 个；详见部署日志；首个错误：${firstError.slice(0, 300)}`);
}

async function deployWaf(runtime: DeployRuntime, config: DeployTaskConfig, certId: string, domains: string[]): Promise<void> {
  const region = typeof config.region === 'string' && config.region ? config.region : 'cn-hangzhou';
  const fullCertId = `${certId}${region === 'ap-southeast-1' ? '-ap-southeast-1' : '-cn-hangzhou'}`;
  const client = rpcClient(config, `wafopenapi.${region}.aliyuncs.com`, '2021-10-01');
  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, { Action: 'DescribeInstance', RegionId: region }, 'GET');
  } catch (error) {
    throw new Error(`获取WAF实例详情失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const instanceId = text(data.InstanceId);
  if (!instanceId) throw new Error('当前账号未找到WAF实例');
  runtime.log(`获取WAF实例ID成功 InstanceId=${instanceId}`);

  for (const domain of domains) {
    let detail: Record<string, unknown>;
    try {
      detail = await rpc(runtime, client, {
        Action: 'DescribeDomainDetail', InstanceId: instanceId, Domain: domain, RegionId: region,
      }, 'GET');
    } catch (error) {
      throw new Error(`查询CNAME接入详情失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    const listen = obj(detail.Listen);
    if (Object.keys(listen).length === 0) throw new Error(`没有找到${domain}监听器`);
    if (text(listen.CertId) && text(listen.CertId) === fullCertId) {
      runtime.log(`WAF域名 ${domain} 证书已配置，无需重复操作`);
      return;
    }
    listen.CertId = fullCertId;
    if (!Array.isArray(listen.HttpsPorts) || listen.HttpsPorts.length === 0) {
      listen.HttpsPorts = [443];
      listen.TLSVersion = 'tlsv1.1';
      listen.EnableTLSv3 = true;
      listen.CipherSuite = 1;
    }
    const redirect = obj(detail.Redirect);
    const backendPorts = arr(redirect.BackendPorts);
    if (backendPorts.length === 1 && backendPorts[0]!.Protocol === 'http') {
      backendPorts.push({ ListenPort: 443, Protocol: 'https', BackendPort: backendPorts[0]!.BackendPort });
      redirect.BackendPorts = backendPorts;
      redirect.FocusHttpBackend = true;
    }
    redirect.Backends = redirect.AllBackends;
    await rpc(runtime, client, {
      Action: 'ModifyDomain',
      InstanceId: instanceId,
      Domain: domain,
      Listen: JSON.stringify(listen),
      Redirect: JSON.stringify(redirect),
      RegionId: region,
    });
    runtime.log(`WAF域名 ${domain} 部署证书成功！`);
  }
}

async function cleanWafExtensionCerts(
  runtime: DeployRuntime, client: RpcClient, instanceId: string, resourceInstanceId: string,
  resourceId: string, region: string,
): Promise<void> {
  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, {
      Action: 'DescribeResourceInstanceCerts', InstanceId: instanceId, ResourceInstanceId: resourceInstanceId, RegionId: region,
    }, 'GET');
  } catch (error) {
    runtime.log(`查询扩展证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
    return;
  }
  const now = Date.now();
  for (const certificate of arr(data.Certs)) {
    const identifier = text(certificate.CertIdentifier);
    const afterDate = text(certificate.AfterDate);
    if (!identifier || !afterDate) continue;
    const expiry = Date.parse(afterDate.replace(' ', 'T'));
    if (!Number.isFinite(expiry) || expiry >= now) continue;
    try {
      await rpc(runtime, client, {
        Action: 'DeleteCloudResourceExtensionCert', InstanceId: instanceId,
        CloudResourceId: resourceId, CertId: identifier, RegionId: region,
      });
      runtime.log(`已删除过期扩展证书：${identifier}`);
    } catch (error) {
      runtime.log(`删除过期扩展证书失败：${identifier} ${error instanceof Error ? error.message : '请求失败'}`);
    }
  }
}

async function deployWafRes(
  runtime: DeployRuntime, config: DeployTaskConfig, certId: string, resourceIds: string[],
): Promise<void> {
  const region = typeof config.region === 'string' && config.region ? config.region : 'cn-hangzhou';
  const fullCertId = `${certId}${region === 'ap-southeast-1' ? '-ap-southeast-1' : '-cn-hangzhou'}`;
  const deployType = Number(config.deploy_type ?? 0);
  const client = rpcClient(config, `wafopenapi.${region}.aliyuncs.com`, '2021-10-01');
  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, { Action: 'DescribeInstance', RegionId: region }, 'GET');
  } catch (error) {
    throw new Error(`获取WAF实例详情失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const instanceId = text(data.InstanceId);
  if (!instanceId) throw new Error('当前账号未找到WAF实例');
  runtime.log(`获取WAF实例ID成功 InstanceId=${instanceId}`);

  for (const resourceId of resourceIds) {
    const parts = resourceId.split('-');
    const resourceInstanceId = parts[parts.length - 3] ?? '';
    if (!resourceInstanceId) throw new Error(`ResourceInstanceId解析失败：${resourceId}`);
    try {
      data = await rpc(runtime, client, {
        Action: 'DescribeCloudResourceList', InstanceId: instanceId, CloudResourceId: resourceId, RegionId: region,
      }, 'GET');
    } catch (error) {
      throw new Error(`查询云产品接入WAF配置失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    if (arr(data.CloudResourceList).length === 0) throw new Error(`WAF云产品接入实例不存在：${resourceId}`);

    if (deployType === 0) {
      await rpc(runtime, client, {
        Action: 'ModifyCloudResourceDefaultCert', InstanceId: instanceId,
        CloudResourceId: resourceId, CertId: fullCertId, RegionId: region,
      });
      runtime.log(`WAF云产品防护对象 ${resourceId} 部署默认证书成功！`);
    } else {
      await rpc(runtime, client, {
        Action: 'CreateCloudResourceExtensionCert', InstanceId: instanceId,
        CloudResourceId: resourceId, CertId: fullCertId, RegionId: region,
      });
      runtime.log(`WAF云产品防护对象 ${resourceId} 部署扩展证书成功！`);
      await cleanWafExtensionCerts(runtime, client, instanceId, resourceInstanceId, resourceId, region);
    }
  }
}

async function deployWaf2(runtime: DeployRuntime, config: DeployTaskConfig, certId: string, domains: string[]): Promise<void> {
  const region = typeof config.region === 'string' && config.region ? config.region : 'cn-hangzhou';
  const client = rpcClient(config, `wafopenapi.${region}.aliyuncs.com`, '2019-09-10');
  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, { Action: 'DescribeInstanceInfo', RegionId: region }, 'GET');
  } catch (error) {
    throw new Error(`获取WAF实例详情失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const instanceId = text(obj(data.InstanceInfo).InstanceId);
  if (!instanceId) throw new Error('当前账号未找到WAF实例');
  runtime.log(`获取WAF实例ID成功 InstanceId=${instanceId}`);
  for (const domain of domains) {
    await rpc(runtime, client, {
      Action: 'CreateCertificateByCertificateId', InstanceId: instanceId, Domain: domain, CertificateId: certId,
    });
    runtime.log(`WAF域名 ${domain} 部署证书成功！`);
  }
}

export const aliyun: DeployProvider = {
  meta: deployMeta('aliyun'),

  async check(config, runtime) {
    await rpc(runtime, rpcClient(config, 'cas.aliyuncs.com', '2020-04-07'), { Action: 'ListUserCertificateOrder' });
  },

  async deploy(taskConfig, config, material, runtime) {
    const product = typeof taskConfig.product === 'string' && taskConfig.product ? taskConfig.product : 'cdn';
    const domains = splitList(taskConfig.domain);
    const region = typeof config.region === 'string' && config.region ? config.region : 'cn-hangzhou';
    const regionId = typeof config.regionid === 'string' && config.regionid ? config.regionid : 'cn-hangzhou';

    if (product === 'api') {
      const groupId = requireField(taskConfig, 'api_groupid', 'API分组ID');
      if (domains.length === 0) throw new Error('API分组绑定域名不能为空');
      const name = certificateName(material.fullchain);
      const client = rpcClient(config, `apigateway.${regionId}.aliyuncs.com`, '2016-07-14');
      for (const domain of domains) {
        await rpc(runtime, client, {
          Action: 'SetDomainCertificate',
          GroupId: groupId,
          DomainName: domain,
          CertificateName: name,
          CertificateBody: material.fullchain,
          CertificatePrivateKey: material.privateKey,
        });
        runtime.log(`API网关域名 ${domain} 部署证书成功！`);
      }
      return;
    }

    if (product === 'vod') {
      if (domains.length === 0) throw new Error('视频点播绑定域名不能为空');
      const client = rpcClient(config, 'vod.cn-shanghai.aliyuncs.com', '2017-03-21');
      for (const domain of domains) {
        await rpc(runtime, client, {
          Action: 'SetVodDomainCertificate',
          DomainName: domain,
          SSLProtocol: 'on',
          SSLPub: material.fullchain,
          SSLPri: material.privateKey,
        });
        runtime.log(`视频点播域名 ${domain} 部署证书成功！`);
      }
      return;
    }

    if (product === 'fc' || product === 'fc2') {
      const cname = requireField(taskConfig, 'fc_cname', '域名CNAME地址');
      if (domains.length === 0) throw new Error('函数计算域名不能为空');
      const version = product === 'fc' ? '2023-03-30' : '2021-04-06';
      const name = certificateName(material.fullchain);
      const client: RoaClient = { ...account(config), endpoint: cname, version };
      for (const domain of domains) {
        let data: Record<string, unknown>;
        try {
          data = await roa(runtime, client, 'GET', 'GetCustomDomain', `/${version}/custom-domains/${encodeURIComponent(domain)}`);
        } catch (error) {
          throw new Error(`获取绑定域名信息失败：${error instanceof Error ? error.message : '请求失败'}`);
        }
        runtime.log('获取函数计算绑定域名信息成功');
        const certConfig = obj(data.certConfig);
        if (text(certConfig.certificate) === material.fullchain) {
          runtime.log(`函数计算域名 ${domain} 证书已配置，无需重复操作`);
          return;
        }
        certConfig.certName = name;
        certConfig.certificate = material.fullchain;
        certConfig.privateKey = material.privateKey;
        const params: Record<string, unknown> = {
          protocol: data.protocol === 'HTTP' ? 'HTTP,HTTPS' : data.protocol,
          routeConfig: data.routeConfig,
          certConfig,
          tlsConfig: data.tlsConfig,
          wafConfig: data.wafConfig,
        };
        if (product === 'fc') params.authConfig = data.authConfig;
        await roa(runtime, client, 'PUT', 'UpdateCustomDomain', `/${version}/custom-domains/${encodeURIComponent(domain)}`, params);
        runtime.log(`函数计算域名 ${domain} 部署证书成功！`);
      }
      return;
    }

    const { id: certId, name: certName } = await certificateId(runtime, config, material);
    if (!certId) throw new Error('证书ID获取失败');

    if (product === 'cdn') {
      if (domains.length === 0) throw new Error('CDN绑定域名不能为空');
      await setSslCertificate(runtime, config, {
        label: 'CDN', endpoint: 'cdn.aliyuncs.com', version: '2018-05-10',
        action: 'SetCdnDomainSSLCertificate', domains, certId, certName,
      });
    } else if (product === 'dcdn') {
      if (domains.length === 0) throw new Error('DCDN绑定域名不能为空');
      await setSslCertificate(runtime, config, {
        label: 'DCDN', endpoint: 'dcdn.aliyuncs.com', version: '2018-01-15',
        action: 'SetDcdnDomainSSLCertificate', domains, certId, certName,
      });
    } else if (product === 'esa') {
      await deployEsa(runtime, config, certId, certName, material.domains);
    } else if (product === 'esa_saas') {
      await deployEsaSaas(runtime, config, certId);
    } else if (product === 'oss') {
      if (domains.length === 0) throw new Error('OSS绑定域名不能为空');
      const endpoint = requireField(taskConfig, 'oss_endpoint', 'Endpoint地址');
      const bucket = requireField(taskConfig, 'oss_bucket', 'Bucket名称');
      for (const domain of domains) {
        await ossAddCnameCertificate(runtime, { ...account(config), endpoint }, bucket, domain, `${certId}-cn-hangzhou`);
        runtime.log(`OSS域名 ${domain} 部署证书成功！`);
      }
    } else if (product === 'waf') {
      if (domains.length === 0) throw new Error('WAF绑定域名不能为空');
      await deployWaf(runtime, config, certId, domains);
    } else if (product === 'wafres') {
      const resourceIds = splitList(taskConfig.waf_resource_id);
      if (resourceIds.length === 0) throw new Error('云产品防护对象ID不能为空');
      await deployWafRes(runtime, config, certId, resourceIds);
    } else if (product === 'waf2') {
      if (domains.length === 0) throw new Error('WAF绑定域名不能为空');
      await deployWaf2(runtime, config, certId, domains);
    } else if (product === 'ddoscoo') {
      if (domains.length === 0) throw new Error('绑定域名不能为空');
      const client = rpcClient(config, `ddoscoo.${region}.aliyuncs.com`, '2020-01-01');
      for (const domain of domains) {
        await rpc(runtime, client, { Action: 'AssociateWebCert', Domain: domain, CertId: certId });
        runtime.log(`DDoS高防域名 ${domain} 部署证书成功！`);
      }
    } else if (product === 'live') {
      if (domains.length === 0) throw new Error('视频直播绑定域名不能为空');
      await setSslCertificate(runtime, config, {
        label: '视频直播', endpoint: 'live.aliyuncs.com', version: '2016-11-01',
        action: 'SetLiveDomainCertificate', domains, certId, certName,
      });
    } else if (product === 'clb') {
      await deployClb(runtime, config, certId, certName, regionId);
    } else if (product === 'alb') {
      await deployListenerCertificate(runtime, config, certId, regionId, 'alb', '2020-06-16', taskConfig.alb_listener_id, 'Certificates.1.CertificateId');
    } else if (product === 'nlb') {
      await deployListenerCertificate(runtime, config, certId, regionId, 'nlb', '2022-04-30', taskConfig.nlb_listener_id, 'CertificateIds.1');
    } else if (product === 'ga') {
      await deployGa(runtime, config, certId);
    } else if (product !== 'upload') {
      throw new Error('未知的产品类型');
    }

    runtime.state.cert_id = certId;
    runtime.state.cert_name = certName;
  },
};

async function deployClb(
  runtime: DeployRuntime, config: DeployTaskConfig, certId: string, certName: string, regionId: string,
): Promise<void> {
  const loadBalancerId = requireField(config, 'clb_id', '负载均衡实例ID');
  const port = requireField(config, 'clb_port', 'HTTPS监听端口');
  const client = rpcClient(config, `slb.${regionId}.aliyuncs.com`, '2014-05-15');
  let data: Record<string, unknown>;
  try {
    data = await rpc(runtime, client, { Action: 'DescribeServerCertificates', RegionId: regionId });
  } catch (error) {
    throw new Error(`获取服务器证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  let serverCertificateId = '';
  for (const certificate of arr(obj(data.ServerCertificates).ServerCertificate)) {
    if (Number(certificate.IsAliCloudCertificate ?? 0) === 1 && text(certificate.AliCloudCertificateId) === certId) {
      serverCertificateId = text(certificate.ServerCertificateId);
      break;
    }
  }
  if (!serverCertificateId) {
    try {
      data = await rpc(runtime, client, {
        Action: 'UploadServerCertificate',
        RegionId: regionId,
        AliCloudCertificateId: certId,
        AliCloudCertificateName: certName,
        AliCloudCertificateRegionId: 'cn-hangzhou',
      });
    } catch (error) {
      throw new Error(`服务器证书添加失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    serverCertificateId = text(data.ServerCertificateId);
    runtime.log(`服务器证书添加成功 ServerCertificateId=${serverCertificateId}`);
  } else {
    runtime.log(`找到已添加的服务器证书 ServerCertificateId=${serverCertificateId}`);
  }

  if (Number(config.deploy_type ?? 0) === 1) {
    const extensionDomains = splitList(config.clb_domain);
    if (extensionDomains.length === 0) throw new Error('扩展域名不能为空');
    try {
      data = await rpc(runtime, client, {
        Action: 'DescribeDomainExtensions', RegionId: regionId, LoadBalancerId: loadBalancerId, ListenerPort: port,
      });
    } catch (error) {
      throw new Error(`扩展域名列表查询失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    for (const item of arr(obj(data.DomainExtensions).DomainExtension)) {
      if (!extensionDomains.includes(text(item.Domain))) continue;
      if (text(item.ServerCertificateId) === serverCertificateId) {
        runtime.log(`负载均衡HTTPS扩展域名 ${text(item.Domain)} 证书已配置`);
        continue;
      }
      await rpc(runtime, client, {
        Action: 'SetDomainExtensionAttribute', RegionId: regionId,
        DomainExtensionId: text(item.DomainExtensionId), ServerCertificateId: serverCertificateId,
      });
      runtime.log(`负载均衡HTTPS扩展域名 ${text(item.Domain)} 证书更新成功`);
    }
    return;
  }

  try {
    data = await rpc(runtime, client, {
      Action: 'DescribeLoadBalancerHTTPSListenerAttribute', RegionId: regionId, LoadBalancerId: loadBalancerId, ListenerPort: port,
    });
  } catch (error) {
    throw new Error(`HTTPS监听配置查询失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  if (text(data.ServerCertificateId) === serverCertificateId) {
    runtime.log('负载均衡HTTPS监听已配置该证书，无需重复操作');
    return;
  }
  await rpc(runtime, client, {
    Action: 'SetLoadBalancerHTTPSListenerAttribute', RegionId: regionId,
    LoadBalancerId: loadBalancerId, ListenerPort: port, ServerCertificateId: serverCertificateId,
  });
  runtime.log('负载均衡HTTPS监听证书配置成功！');
}

async function deployListenerCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, certId: string, regionId: string,
  service: 'alb' | 'nlb', version: string, listenerId: unknown, certificateKey: string,
): Promise<void> {
  const listener = typeof listenerId === 'string' ? listenerId.trim() : '';
  if (!listener) throw new Error('负载均衡监听ID不能为空');
  const client = rpcClient(config, `${service}.${regionId}.aliyuncs.com`, version);
  const casId = `${certId}-cn-hangzhou`;
  if (Number(config.deploy_type ?? 0) === 1) {
    let data: Record<string, unknown>;
    try {
      data = await rpc(runtime, client, {
        Action: 'ListListenerCertificates', MaxResults: service === 'alb' ? 100 : 50,
        ListenerId: listener, CertificateType: 'Server',
      });
    } catch (error) {
      throw new Error(`获取监听证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    for (const certificate of arr(data.Certificates)) {
      if (text(certificate.CertificateId) === casId) {
        runtime.log('负载均衡监听扩展证书已添加，无需重复操作');
        return;
      }
    }
    const params: Record<string, unknown> = { Action: 'AssociateAdditionalCertificatesWithListener', ListenerId: listener };
    params[service === 'alb' ? 'Certificates.1.CertificateId' : 'AdditionalCertificateIds.1'] = casId;
    await rpc(runtime, client, params);
    runtime.log(`${service === 'alb' ? '应用型' : '网络型'}负载均衡监听扩展证书添加成功！`);
    return;
  }
  const params: Record<string, unknown> = { Action: 'UpdateListenerAttribute', ListenerId: listener };
  params[certificateKey] = casId;
  await rpc(runtime, client, params);
  runtime.log(`${service === 'alb' ? '应用型' : '网络型'}负载均衡监听默认证书更新成功！`);
}

async function deployGa(runtime: DeployRuntime, config: DeployTaskConfig, certId: string): Promise<void> {
  const acceleratorId = requireField(config, 'ga_id', '全球加速实例ID');
  const listenerId = requireField(config, 'ga_listener_id', '监听ID');
  const client = rpcClient(config, 'ga.cn-hangzhou.aliyuncs.com', '2019-11-20');
  const casId = `${certId}-cn-hangzhou`;
  if (Number(config.deploy_type ?? 0) === 1) {
    const extensionDomains = splitList(config.clb_domain);
    if (extensionDomains.length === 0) throw new Error('扩展域名不能为空');
    let data: Record<string, unknown>;
    try {
      data = await rpc(runtime, client, {
        Action: 'ListListenerCertificates', RegionId: 'cn-hangzhou', AcceleratorId: acceleratorId, ListenerId: listenerId,
      });
    } catch (error) {
      throw new Error(`扩展域名列表查询失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    const certificates = arr(data.Certificates);
    const needAdd: string[] = [];
    for (const domain of extensionDomains) {
      const existed = certificates.find((certificate) => text(certificate.Domain) === domain);
      if (existed) {
        if (text(existed.CertificateId) === casId) {
          runtime.log(`全球加速实例监听扩展域名 ${domain} 证书已配置`);
          continue;
        }
        await rpc(runtime, client, {
          Action: 'UpdateAdditionalCertificateWithListener', RegionId: 'cn-hangzhou',
          AcceleratorId: acceleratorId, ListenerId: listenerId, Domain: domain, CertificateId: casId,
        });
        runtime.log(`全球加速实例监听扩展域名 ${domain} 替换证书成功！`);
      } else {
        needAdd.push(domain);
      }
    }
    if (needAdd.length > 0) {
      const params: Record<string, unknown> = {
        Action: 'AssociateAdditionalCertificatesWithListener', RegionId: 'cn-hangzhou',
        AcceleratorId: acceleratorId, ListenerId: listenerId,
      };
      needAdd.forEach((domain, index) => {
        params[`Certificates.${index + 1}.Id`] = casId;
        params[`Certificates.${index + 1}.Domain`] = domain;
      });
      await rpc(runtime, client, params);
      runtime.log(`全球加速实例监听扩展域名 ${needAdd.join(',')} 绑定证书成功！`);
    }
    return;
  }
  await rpc(runtime, client, {
    Action: 'UpdateListener', RegionId: 'cn-hangzhou',
    AcceleratorId: acceleratorId, ListenerId: listenerId, 'Certificates.1.Id': casId,
  });
  runtime.log('全球加速实例监听默认证书更新成功！');
}
