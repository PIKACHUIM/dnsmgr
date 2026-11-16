import { hmacSha256Hex, percentEncode, sha256Hex } from '../../dns/sign';
import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, parseJsonObject, readString } from '../http';
import { hmacSha1Base64, md5Base64 } from '../sign';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function huaweiCall(
  runtime: DeployRuntime, config: DeployTaskConfig, endpoint: string, method: 'GET' | 'POST' | 'PUT',
  path: string, payload?: unknown,
): Promise<Record<string, unknown> | null> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers: Record<string, string> = { host: endpoint, 'x-sdk-date': date };
  if (body) headers['content-type'] = 'application/json';
  const canonicalUri = `${path.split('/').map((segment) => percentEncode(segment)).join('/')}${path.endsWith('/') ? '' : '/'}`;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [
    method, canonicalUri, '', canonicalHeaders, names.join(';'), await sha256Hex(body),
  ].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', date, await sha256Hex(canonicalRequest)].join('\n');
  const signature = await hmacSha256Hex(requireField(config, 'SecretAccessKey', 'SecretAccessKey'), stringToSign);
  const text = await deployRequest(runtime, `https://${endpoint}${path}`, {
    method,
    headers: {
      ...headers,
      authorization: `SDK-HMAC-SHA256 Access=${requireField(config, 'AccessKeyId', 'AccessKeyId')}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
    body: body || undefined,
  }, '华为云');
  if (!text.trim()) return null;
  const parsed = parseJsonObject(text, '华为云');
  for (const key of ['error_msg', 'message']) {
    if (typeof parsed[key] === 'string' && parsed[key]) throw new Error(parsed[key] as string);
  }
  const nested = parsed.error;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).error_msg === 'string') {
    throw new Error((nested as Record<string, string>).error_msg as string);
  }
  return parsed;
}

/** OBS 自定义域名证书：OBS 签名 + Content-MD5，资源路径包含桶名与 customdomain 参数。 */
async function obsCustomDomain(
  runtime: DeployRuntime, config: DeployTaskConfig, bucket: string, endpoint: string,
  domain: string, name: string, material: Parameters<DeployProvider['deploy']>[2],
): Promise<void> {
  const host = `${bucket}.${endpoint}`;
  const body = [
    '<CustomDomainConfiguration>',
    `<Name>${escapeXml(name)}</Name>`,
    `<Certificate>${escapeXml(material.fullchain)}</Certificate>`,
    `<PrivateKey>${escapeXml(material.privateKey)}</PrivateKey>`,
    '</CustomDomainConfiguration>',
  ].join('');
  const date = new Date().toUTCString();
  const contentType = 'application/xml';
  const contentMd5 = md5Base64(body);
  const query = `customdomain=${encodeURIComponent(domain)}`;
  const stringToSign = [
    'PUT', contentMd5, contentType, date, `/${bucket}/?${query}`,
  ].join('\n');
  const signature = await hmacSha1Base64(requireField(config, 'SecretAccessKey', 'SecretAccessKey'), stringToSign);
  await deployRequest(runtime, `https://${host}/?${query}`, {
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'content-md5': contentMd5,
      date,
      authorization: `OBS ${requireField(config, 'AccessKeyId', 'AccessKeyId')}:${signature}`,
    },
    body,
  }, '华为云OBS');
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function uploadCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, material: Parameters<DeployProvider['deploy']>[2],
): Promise<string> {
  let uploaded: Record<string, unknown> | null;
  try {
    uploaded = await huaweiCall(runtime, config, 'scm.cn-north-4.myhuaweicloud.com', 'POST', '/v3/scm/certificates/import', {
      name: certificateName(material.fullchain),
      certificate: material.fullchain,
      private_key: material.privateKey,
    });
  } catch (error) {
    throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const id = uploaded ? readString(uploaded, 'certificate_id') : '';
  if (!id) throw new Error('上传证书失败：响应未返回 certificate_id');
  runtime.log(`上传证书成功 certificate_id=${id}`);
  return id;
}

export const huawei: DeployProvider = {
  meta: deployMeta('huawei'),

  async check(config, runtime) {
    await huaweiCall(runtime, config, 'scm.cn-north-4.myhuaweicloud.com', 'GET', '/v3/scm/certificates');
  },

  async deploy(taskConfig, config, material, runtime) {
    const name = certificateName(material.fullchain);
    const product = typeof taskConfig.product === 'string' ? taskConfig.product : 'cdn';
    if (product === 'cdn') {
      const domains = splitList(taskConfig.domain);
      if (domains.length === 0) throw new Error('绑定的域名不能为空');
      for (const domain of domains) {
        await huaweiCall(runtime, config, 'cdn.myhuaweicloud.com', 'PUT',
          `/v1.1/cdn/configuration/domains/${encodeURIComponent(domain)}/configs`, {
            configs: {
              https: {
                https_status: 'on',
                certificate_type: 'server',
                certificate_source: 0,
                certificate_name: name,
                certificate_value: material.fullchain,
                private_key: material.privateKey,
              },
            },
          });
        runtime.log(`CDN域名 ${domain} 部署证书成功！`);
      }
      return;
    }
    if (product === 'obs') {
      const domains = splitList(taskConfig.domain);
      if (domains.length === 0) throw new Error('绑定的域名不能为空');
      const endpoint = requireField(taskConfig, 'obs_endpoint', 'OBS Endpoint');
      const bucket = requireField(taskConfig, 'obs_bucket', 'OBS 桶名称');
      for (const domain of domains) {
        await obsCustomDomain(runtime, config, bucket, endpoint, domain, name, material);
        runtime.log(`OSS域名 ${domain} 部署证书成功！`);
      }
      return;
    }
    if (product === 'upload') {
      runtime.state.cert_id = await uploadCertificate(runtime, config, material);
      return;
    }
    const projectId = requireField(taskConfig, 'project_id', '项目ID');
    const regionId = requireField(taskConfig, 'region_id', '区域ID');
    const certId = requireField(taskConfig, 'cert_id', '证书ID');
    if (product === 'elb') {
      const endpoint = `elb.${regionId}.myhuaweicloud.com`;
      const path = `/v3/${projectId}/elb/certificates/${encodeURIComponent(certId)}`;
      let current: Record<string, unknown> | null;
      try {
        current = await huaweiCall(runtime, config, endpoint, 'GET', path);
      } catch (error) {
        throw new Error(`证书详情查询失败：${error instanceof Error ? error.message : '请求失败'}`);
      }
      const detail = current && current.certificate && typeof current.certificate === 'object'
        ? current.certificate as Record<string, unknown>
        : {};
      if (readString(detail, 'certificate').trim() === material.fullchain.trim()) {
        runtime.log(`ELB证书ID ${certId} 已存在，无需重复部署`);
        return;
      }
      await huaweiCall(runtime, config, endpoint, 'PUT', path, {
        certificate: {
          certificate: material.fullchain,
          private_key: material.privateKey,
          domain: material.domains.join(','),
        },
      });
      runtime.log(`ELB证书ID ${certId} 更新证书成功！`);
      return;
    }
    if (product === 'waf') {
      const endpoint = `waf.${regionId}.myhuaweicloud.com`;
      const path = `/v1/${projectId}/waf/certificates/${encodeURIComponent(certId)}`;
      let current: Record<string, unknown> | null;
      try {
        current = await huaweiCall(runtime, config, endpoint, 'GET', path);
      } catch (error) {
        throw new Error(`证书详情查询失败：${error instanceof Error ? error.message : '请求失败'}`);
      }
      if (current && readString(current, 'content').trim() === material.fullchain.trim()) {
        runtime.log(`WAF证书ID ${certId} 已存在，无需重复部署`);
        return;
      }
      await huaweiCall(runtime, config, endpoint, 'PUT', path, {
        name,
        content: material.fullchain,
        key: material.privateKey,
      });
      runtime.log(`WAF证书ID ${certId} 更新证书成功！`);
      return;
    }
    throw new Error('不支持的产品类型');
  },
};
