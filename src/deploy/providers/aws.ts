import { deployMeta } from '../metadata';
import { deployRaw } from '../http';
import { sigv4Signature } from '../sign';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

interface AwsCall {
  host: string;
  service: string;
  region: string;
  method: 'GET' | 'POST' | 'PUT';
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

interface AwsResponse {
  status: number;
  text: string;
  etag: string;
}

async function call(
  runtime: DeployRuntime, config: DeployTaskConfig, options: AwsCall,
): Promise<AwsResponse> {
  const path = options.path ?? '/';
  const signature = await sigv4Signature({
    accessKeyId: requireField(config, 'AccessKeyId', 'AccessKeyId'),
    secretAccessKey: requireField(config, 'SecretAccessKey', 'SecretAccessKey'),
    region: options.region,
    service: options.service,
    method: options.method,
    host: options.host,
    path,
    query: options.query ?? {},
    headers: options.headers,
    body: options.body,
  });
  const search = Object.entries(options.query ?? {})
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const response = await deployRaw(runtime, `https://${options.host}${path}${search ? `?${search}` : ''}`, {
    method: options.method,
    headers: {
      ...(options.headers ?? {}),
      host: options.host,
      'x-amz-date': signature.amzDate,
      Authorization: signature.authorization,
    },
    body: options.body,
  }, 'AWS');
  const text = await response.text();
  return { status: response.status, text, etag: response.headers.get('etag') ?? '' };
}

function ensureOk(response: AwsResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  const xmlMessage = /<Message>([\s\S]*?)<\/Message>/.exec(response.text)?.[1] ?? '';
  if (xmlMessage) throw new Error(xmlMessage);
  let jsonMessage = '';
  try {
    const parsed = JSON.parse(response.text) as { message?: unknown };
    if (typeof parsed.message === 'string') jsonMessage = parsed.message;
  } catch { /* 非 JSON 响应 */ }
  throw new Error(jsonMessage || `HTTP Code: ${response.status}`);
}

async function post(runtime: DeployRuntime, config: DeployTaskConfig, options: AwsCall): Promise<AwsResponse> {
  const response = await call(runtime, config, options);
  ensureOk(response);
  return response;
}

function jsonBody(response: AwsResponse): Record<string, unknown> {
  if (!response.text.trim()) return {};
  try {
    const parsed = JSON.parse(response.text) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    throw new Error('返回数据解析失败');
  }
}

function pick(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match && match[1] ? match[1] : '';
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 只替换 ViewerCertificate 子树，其余分配配置原样回写。 */
function setViewerCertificate(xml: string, arn: string): string {
  const block = /<ViewerCertificate>[\s\S]*?<\/ViewerCertificate>/.exec(xml)?.[0] ?? '';
  if (!block) throw new Error('分配配置缺少 ViewerCertificate');
  const method = pick(block, 'SSLSupportMethod') || 'sni-only';
  const protocol = pick(block, 'MinimumProtocolVersion');
  const parts = [
    '<ViewerCertificate>',
    '<CloudFrontDefaultCertificate>false</CloudFrontDefaultCertificate>',
    `<ACMCertificateArn>${escapeXml(arn)}</ACMCertificateArn>`,
    `<SSLSupportMethod>${method}</SSLSupportMethod>`,
    protocol ? `<MinimumProtocolVersion>${protocol}</MinimumProtocolVersion>` : '',
    '</ViewerCertificate>',
  ];
  return xml.replace(block, parts.join(''));
}

async function importCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, material: Parameters<DeployProvider['deploy']>[2],
  existing: string, forced: boolean,
): Promise<string> {
  if (forced && !existing) throw new Error('ACM ARN不能为空');
  const blocks = material.fullchain.split('-----END CERTIFICATE-----');
  const leaf = `${blocks[0] ?? ''}-----END CERTIFICATE-----`;
  const chain = blocks.slice(1).filter((block) => block.trim())
    .map((block) => `${block}-----END CERTIFICATE-----`).join('');
  if (existing) {
    try {
      const current = jsonBody(await post(runtime, config, {
        host: 'acm.us-east-1.amazonaws.com', service: 'acm', region: 'us-east-1', method: 'POST',
        headers: { 'x-amz-target': 'CertificateManager.GetCertificate', 'content-type': 'application/x-amz-json-1.1' },
        body: JSON.stringify({ CertificateArn: existing }),
      }));
      if (typeof current.Certificate === 'string' && current.Certificate.trim() === leaf.trim()) {
        runtime.log(`证书已是最新，ACM ARN：${existing}`);
        return existing;
      }
      runtime.log('证书已过期或被删除，准备更新或者重新上传');
    } catch (error) {
      if (forced) {
        throw new Error(`获取证书信息失败，请检查ACM ARN是否正确：${error instanceof Error ? error.message : '请求失败'}`);
      }
      runtime.log(`证书已被删除：${existing}，准备重新上传`);
    }
  }
  const payload: Record<string, string> = {
    Certificate: btoa(leaf),
    PrivateKey: btoa(material.privateKey),
  };
  if (chain) payload.CertificateChain = btoa(chain);
  if (forced) payload.CertificateArn = existing;
  let uploaded: Record<string, unknown>;
  try {
    uploaded = jsonBody(await post(runtime, config, {
      host: 'acm.us-east-1.amazonaws.com', service: 'acm', region: 'us-east-1', method: 'POST',
      headers: { 'x-amz-target': 'CertificateManager.ImportCertificate', 'content-type': 'application/x-amz-json-1.1' },
      body: JSON.stringify(payload),
    }));
  } catch (error) {
    throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const arn = typeof uploaded.CertificateArn === 'string' ? uploaded.CertificateArn : '';
  if (!arn) throw new Error('上传证书失败：响应未返回 CertificateArn');
  runtime.log(`证书上传成功：${arn}`);
  runtime.state.cert_id = arn;
  return arn;
}

export const aws: DeployProvider = {
  meta: deployMeta('aws'),

  async check(config, runtime) {
    const response = await call(runtime, config, {
      host: 'iam.amazonaws.com', service: 'iam', region: 'us-east-1', method: 'GET',
      query: { Action: 'GetUser', Version: '2010-05-08' },
    });
    ensureOk(response);
    if (!response.text.includes('<GetUserResult')) throw new Error('返回数据解析失败');
  },

  async deploy(taskConfig, config, material, runtime) {
    const product = typeof taskConfig.product === 'string' ? taskConfig.product : 'cloudfront';
    if (product === 'acm') {
      const arn = requireField(taskConfig, 'acm_arn', 'ACM ARN');
      await importCertificate(runtime, config, material, arn, true);
      return;
    }
    const distributionId = requireField(taskConfig, 'distribution_id', '分配ID');
    const arn = await importCertificate(runtime, config, material, runtime.state.cert_id ?? '', false);
    const path = `/2020-05-31/distribution/${encodeURIComponent(distributionId)}/config`;
    let current: AwsResponse;
    try {
      current = await post(runtime, config, {
        host: 'cloudfront.amazonaws.com', service: 'cloudfront', region: 'us-east-1', method: 'GET', path,
      });
    } catch (error) {
      throw new Error(`获取分配信息失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    await post(runtime, config, {
      host: 'cloudfront.amazonaws.com', service: 'cloudfront', region: 'us-east-1', method: 'PUT', path,
      headers: {
        'content-type': 'application/xml',
        ...(current.etag ? { 'if-match': current.etag } : {}),
      },
      body: setViewerCertificate(current.text, arn),
    });
    runtime.log(`分配ID: ${distributionId} 证书部署成功！`);
  },
};
