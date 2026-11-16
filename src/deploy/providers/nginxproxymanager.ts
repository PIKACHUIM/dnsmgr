import { deployMeta } from '../metadata';
import { deployRaw, panelBaseUrl } from '../http';
import {
  requireField, type DeployMaterial, type DeployProvider, type DeployRuntime, type DeployTaskConfig,
} from '../types';

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, token: string, method: string, path: string,
  payload?: unknown,
): Promise<unknown> {
  const base = panelBaseUrl(config);
  const headers: Record<string, string> = {};
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await deployRaw(runtime, `${base}/api${path}`, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), timeoutMs: 30_000,
  }, 'NPM');
  const text = await response.text();
  if (response.status >= 200 && response.status < 300) {
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { parsed = null; }
  const errorObject = parsed?.error;
  if (errorObject && typeof errorObject === 'object' && typeof (errorObject as Record<string, unknown>).message === 'string') {
    throw new Error(String((errorObject as Record<string, unknown>).message));
  }
  if (typeof parsed?.message === 'string' && parsed.message) throw new Error(parsed.message);
  if (typeof errorObject === 'string' && errorObject) throw new Error(errorObject);
  const detail = text.trim();
  if (detail) throw new Error(`请求失败(httpCode=${response.status})：${detail.slice(0, 300)}`);
  throw new Error(`请求失败(httpCode=${response.status})`);
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  requireField(config, 'email', '登录邮箱');
  requireField(config, 'password', '登录密码');
  panelBaseUrl(config);
  const result = await api(runtime, config, '', 'POST', '/tokens', {
    identity: requireField(config, 'email', '登录邮箱'),
    secret: requireField(config, 'password', '登录密码'),
  });
  const body = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  if (typeof body.token === 'string' && body.token) return body.token;
  if (body.requires_2fa) throw new Error('当前 NPM 账户启用了双因素认证，暂不支持');
  throw new Error('登录 NPM 失败，未返回访问令牌');
}

function record(value: unknown, fallback: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(fallback);
  return value as Record<string, unknown>;
}

function domainMatches(pattern: string, domain: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedPattern || !normalizedDomain) return false;
  if (normalizedPattern === normalizedDomain) return true;
  if (normalizedPattern.startsWith('*.')) return normalizedDomain.endsWith(normalizedPattern.slice(1));
  return false;
}

function hasIntersectDomain(domains: string[], hostDomains: unknown): boolean {
  if (!Array.isArray(hostDomains)) return false;
  for (const raw of hostDomains) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    for (const domain of domains) {
      if (domainMatches(domain, raw) || domainMatches(raw, domain)) return true;
    }
  }
  return false;
}

function splitFullchain(fullchain: string): [string, string] {
  const blocks = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const certificates = blocks.map((block) => block.trim()).filter(Boolean);
  if (certificates.length === 0) throw new Error('证书内容格式错误，未找到 PEM 证书块');
  const certificate = `${certificates[0]}\n`;
  const intermediate = certificates.length > 1 ? `${certificates.slice(1).join('\n')}\n` : '';
  return [certificate, intermediate];
}

