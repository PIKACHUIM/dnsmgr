import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { DeployHttpError, deployRequest, parseJsonObject, readArray, readString } from '../http';
import { sigv4Signature } from '../sign';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const HOST = 'cdn.api.ksyun.com';
const REGION = 'cn-shanghai-2';
const SERVICE = 'cdn';

async function call(
  runtime: DeployRuntime, config: DeployTaskConfig, method: 'GET' | 'POST', action: string,
  version: string, path: string, params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const body = method === 'POST' && Object.keys(params).length > 0 ? JSON.stringify(params) : '';
  const query = method === 'GET' ? params : {};
  const signature = await sigv4Signature({
    accessKeyId: requireField(config, 'AccessKeyId', 'AccessKeyId'),
    secretAccessKey: requireField(config, 'SecretAccessKey', 'SecretAccessKey'),
    region: REGION,
    service: SERVICE,
    method,
    host: HOST,
    path,
    query,
    body,
    headers: { 'x-version': version, 'x-action': action },
  });
  const search = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  const url = `https://${HOST}${path}${search ? `?${search}` : ''}`;
  const headers: Record<string, string> = {
    host: HOST,
    'x-amz-date': signature.amzDate,
    'x-version': version,
    'x-action': action,
    authorization: signature.authorization,
    accept: 'application/json',
  };
  if (body) headers['content-type'] = 'application/json';
  const text = await deployRequest(runtime, url, { method, headers, body: body || undefined }, '金山云');
  return parseJsonObject(text, '金山云');
}

function errorMessage(error: unknown): string {
  if (!(error instanceof DeployHttpError)) return error instanceof Error ? error.message : '请求失败';
  try {
    const body = parseJsonObject(error.body, '金山云');
    const detail = body.Error;
    if (detail && typeof detail === 'object' && typeof (detail as Record<string, unknown>).Message === 'string') {
      return (detail as Record<string, string>).Message as string;
    }
  } catch { /* 落到默认提示 */ }
  return error.message;
}

export const ksyun: DeployProvider = {
  meta: deployMeta('ksyun'),

  async check(config, runtime) {
    try {
      await call(runtime, config, 'GET', 'GetCertificates', '2016-09-01', '/2016-09-01/cert/GetCertificates');
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  },

  async deploy(taskConfig, config, material, runtime) {
    const domains = splitList(taskConfig.domain);
    if (domains.length === 0) throw new Error('绑定的域名不能为空');
    try {
      const list = await call(runtime, config, 'GET', 'GetCdnDomains', '2019-06-01', '/2019-06-01/domain/GetCdnDomains', {
        PageSize: '100', PageNumber: '1',
      });
      const ids: string[] = [];
      for (const row of readArray(list, 'Domains')) {
        if (domains.includes(readString(row, 'DomainName'))) ids.push(readString(row, 'DomainId'));
      }
      if (ids.length === 0) throw new Error('未找到对应的CDN域名');
      const result = await call(runtime, config, 'POST', 'ConfigCertificate', '2016-09-01', '/2016-09-01/cert/ConfigCertificate', {
        Enable: 'on',
        DomainIds: ids.join(','),
        CertificateName: certificateName(material.fullchain),
        ServerCertificate: material.fullchain,
        PrivateKey: material.privateKey,
      });
      runtime.log(`CDN证书部署成功，证书ID：${readString(result, 'CertificateId')}`);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  },
};
