import { certificateInfo, certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, parseJsonValue, readArray, readString } from '../http';
import { hmacSha1Base64Url } from '../sign';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://api.qiniu.com';
const PILI = 'https://pili.qiniuapi.com';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function queryString(query: Record<string, string> | undefined): string {
  if (!query) return '';
  const search = Object.entries(query)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return search ? `?${search}` : '';
}

async function request(
  runtime: DeployRuntime, config: DeployTaskConfig, method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string, query?: Record<string, string>, params?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const search = queryString(query);
  const body = params ? JSON.stringify(params) : '';
  const accessKey = requireField(config, 'AccessKey', 'AccessKey');
  const sign = await hmacSha1Base64Url(requireField(config, 'SecretKey', 'SecretKey'), `${path}${search}\n`);
  const text = await deployRequest(runtime, `${API}${path}${search}`, {
    method,
    headers: {
      authorization: `QBox ${accessKey}:${sign}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body || undefined,
  }, '七牛云');
  if (!text.trim()) return null;
  const parsed = parseJsonValue(text, '七牛云');
  if (parsed === true) return null;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

async function piliRequest(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(params);
  const signStr = `POST ${path}\nHost: pili.qiniuapi.com\nContent-Type: application/json\n\n${body}`;
  const accessKey = requireField(config, 'AccessKey', 'AccessKey');
  const sign = await hmacSha1Base64Url(requireField(config, 'SecretKey', 'SecretKey'), signStr);
  await deployRequest(runtime, `${PILI}${path}`, {
    method: 'POST',
    headers: { authorization: `Qiniu ${accessKey}:${sign}`, 'content-type': 'application/json' },
    body,
  }, '七牛云');
}

async function certificateId(
  runtime: DeployRuntime, config: DeployTaskConfig, material: Parameters<DeployProvider['deploy']>[2],
): Promise<{ id: string; name: string }> {
  const info = certificateInfo(material.fullchain);
  const name = certificateName(material.fullchain);
  let marker = '';
  let found = '';
  do {
    const data = await request(runtime, config, 'GET', '/sslcert', { marker, limit: '100' });
    const certs = data ? readArray(data, 'certs') : [];
    if (certs.length === 0) break;
    marker = data ? readString(data, 'marker') : '';
    const now = Math.floor(Date.now() / 1000);
    for (const cert of certs) {
      if (readString(cert, 'name') === name) {
        found = readString(cert, 'certid');
        runtime.log(`证书${name}已存在，证书ID:${found}`);
      } else if (Number(cert.not_after ?? 0) < now) {
        try {
          await request(runtime, config, 'DELETE', `/sslcert/${encodeURIComponent(readString(cert, 'certid'))}`);
          runtime.log(`证书${readString(cert, 'name')}已过期，删除证书成功`);
        } catch (error) {
          runtime.log(`证书${readString(cert, 'name')}已过期，删除证书失败:${error instanceof Error ? error.message : '请求失败'}`);
        }
        await sleep(300);
      }
    }
  } while (marker !== '');
  if (found) return { id: found, name };
  let uploaded: Record<string, unknown> | null;
  try {
    uploaded = await request(runtime, config, 'POST', '/sslcert', undefined, {
      name,
      common_name: info.commonName,
      pri: material.privateKey,
      ca: material.fullchain,
    });
  } catch (error) {
    throw new Error(`上传证书失败:${error instanceof Error ? error.message : '请求失败'}`);
  }
  const id = uploaded ? readString(uploaded, 'certID') : '';
  if (!id) throw new Error('上传证书失败:响应未返回证书ID');
  runtime.log(`上传证书成功，证书ID:${id}`);
  await sleep(500);
  return { id, name };
}

export const qiniu: DeployProvider = {
  meta: deployMeta('qiniu'),

  async check(config, runtime) {
    await request(runtime, config, 'GET', '/sslcert');
  },

  async deploy(taskConfig, config, material, runtime) {
    const domains = splitList(taskConfig.domain);
    if (domains.length === 0) throw new Error('绑定的域名不能为空');
    const certificate = await certificateId(runtime, config, material);
    runtime.state.cert_id = certificate.id;
    runtime.state.cert_name = certificate.name;
    const product = typeof taskConfig.product === 'string' ? taskConfig.product : 'cdn';
    if (product === 'upload') return;
    for (const domain of domains) {
      if (product === 'cdn') {
        let data: Record<string, unknown> | null;
        try {
          data = await request(runtime, config, 'GET', `/domain/${encodeURIComponent(domain)}`);
        } catch (error) {
          throw new Error(`获取域名信息失败:${error instanceof Error ? error.message : '请求失败'}`);
        }
        const https = data && data.https && typeof data.https === 'object' ? data.https as Record<string, unknown> : {};
        if (readString(https, 'certId') === certificate.id) {
          runtime.log(`域名 ${domain} 证书已部署，无需重复操作`);
          continue;
        }
        if (!readString(https, 'certId')) {
          await request(runtime, config, 'PUT', `/domain/${encodeURIComponent(domain)}/sslize`, undefined, {
            certid: certificate.id,
          });
        } else {
          await request(runtime, config, 'PUT', `/domain/${encodeURIComponent(domain)}/httpsconf`, undefined, {
            certid: certificate.id,
            forceHttps: https.forceHttps,
            http2Enable: https.http2Enable,
          });
        }
        runtime.log(`CDN域名 ${domain} 证书部署成功！`);
      } else if (product === 'oss') {
        await request(runtime, config, 'POST', '/cert/bind', undefined, {
          certid: certificate.id, domain,
        });
        runtime.log(`OSS域名 ${domain} 证书部署成功！`);
      } else if (product === 'pili') {
        const hub = requireField(taskConfig, 'pili_hub', '直播空间名称');
        await piliRequest(runtime, config, `/v2/hubs/${encodeURIComponent(hub)}/domains/${encodeURIComponent(domain)}/cert`, {
          CertName: certificate.name,
        });
        runtime.log(`视频直播域名 ${domain} 证书部署成功！`);
      } else {
        throw new Error('未知的产品类型');
      }
    }
  },
};