export const nginxproxymanager: DeployProvider = {
  meta: deployMeta('nginxproxymanager'),

  async check(config, runtime) {
    const token = await login(runtime, config);
    await api(runtime, config, token, 'GET', '/nginx/certificates');
  },

  async deploy(taskConfig, config, material, runtime) {
    const domains = material.domains.map((domain) => domain.trim()).filter(Boolean);
    if (domains.length === 0) throw new Error('没有设置要部署的域名');
    const token = await login(runtime, config);

    const certificateId = Number(taskConfig.id ?? 0);
    if (Number.isSafeInteger(certificateId) && certificateId > 0) {
      runtime.log(`使用配置中的证书ID:${certificateId} 直接更新 NPM 自定义证书`);
      const certificate = record(
        await api(runtime, config, token, 'GET', `/nginx/certificates/${certificateId}`),
        `证书ID:${certificateId} 不存在`,
      );
      assertCustomCertificate(certificate, certificateId);
      await uploadCertificate(runtime, config, token, certificateId, material);
      runtime.log(`证书ID:${certificateId} 更新成功！`);
      return;
    }

    const hostId = Number(taskConfig.host_id ?? 0);
    const hosts = await resolveTargetHosts(runtime, config, token, domains, Number.isSafeInteger(hostId) ? hostId : 0);
    if (hosts.length === 0) throw new Error('未找到匹配的 Proxy Host，请填写证书ID或 Proxy Host ID');
    runtime.log(`匹配到 Proxy Host ${hosts.length} 个`);

    let resolvedId = 0;
    let conflict: string | null = null;
    for (const host of hosts) {
      const hostCertificateId = Number(host.certificate_id ?? 0);
      if (!Number.isSafeInteger(hostCertificateId) || hostCertificateId <= 0) continue;
      try {
        const certificate = record(
          await api(runtime, config, token, 'GET', `/nginx/certificates/${hostCertificateId}`),
          `证书ID:${hostCertificateId} 不存在`,
        );
        assertCustomCertificate(certificate, hostCertificateId);
        if (resolvedId === 0) {
          resolvedId = hostCertificateId;
        } else if (resolvedId !== hostCertificateId) {
          conflict = '匹配到多个 Proxy Host，但它们绑定了不同的自定义证书ID，无法自动决定更新哪个证书，请手动填写证书ID';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '请求失败';
        runtime.log(`Proxy Host ID:${String(host.id)} 当前证书不可直接更新：${message}`);
      }
    }
    if (conflict) throw new Error(conflict);

    if (resolvedId === 0) {
      const created = record(await api(runtime, config, token, 'POST', '/nginx/certificates', {
        provider: 'other', nice_name: domains[0],
      }), '创建 NPM 自定义证书失败');
      if (created.owner_user_id !== undefined) {
        runtime.log(`NPM 新建证书归属用户ID:${Number(created.owner_user_id ?? 0)}（由当前登录账号决定）`);
      }
      resolvedId = Number(created.id ?? 0);
      if (!Number.isSafeInteger(resolvedId) || resolvedId <= 0) throw new Error('创建 NPM 自定义证书失败');
      runtime.log(`创建自定义证书成功，证书ID:${resolvedId}`);
    }

    await uploadCertificate(runtime, config, token, resolvedId, material);
    runtime.log(`证书ID:${resolvedId} 更新成功！`);

    for (const host of hosts) {
      const currentId = Number(host.certificate_id ?? 0);
      if (currentId === resolvedId) {
        runtime.log(`Proxy Host ID:${String(host.id)} 已绑定目标证书，无需重复更新绑定`);
        continue;
      }
      await api(runtime, config, token, 'PUT', `/nginx/proxy-hosts/${Number(host.id)}`, { certificate_id: resolvedId });
      runtime.log(`Proxy Host ID:${String(host.id)} 已绑定到证书ID:${resolvedId}`);
    }
    runtime.saveConfig({ id: String(resolvedId) });
  },
};

function assertCustomCertificate(certificate: Record<string, unknown>, certificateId: number): void {
  if (certificate.provider !== 'other') {
    throw new Error(`证书ID:${certificateId} 不是自定义证书(provider=other)，无法通过上传接口更新`);
  }
}

async function getProxyHost(
  runtime: DeployRuntime, config: DeployTaskConfig, token: string, hostId: number,
): Promise<Record<string, unknown>> {
  const host = record(await api(runtime, config, token, 'GET', `/nginx/proxy-hosts/${hostId}`), `Proxy Host ID:${hostId} 不存在`);
  if (!host.id) throw new Error(`Proxy Host ID:${hostId} 不存在`);
  runtime.log(`读取 Proxy Host ID:${Number(host.id)} owner_user_id:${Number(host.owner_user_id ?? 0)} certificate_id:${Number(host.certificate_id ?? 0)}`);
  return host;
}

async function resolveTargetHosts(
  runtime: DeployRuntime, config: DeployTaskConfig, token: string, domains: string[], hostId: number,
): Promise<Record<string, unknown>[]> {
  if (hostId > 0) return [await getProxyHost(runtime, config, token, hostId)];
  const list = await api(runtime, config, token, 'GET', '/nginx/proxy-hosts');
  if (!Array.isArray(list)) throw new Error('获取 Proxy Host 列表失败');
  const matched: Record<string, unknown>[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const host = item as Record<string, unknown>;
    if (!hasIntersectDomain(domains, host.domain_names)) continue;
    matched.push(await getProxyHost(runtime, config, token, Number(host.id ?? 0)));
  }
  return matched;
}

async function uploadCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, token: string, certificateId: number, material: DeployMaterial,
): Promise<void> {
  const [certificate, intermediate] = splitFullchain(material.fullchain);
  const form = new FormData();
  form.append('certificate', new Blob([certificate], { type: 'application/x-pem-file' }), 'certificate.pem');
  form.append('certificate_key', new Blob([material.privateKey], { type: 'application/x-pem-file' }), 'certificate.key');
  if (intermediate) {
    form.append('intermediate_certificate', new Blob([intermediate], { type: 'application/x-pem-file' }), 'intermediate.pem');
  }
  const base = panelBaseUrl(config);
  const response = await deployRaw(runtime, `${base}/api/nginx/certificates/${certificateId}/upload`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form, timeoutMs: 30_000,
  }, 'NPM');
  const text = await response.text();
  if (response.status >= 200 && response.status < 300) return;
  let message = '';
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const error = value.error;
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
      message = String((error as Record<string, unknown>).message);
    } else if (typeof value.message === 'string') {
      message = value.message;
    }
  } catch { message = ''; }
  throw new Error(message ? `证书上传失败：${message}` : `证书上传失败(httpCode=${response.status})`);
}
