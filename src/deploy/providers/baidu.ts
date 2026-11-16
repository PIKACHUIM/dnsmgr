import { hmacSha256Hex, percentEncode } from '../../dns/sign';
import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, parseJsonObject, readArray, readString } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function bceCall(
  runtime: DeployRuntime, config: DeployTaskConfig, endpoint: string, method: 'GET' | 'POST' | 'PUT',
  path: string, query: Record<string, string> = {}, payload?: unknown,
): Promise<Record<string, unknown> | null> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const time = Math.floor(Date.now() / 1000);
  const date = new Date(time * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const headers: Record<string, string> = { host: endpoint, 'x-bce-date': date };
  if (body) headers['content-type'] = 'application/json';
  const canonicalQuery = Object.entries(query)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join('&');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((key) => `${percentEncode(key)}:${percentEncode(headers[key] ?? '')}`)
    .join('\n');
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalRequest = [
    method, percentEncode(path).replaceAll('%2F', '/'), canonicalQuery, canonicalHeaders,
  ].join('\n');
  const authString = `bce-auth-v1/${requireField(config, 'AccessKeyId', 'AccessKeyId')}/${date}/1800`;
  const signingKey = await hmacSha256Hex(requireField(config, 'SecretAccessKey', 'SecretAccessKey'), authString);
  const signature = await hmacSha256Hex(signingKey, canonicalRequest);
  const search = canonicalQuery ? `?${canonicalQuery}` : '';
  const text = await deployRequest(runtime, `https://${endpoint}${path}${search}`, {
    method,
    headers: { ...headers, authorization: `${authString}/${signedHeaders}/${signature}` },
    body: body || undefined,
  }, '百度云');
  if (!text.trim()) return null;
  const parsed = parseJsonObject(text, '百度云');
  if (parsed.code !== undefined && typeof parsed.message === 'string') throw new Error(parsed.message);
  return parsed;
}

async function uploadCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, material: Parameters<DeployProvider['deploy']>[2],
): Promise<string> {
  const name = certificateName(material.fullchain);
  let found = '';
  try {
    const list = await bceCall(runtime, config, 'certificate.baidubce.com', 'GET', '/v1/certificate', { certName: name });
    for (const row of list ? readArray(list, 'certs') : []) {
      if (readString(row, 'certName') === name) {
        found = readString(row, 'certId');
        runtime.log(`证书已存在 CertId=${found}`);
        return found;
      }
    }
  } catch (error) {
    throw new Error(`查找证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  let created: Record<string, unknown> | null;
  try {
    created = await bceCall(runtime, config, 'certificate.baidubce.com', 'POST', '/v1/certificate', {}, {
      certName: name, certServerData: material.fullchain, certPrivateData: material.privateKey,
    });
  } catch (error) {
    throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const id = created ? readString(created, 'certId') : '';
  if (!id) throw new Error('上传证书失败：响应未返回 CertId');
  runtime.log(`上传证书成功 CertId=${id}`);
  return id;
}

export const baidu: DeployProvider = {
  meta: deployMeta('baidu'),

  async check(config, runtime) {
    await bceCall(runtime, config, 'cdn.baidubce.com', 'GET', '/v2/domain');
  },

  async deploy(taskConfig, config, material, runtime) {
    const product = typeof taskConfig.product === 'string' ? taskConfig.product : 'cdn';
    if (product === 'cdn') {
      const domains = splitList(taskConfig.domain);
      if (domains.length === 0) throw new Error('绑定的域名不能为空');
      const name = certificateName(material.fullchain);
      for (const domain of domains) {
        try {
          const current = await bceCall(runtime, config, 'cdn.baidubce.com', 'GET', `/v2/${domain}/certificates`);
          if (current && readString(current, 'certName') === name) {
            runtime.log(`CDN域名 ${domain} 证书已存在，无需重复部署`);
            continue;
          }
        } catch (error) {
          runtime.log(error instanceof Error ? error.message : '请求失败');
        }
        const deployed = await bceCall(runtime, config, 'cdn.baidubce.com', 'PUT', `/v2/${domain}/certificates`, {}, {
          httpsEnable: 'ON',
          certificate: {
            certName: name,
            certServerData: material.fullchain,
            certPrivateData: material.privateKey,
          },
        });
        if (deployed) runtime.state.cert_id = readString(deployed, 'certId');
        runtime.log(`CDN域名 ${domain} 证书部署成功！`);
      }
      return;
    }
    const certId = await uploadCertificate(runtime, config, material);
    runtime.state.cert_id = certId;
    if (product === 'upload') return;
    const blbId = requireField(taskConfig, 'blb_id', '负载均衡实例ID');
    const port = requireField(taskConfig, 'blb_port', 'HTTPS监听端口');
    const region = requireField(taskConfig, 'region', '所属地域');
    if (product !== 'blb' && product !== 'appblb') throw new Error('不支持的产品类型');
    await bceCall(runtime, config, `blb.${region}.baidubce.com`, 'PUT',
      `/v1/${product}/${encodeURIComponent(blbId)}/HTTPSlistener`, { listenerPort: port }, { certIds: [certId] });
    runtime.log(`${product === 'blb' ? '普通型' : '应用型'}BLB ${blbId} 部署证书成功！`);
  },
};
