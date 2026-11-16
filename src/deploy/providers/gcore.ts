import { deployMeta } from '../metadata';
import { DeployHttpError, deployRequest, parseJsonObject } from '../http';
import { requireField, type DeployProvider, type DeployTaskConfig } from '../types';

const API = 'https://api.gcore.com';

function authorization(config: DeployTaskConfig): Record<string, string> {
  return { Authorization: `APIKey ${requireField(config, 'apikey', 'API令牌')}` };
}

function errorMessage(error: unknown): string {
  if (!(error instanceof DeployHttpError)) return error instanceof Error ? error.message : '请求失败';
  try {
    const body = parseJsonObject(error.body, 'Gcore');
    const nested = body.message as { message?: unknown } | undefined;
    if (nested && typeof nested.message === 'string') return nested.message;
    if (body.errors && typeof body.errors === 'object') {
      const first = Object.values(body.errors as Record<string, unknown>)[0];
      if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
    }
  } catch { /* 落到默认提示 */ }
  return error.message;
}

export const gcore: DeployProvider = {
  meta: deployMeta('gcore'),

  async check(config, runtime) {
    try {
      await deployRequest(runtime, `${API}/iam/clients/me`, { headers: authorization(config) }, 'Gcore');
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  },

  async deploy(taskConfig, config, material, runtime) {
    const id = requireField(taskConfig, 'id', '证书ID');
    const name = typeof taskConfig.name === 'string' ? taskConfig.name.trim() : '';
    try {
      await deployRequest(runtime, `${API}/cdn/sslData/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { ...authorization(config), 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          sslCertificate: material.fullchain,
          sslPrivateKey: material.privateKey,
          validate_root_ca: true,
        }),
      }, 'Gcore');
    } catch (error) {
      throw new Error(errorMessage(error));
    }
    runtime.log(`证书ID:${id}更新成功！`);
  },
};
