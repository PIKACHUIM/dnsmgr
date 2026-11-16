import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, parseJsonObject, panelBaseUrl, readString } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function usePassword(config: DeployTaskConfig): boolean {
  return String(config.auth ?? '0') === '1';
}

function keyHeaders(config: DeployTaskConfig): Record<string, string> {
  return {
    'api-key': requireField(config, 'api_key', 'api_key'),
    'api-secret': requireField(config, 'api_secret', 'api_secret'),
  };
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account: requireField(config, 'username', '登录账号'),
      password: requireField(config, 'password', '登录密码'),
    }),
  }, 'Cdnfly');
  const body = parseJsonObject(text, 'Cdnfly');
  if (body.code !== 0) throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '登录失败，返回数据解析失败');
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
  const token = readString(data, 'access_token');
  if (!token) throw new Error('登录失败，返回数据解析失败');
  return token;
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, method: 'GET' | 'POST' | 'PUT',
  payload?: Record<string, unknown>, token = '',
): Promise<unknown> {
  const headers: Record<string, string> = token ? { 'Access-Token': token } : keyHeaders(config);
  if (payload) headers['content-type'] = 'application/json';
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  }, 'Cdnfly');
  const body = parseJsonObject(text, 'Cdnfly');
  if (body.code === 0) return body.data ?? null;
  throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '返回数据解析失败');
}

export const cdnfly: DeployProvider = {
  meta: deployMeta('cdnfly'),

  async check(config, runtime) {
    if (usePassword(config)) {
      await login(runtime, config);
      return;
    }
    await api(runtime, config, '/v1/user', 'GET');
  },

  async deploy(taskConfig, config, material, runtime) {
    const token = usePassword(config) ? await login(runtime, config) : '';
    const current = typeof taskConfig.id === 'string' ? taskConfig.id.trim() : '';
    if (!current) {
      let created: unknown;
      try {
        created = await api(runtime, config, '/v1/certs', 'POST', {
          type: 'custom', name: certificateName(material.fullchain),
          cert: material.fullchain, key: material.privateKey,
        }, token);
      } catch (error) {
        throw new Error(`证书添加失败，${error instanceof Error ? error.message : '返回数据解析失败'}`);
      }
      const id = typeof created === 'string' ? created : created === null ? '' : String(created);
      if (!id) throw new Error('证书添加失败，返回数据解析失败');
      runtime.saveConfig({ id });
      runtime.log(`证书ID:${id}添加成功！`);
      return;
    }
    try {
      await api(runtime, config, `/v1/certs/${encodeURIComponent(current)}`, 'PUT', {
        type: 'custom', cert: material.fullchain, key: material.privateKey,
      }, token);
    } catch (error) {
      throw new Error(`证书ID:${current}更新失败，${error instanceof Error ? error.message : '返回数据解析失败'}`);
    }
    runtime.log(`证书ID:${current}更新成功！`);
  },
};
