import { deployMeta } from '../metadata';
import { deployRequest, parseJsonValue, panelBaseUrl } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string,
  payload?: Record<string, unknown>, method: 'GET' | 'POST' | 'PUT' = 'POST', token = '',
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload) headers['content-type'] = 'application/json;charset=UTF-8';
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  }, '南墙WAF');
  return parseJsonValue(text, '南墙WAF');
}

function detailOf(value: unknown): string {
  return typeof value === 'string' ? value : '未知错误';
}

export const uusec: DeployProvider = {
  meta: deployMeta('uusec'),

  async check(config, runtime) {
    const result = await api(runtime, config, '/api/v1/users/login', {
      usr: requireField(config, 'username', '用户名'),
      pwd: requireField(config, 'password', '密码'),
      otp: '',
    });
    if (!result || typeof result !== 'object' || !('token' in result)) {
      throw new Error(`登录失败，${detailOf((result as Record<string, unknown>)?.err)}`);
    }
  },

  async deploy(taskConfig, config, material, runtime) {
    const id = requireField(taskConfig, 'id', '证书ID');
    const login = await api(runtime, config, '/api/v1/users/login', {
      usr: requireField(config, 'username', '用户名'),
      pwd: requireField(config, 'password', '密码'),
      otp: '',
    });
    const token = login && typeof login === 'object' ? String((login as Record<string, unknown>).token ?? '') : '';
    if (!token) {
      throw new Error(`登录失败，${detailOf((login as Record<string, unknown>)?.err)}`);
    }
    const name = typeof taskConfig.name === 'string' ? taskConfig.name : '';
    const result = await api(runtime, config, '/api/v1/certs', {
      id: Number(id),
      type: 1,
      name,
      crt: material.fullchain,
      key: material.privateKey,
    }, 'PUT', token);
    if (result === 'OK') {
      runtime.log(`证书ID:${id}更新成功！`);
      return;
    }
    throw new Error(`证书ID:${id}更新失败，${detailOf((result as Record<string, unknown>)?.err)}`);
  },
};
