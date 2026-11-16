import { deployMeta } from '../metadata';
import { deployRaw, parseJsonObject, readSetCookies, readString, withQuery } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const CONSOLE = 'https://console.upyun.com';

/** 证书链中的第一张证书是否为 EC 公钥（对应 PHP 的 openssl_pkey_get_details 类型判断）。 */
function isEcCertificate(fullchain: string): boolean {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(fullchain);
  if (!match || !match[1]) return false;
  let binary: string;
  try { binary = atob(match[1].replace(/\s+/g, '')); } catch { return false; }
  const der = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // subjectPublicKeyInfo 中的 id-ecPublicKey OID
  const oid = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
  outer: for (let i = 0; i + oid.length <= der.length; i++) {
    for (let j = 0; j < oid.length; j++) {
      if (der[i + j] !== oid[j]) continue outer;
    }
    return true;
  }
  return false;
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const response = await deployRaw(runtime, `${CONSOLE}/accounts/signin/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: requireField(config, 'username', '用户名'),
      password: requireField(config, 'password', '密码'),
    }).toString(),
  }, '又拍云');
  const text = await response.text();
  const body = parseJsonObject(text, '又拍云');
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
  if (data.result !== true) {
    throw new Error(`登录失败:${readString(data, 'message') || '请求失败'}`);
  }
  const cookies = readSetCookies(response);
  if (cookies.length === 0) throw new Error('登录成功，获取cookie失败');
  return `${cookies.join('; ')}; `;
}

async function certificateApi(
  runtime: DeployRuntime, cookie: string, url: string, body?: string,
): Promise<Record<string, unknown>> {
  const response = await deployRaw(runtime, url, {
    method: body ? 'POST' : 'GET',
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  }, '又拍云');
  if (!response.ok) throw new Error(`又拍云返回 HTTP ${response.status}`);
  const parsed = parseJsonObject(await response.text(), '又拍云');
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data as Record<string, unknown> : {};
  return data;
}

export const upyun: DeployProvider = {
  meta: deployMeta('upyun'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(_taskConfig, config, material, runtime) {
    const cookie = await login(runtime, config);
    const privateKey = isEcCertificate(material.fullchain)
      ? material.privateKey
        .replace('-----BEGIN PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----')
        .replace('-----END PRIVATE KEY-----', '-----END EC PRIVATE KEY-----')
      : material.privateKey;
    const uploaded = await certificateApi(runtime, cookie, `${CONSOLE}/api/https/certificate/`, new URLSearchParams({
      certificate: material.fullchain,
      private_key: privateKey,
    }).toString());
    if (uploaded.status !== 0) throw new Error(`证书上传失败:${readString(uploaded, 'message') || '请求失败'}`);
    const result = uploaded.result && typeof uploaded.result === 'object' ? uploaded.result as Record<string, unknown> : {};
    const commonName = readString(result, 'commonName');
    const certificateId = readString(result, 'certificate_id');
    runtime.log(`证书上传成功！证书ID:${certificateId}`);

    const searchUrl = withQuery(`${CONSOLE}/api/https/certificate/search`, { limit: '100', domain: commonName });
    const searched = await certificateApi(runtime, cookie, searchUrl);
    const entries = searched.result && typeof searched.result === 'object' && !Array.isArray(searched.result)
      ? Object.entries(searched.result as Record<string, unknown>)
      : null;
    if (!entries) throw new Error(`查找证书失败:${readString(searched, 'message') || '请求失败'}`);

    let migrated = 0;
    let domains = 0;
    for (const [certId, raw] of entries) {
      const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      if (certId === certificateId || readString(item, 'commonName') !== commonName) continue;
      const configured = Number(item.config_domain ?? 0);
      if (!configured) continue;
      const migratedBody = new URLSearchParams({ new_crt_id: certificateId, old_crt_id: certId }).toString();
      const response = await certificateApi(runtime, cookie, `${CONSOLE}/api/https/migrate/certificate`, migratedBody);
      if (response.result !== true) {
        throw new Error(`证书迁移失败:${readString(response, 'message') || '请求失败'}`);
      }
      migrated += 1;
      domains += configured;
      runtime.log(`证书ID:${certId} 迁移成功！`);
    }
    runtime.log(migrated === 0 ? '未找到可迁移的证书' : `共迁移${migrated}个证书,关联域名${domains}个`);
  },
};
