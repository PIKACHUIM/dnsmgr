import { sha256Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { deployRaw } from '../http';
import { sigv4Signature } from '../sign';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

interface Endpoint {
  scheme: string;
  host: string;
}

function endpointOf(config: DeployTaskConfig): Endpoint {
  const raw = requireField(config, 'endpoint', 'S3 Endpoint').replace(/\/+$/, '');
  const match = /^(https?):\/\/(.+)$/.exec(raw);
  if (match) return { scheme: match[1] ?? 'https', host: match[2] ?? '' };
  return { scheme: 'https', host: raw };
}

async function s3Request(
  runtime: DeployRuntime, config: DeployTaskConfig, method: 'GET' | 'PUT',
  path: string, body: string, contentType: string,
): Promise<string> {
  const { scheme, host } = endpointOf(config);
  const payloadHash = await sha256Hex(body);
  const headers: Record<string, string> = { 'x-amz-content-sha256': payloadHash };
  if (contentType) headers['content-type'] = contentType;
  const signature = await sigv4Signature({
    accessKeyId: requireField(config, 'AccessKeyId', 'AccessKeyId'),
    secretAccessKey: requireField(config, 'SecretAccessKey', 'SecretAccessKey'),
    region: typeof config.region === 'string' && config.region ? config.region : 'us-east-1',
    service: 's3',
    method,
    host,
    path,
    headers,
    body,
  });
  const response = await deployRaw(runtime, `${scheme}://${host}${path}`, {
    method,
    headers: {
      ...headers,
      host,
      'x-amz-date': signature.amzDate,
      authorization: signature.authorization,
    },
    body: body || undefined,
    timeoutMs: 30_000,
  }, 'S3 存储');
  const text = await response.text();
  if (response.ok) return text;
  const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1] ?? '';
  throw new Error(message || `HTTP Code: ${response.status}`);
}

export const s3storage: DeployProvider = {
  meta: deployMeta('s3storage'),

  async check(config, runtime) {
    await s3Request(runtime, config, 'GET', '/', '', '');
  },

  async deploy(taskConfig, config, material, runtime) {
    const bucket = requireField(taskConfig, 'bucket', '存储桶名称');
    const certPath = (typeof taskConfig.cert_path === 'string' ? taskConfig.cert_path : '').replace(/^\/+|\/+$/g, '');
    const keyPath = (typeof taskConfig.key_path === 'string' ? taskConfig.key_path : '').replace(/^\/+|\/+$/g, '');
    if (!certPath || !keyPath) throw new Error('证书和私钥保存路径不能为空');
    await s3Request(runtime, config, 'PUT', `/${encodeURIComponent(bucket)}/${certPath}`, material.fullchain, 'application/x-pem-file');
    runtime.log(`证书已上传到：s3://${bucket}/${certPath}`);
    await s3Request(runtime, config, 'PUT', `/${encodeURIComponent(bucket)}/${keyPath}`, material.privateKey, 'application/x-pem-file');
    runtime.log(`私钥已上传到：s3://${bucket}/${keyPath}`);
  },
};
