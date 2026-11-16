import { base64Encode, base64Of, hmacSha256Raw } from '../../dns/sign';
import { hmacSha1Base64 } from '../sign';
import { certificateInfo, certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRaw, formBody } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const encoder = new TextEncoder();

interface WangsuClient {
  username: string;
  apiKey: string;
  spKey: string;
}

function client(config: DeployTaskConfig): WangsuClient {
  return {
    username: requireField(config, 'username', '账号'),
    apiKey: requireField(config, 'apiKey', 'APIKEY'),
    spKey: typeof config.spKey === 'string' ? config.spKey.trim() : '',
  };
}

function httpDate(now = Date.now()): string {
  return new Date(now).toUTCString();
}

interface WangsuResponse {
  status: number;
  text: string;
  location: string;
}

async function request(
  runtime: DeployRuntime, account: WangsuClient, path: string, options: {
    method?: string; data?: Record<string, unknown>; json?: boolean; date?: string; wantLocation?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<{ value: unknown; location: string }> {
  const date = options.date ?? httpDate();
  const json = options.json === true;
  const method = options.method ?? (options.data ? 'POST' : 'GET');
  const body = options.data ? (json ? JSON.stringify(options.data) : formBody(options.data as Record<string, string>)) : undefined;
  const headers: Record<string, string> = {
    accept: 'application/json',
    date,
    authorization: `Basic ${base64Encode(`${account.username}:${await hmacSha1Base64(account.apiKey, date)}`)}`,
    ...options.headers,
  };
  if (body && json) headers['content-type'] = 'application/json';
  if (body && !json) headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = await deployRaw(runtime, `https://open.chinanetcenter.com${path}`, {
    method, headers, body, timeoutMs: 30_000,
  }, '网宿');
  const result: WangsuResponse = {
    status: response.status,
    text: await response.text(),
    location: response.headers.get('location') ?? '',
  };
  let parsed: unknown = null;
  try { parsed = result.text ? JSON.parse(result.text) : null; } catch { parsed = null; }
  if (result.status === 201 || (result.status === 200 && options.wantLocation)) {
    return { value: result.location.trim() || true, location: result.location.trim() };
  }
  if (result.status >= 200 && result.status <= 299) return { value: parsed ?? true, location: result.location };
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const message = record.message ?? record.result;
  if (typeof message === 'string' && message) throw new Error(message);
  throw new Error('请求失败');
}

function lastSegment(value: string): string {
  try { return new URL(value, 'https://open.chinanetcenter.com').pathname.split('/').filter(Boolean).pop() ?? ''; } catch { return ''; }
}

async function encryptPrivateKey(account: WangsuClient, privateKey: string, date: string): Promise<string> {
  const secret = account.spKey || account.apiKey;
  const hex = Array.from(new Uint8Array(await hmacSha256Raw(encoder.encode(secret), date)))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const iv = Uint8Array.from(hex.slice(0, 32).match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
  const key = Uint8Array.from(hex.slice(32, 64).match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, encoder.encode(privateKey));
  return base64Of(encrypted);
}

async function certificateId(
  runtime: DeployRuntime, account: WangsuClient, material: { fullchain: string; privateKey: string },
  name: string, currentId: string, serial: string, overwrite: boolean,
): Promise<string> {
  if (currentId) {
    let data: Record<string, unknown>;
    try {
      const result = await request(runtime, account, `/api/certificate/${currentId}`);
      data = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
    } catch (error) {
      throw new Error(`获取证书详情失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    const detail = data.data && typeof data.data === 'object' ? data.data as Record<string, unknown> : {};
    if (data.message === 'success' && detail.name === name && detail.serial === serial) {
      runtime.log(`证书已是最新，证书ID：${currentId}`);
      return currentId;
    }
    runtime.log('证书已过期或被删除，准备重新上传');
  } else if (overwrite) {
    throw new Error('证书ID不能为空');
  }

  if (overwrite) {
    try {
      await request(runtime, account, `/api/certificate/${currentId}`, {
        method: 'PUT', json: true, data: { name, certificate: material.fullchain, privateKey: material.privateKey },
      });
      runtime.log(`更新证书成功，证书ID：${currentId}`);
      return currentId;
    } catch (error) {
      throw new Error(`更新证书失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
  }

  let certificates: Record<string, unknown>[] = [];
  try {
    const result = await request(runtime, account, '/api/ssl/certificate');
    const list = result.value && typeof result.value === 'object'
      ? (result.value as Record<string, unknown>)['ssl-certificate'] : undefined;
    certificates = Array.isArray(list) ? list as Record<string, unknown>[] : [];
  } catch (error) {
    throw new Error(`获取证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  for (const certificate of certificates) {
    if (certificate['certificate-serial'] === serial) {
      const id = String(certificate['certificate-id'] ?? '');
      runtime.log(`证书${name}已存在，新证书ID：${id}`);
      try {
        await request(runtime, account, `/api/certificate/${id}`, { method: 'PUT', json: true, data: { name } });
      } catch (error) {
        throw new Error(`证书更名失败：${error instanceof Error ? error.message : '请求失败'}`);
      }
      runtime.log(`将证书ID为${id}的证书更名为：${name}`);
      return id;
    }
    if (certificate.name === name) {
      const id = String(certificate['certificate-id'] ?? '');
      runtime.log(`证书${name}已存在，但序列号（${id}）不匹配，准备重新上传`);
      try {
        await request(runtime, account, `/api/certificate/${id}`, { method: 'PUT', json: true, data: { name: `${name}-bak` } });
      } catch (error) {
        throw new Error(`证书更名失败：${error instanceof Error ? error.message : '请求失败'}`);
      }
      runtime.log(`将证书ID为${id}的证书更名为：${name}-bak`);
    }
  }

  let location = '';
  try {
    const result = await request(runtime, account, '/api/certificate', {
      method: 'POST', json: true, wantLocation: true,
      data: { name, certificate: material.fullchain, privateKey: material.privateKey },
    });
    location = result.location;
  } catch (error) {
    throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const id = lastSegment(location);
  runtime.log(`上传证书成功，证书ID：${id}`);
  return id;
}

async function cdnProCertificateId(
  runtime: DeployRuntime, account: WangsuClient, material: { fullchain: string; privateKey: string }, name: string,
): Promise<string> {
  let data: Record<string, unknown>;
  try {
    const result = await request(runtime, account, `/cdn/certificates?search=${encodeURIComponent(name)}`);
    data = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`获取证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const list = Array.isArray(data.certificates) ? data.certificates as Record<string, unknown>[] : [];
  if (Number(data.count ?? 0) > 0) {
    for (const certificate of list) {
      if (certificate.name === name) {
        const id = String(certificate.certificateId ?? '');
        runtime.log(`证书${name}已存在，证书ID：${id}`);
        return id;
      }
    }
  }
  const date = httpDate();
  const encrypted = await encryptPrivateKey(account, material.privateKey, date);
  let location = '';
  try {
    const result = await request(runtime, account, '/cdn/certificates', {
      method: 'POST', json: true, date, wantLocation: true,
      data: { name, autoRenew: 'Off', newVersion: { privateKey: encrypted, certificate: material.fullchain } },
    });
    location = result.location;
  } catch (error) {
    throw new Error(`上传证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const id = lastSegment(location);
  runtime.log(`上传证书成功，证书ID：${id}`);
  await delay(500);
  return id;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployCdn(
  runtime: DeployRuntime, account: WangsuClient, config: DeployTaskConfig, material: { fullchain: string; privateKey: string },
): Promise<void> {
  const domains = splitList(config.domain as string | undefined);
  if (domains.length === 0) throw new Error('绑定的域名不能为空');
  const info = certificateInfo(material.fullchain);
  const name = certificateName(material.fullchain);
  const serial = info.serialNumber.toLowerCase();
  runtime.log(`证书序列号：${serial}`);
  const current = typeof runtime.state.cert_id === 'string' ? runtime.state.cert_id : '';
  const id = await certificateId(runtime, account, material, name, current, serial, false);
  try {
    await request(runtime, account, '/api/config/certificate/batch', {
      method: 'PUT', json: true, data: { certificateId: id, domainNames: domains },
    });
  } catch (error) {
    throw new Error(`绑定域名失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  runtime.log(`绑定证书成功，证书ID：${id}`);
  runtime.state.cert_id = id;
}

async function deployCdnPro(
  runtime: DeployRuntime, account: WangsuClient, config: DeployTaskConfig, material: { fullchain: string; privateKey: string },
): Promise<void> {
  const domain = requireField(config, 'domain', '绑定的域名');
  const name = certificateName(material.fullchain);
  const id = await cdnProCertificateId(runtime, account, material, name);

  let hostname: Record<string, unknown>;
  try {
    const result = await request(runtime, account, `/cdn/hostnames/${encodeURIComponent(domain)}`);
    hostname = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`获取域名信息失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  const production = hostname.propertyInProduction;
  if (!production || typeof production !== 'object') throw new Error(`域名 ${domain} 不存在或未部署到生产环境`);
  const property = production as Record<string, unknown>;
  runtime.log(`CDN域名 ${domain} 对应的加速项目ID：${String(property.propertyId)}`);
  runtime.log(`CDN域名 ${domain} 对应的加速项目生产版本：${String(property.version)}`);
  if (String(property.certificateId ?? '') === id) {
    runtime.log(`CDN域名 ${domain} 已绑定证书：${name}`);
    return;
  }

  let configs: Record<string, unknown>;
  try {
    const result = await request(runtime, account, `/cdn/properties/${String(property.propertyId)}/versions/${String(property.version)}`);
    const value = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
    configs = value.configs && typeof value.configs === 'object'
      ? { ...(value.configs as Record<string, unknown>) } : {};
  } catch (error) {
    throw new Error(`获取加速项目版本信息失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  configs.tlsCertificateId = id;

  let newVersion: string;
  try {
    const result = await request(runtime, account, `/cdn/properties/${String(property.propertyId)}/versions`, {
      method: 'POST', json: true, wantLocation: true, data: configs,
    });
    newVersion = lastSegment(result.location);
  } catch (error) {
    throw new Error(`新增加速项目版本失败：${error instanceof Error ? error.message : '请求失败'}`);
  }

  let validationTaskId: string;
  try {
    const result = await request(runtime, account, '/cdn/validations', {
      method: 'POST', json: true, wantLocation: true,
      data: { propertyId: property.propertyId, version: Number(newVersion) },
    });
    validationTaskId = lastSegment(result.location);
  } catch (error) {
    throw new Error(`发起加速项目验证失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  runtime.log(`验证任务ID：${validationTaskId}`);

  const maxAttempts = 12;
  let status = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await delay(3000);
    try {
      const result = await request(runtime, account, `/cdn/validations/${validationTaskId}`);
      const value = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
      status = String(value.status ?? '');
    } catch (error) {
      throw new Error(`获取验证任务状态失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    if (status === 'failed') throw new Error('证书绑定失败，加速项目验证失败');
    if (status === 'succeeded') break;
  }
  if (status !== 'succeeded') throw new Error('证书绑定超时，加速项目验证时间过长');
  runtime.log('加速项目验证成功，开始部署...');

  try {
    await request(runtime, account, '/cdn/deploymentTasks', {
      method: 'POST', json: true, wantLocation: true,
      headers: { 'check-certificate': 'no', 'check-usage': 'no' },
      data: {
        target: 'production',
        actions: [
          { action: 'deploy_cert', certificateId: id, version: 1 },
          { action: 'deploy_property', propertyId: property.propertyId, version: Number(newVersion) },
        ],
        name: `Deploy certificate and property for ${String(property.propertyId)}`,
      },
    });
  } catch (error) {
    throw new Error(`下发证书部署任务失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  runtime.log(`CDN域名 ${domain} 绑定证书部署任务下发成功`);
  runtime.state.cert_id = id;
}

async function deployCdnProCertificate(
  runtime: DeployRuntime, account: WangsuClient, config: DeployTaskConfig, material: { fullchain: string; privateKey: string },
): Promise<void> {
  const name = certificateName(material.fullchain);
  const id = requireField(config, 'cert_id', '证书ID');

  let detail: Record<string, unknown>;
  try {
    const result = await request(runtime, account, `/cdn/certificates/${id}`);
    detail = result.value && typeof result.value === 'object' ? result.value as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`证书ID ${id} 不存在或获取失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  if (detail.name === name) {
    runtime.log(`证书已是最新，无需更新，证书ID：${id}`);
    runtime.state.cert_id = id;
    return;
  }
  runtime.log('证书已过期，准备更新...');

  const date = httpDate();
  const encrypted = await encryptPrivateKey(account, material.privateKey, date);
  let version = 1;
  try {
    const result = await request(runtime, account, `/cdn/certificates/${id}`, {
      method: 'PATCH', json: true, date, wantLocation: true,
      data: {
        name,
        newVersion: { privateKey: encrypted, certificate: material.fullchain, comments: name },
      },
    });
    const parsed = Number(lastSegment(result.location));
    if (Number.isSafeInteger(parsed) && parsed > 0) version = parsed;
  } catch (error) {
    throw new Error(`更新证书失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  runtime.log(`更新证书成功，证书ID：${id}，版本号：${version}`);

  try {
    await request(runtime, account, '/cdn/deploymentTasks', {
      method: 'POST', json: true, wantLocation: true,
      headers: { 'check-certificate': 'no', 'check-usage': 'no' },
      data: {
        target: 'production',
        actions: [{ action: 'deploy_cert', certificateId: id, version }],
        name: `Deploy certificate ${name}`,
      },
    });
  } catch (error) {
    throw new Error(`下发证书部署任务失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  runtime.log('证书部署任务下发成功');
  runtime.state.cert_id = id;
}

export const wangsu: DeployProvider = {
  meta: deployMeta('wangsu'),

  async check(config, runtime) {
    await request(runtime, client(config), '/api/ssl/certificate');
  },

  async deploy(taskConfig, config, material, runtime) {
    const account = client(config);
    const product = typeof taskConfig.product === 'string' && taskConfig.product ? taskConfig.product : 'cdn';
    if (product === 'cdn') return deployCdn(runtime, account, taskConfig, material);
    if (product === 'cdnpro') return deployCdnPro(runtime, account, taskConfig, material);
    if (product === 'cdnpro_certificate') return deployCdnProCertificate(runtime, account, taskConfig, material);
    if (product === 'certificate') {
      const info = certificateInfo(material.fullchain);
      const name = certificateName(material.fullchain);
      const id = requireField(taskConfig, 'cert_id', '证书ID');
      await certificateId(runtime, account, material, name, id, info.serialNumber.toLowerCase(), true);
      return;
    }
    throw new Error('未知的产品类型');
  },
};
