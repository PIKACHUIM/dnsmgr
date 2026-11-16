import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonValue, readArray, readString } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      'XP-API-KEY': requireField(config, 'apikey', '接口密钥'),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  }, '小皮面板');
  const parsed = parseJsonValue(text, '小皮面板');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('返回数据解析失败');
  return parsed as Record<string, unknown>;
}

function ensureOk(body: Record<string, unknown>): void {
  if (body.code === 1000) return;
  throw new Error(typeof body.message === 'string' && body.message ? body.message : '请求失败');
}

export const xp: DeployProvider = {
  meta: deployMeta('xp'),

  async check(config, runtime) {
    ensureOk(await api(runtime, config, '/openApi/siteList'));
  },

  async deploy(taskConfig, config, material, runtime) {
    const sites = splitList(taskConfig.sites);
    const body = await api(runtime, config, '/openApi/siteList');
    ensureOk(body);
    let success = 0;
    let lastError = '';
    for (const site of readArray(body, 'data')) {
      const name = readString(site, 'name');
      if (!sites.includes(name)) continue;
      try {
        const result = await api(runtime, config, '/openApi/setSSL', {
          id: site.id, key: material.privateKey, pem: material.fullchain,
        });
        ensureOk(result);
        runtime.log(`网站 ${name} 证书部署成功`);
        success += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : '请求失败';
        runtime.log(`网站 ${name} 证书部署失败：${lastError}`);
      }
    }
    if (success === 0) throw new Error(lastError || '要部署的网站不存在');
  },
};
