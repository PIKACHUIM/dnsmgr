import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonObject, readString } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function useApiKey(config: DeployTaskConfig): boolean {
  return String(config.auth ?? '0') === '1';
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string,
  payload?: Record<string, unknown>, method: 'GET' | 'POST' | 'PUT' = 'GET', token = '',
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (useApiKey(config)) headers.Authorization = requireField(config, 'api_key', 'API访问令牌');
  if (payload) headers['content-type'] = 'application/json;charset=UTF-8';
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  }, 'LeCDN');
  const body = parseJsonObject(text, 'LeCDN');
  if (body.code === 200) {
    return body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : null;
  }
  throw new Error(typeof body.message === 'string' && body.message ? body.message : '返回数据解析失败');
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const email = requireField(config, 'email', '邮箱地址');
  const result = await api(runtime, config, '/prod-api/login', {
    email,
    username: email,
    password: requireField(config, 'password', '密码'),
  }, 'POST');
  const token = result ? readString(result, 'token') : '';
  if (!token) throw new Error('登录成功，获取access_token失败');
  return token;
}

export const lecdn: DeployProvider = {
  meta: deployMeta('lecdn'),

  async check(config, runtime) {
    if (useApiKey(config)) {
      await api(runtime, config, '/prod-api/system/info');
      return;
    }
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    const token = useApiKey(config) ? '' : await login(runtime, config);
    const current = typeof taskConfig.id === 'string' ? taskConfig.id.trim() : '';
    if (!current) {
      const created = await api(runtime, config, '/prod-api/certificate', {
        name: certificateName(material.fullchain),
        type: 'upload',
        ssl_pem: btoa(material.fullchain),
        ssl_key: btoa(material.privateKey),
        auto_renewal: false,
      }, 'POST', token);
      const id = created ? readString(created, 'id') : '';
      if (!id) throw new Error('添加证书失败:响应未返回证书ID');
      runtime.saveConfig({ id });
      runtime.log(`证书ID:${id}添加成功！`);
      return;
    }
    let existing: Record<string, unknown> | null;
    try {
      existing = await api(runtime, config, `/prod-api/certificate/${encodeURIComponent(current)}`, undefined, 'GET', token);
    } catch (error) {
      throw new Error(`证书ID:${current}获取失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    await api(runtime, config, `/prod-api/certificate/${encodeURIComponent(current)}`, {
      id: Number(current),
      name: existing ? readString(existing, 'name') : '',
      description: existing ? readString(existing, 'description') : '',
      type: 'upload',
      ssl_pem: btoa(material.fullchain),
      ssl_key: btoa(material.privateKey),
      auto_renewal: false,
    }, 'PUT', token);
    runtime.log(`证书ID:${current}更新成功！`);
  },
};
