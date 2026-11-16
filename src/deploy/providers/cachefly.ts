import { deployMeta } from '../metadata';
import { deployRequest, postJson } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://api.cachefly.com/api/2.5';

function authorization(config: DeployTaskConfig): Record<string, string> {
  return { 'x-cf-authorization': `Bearer ${requireField(config, 'apikey', 'API令牌')}` };
}

export const cachefly: DeployProvider = {
  meta: deployMeta('cachefly'),

  async check(config, runtime: DeployRuntime) {
    await deployRequest(runtime, `${API}/accounts/me`, { headers: authorization(config) }, 'Cachefly');
  },

  async deploy(_taskConfig, config, material, runtime) {
    await postJson(runtime, `${API}/certificates`, {
      certificate: material.fullchain,
      certificateKey: material.privateKey,
    }, authorization(config), 'Cachefly');
    runtime.log('证书上传成功！');
  },
};
