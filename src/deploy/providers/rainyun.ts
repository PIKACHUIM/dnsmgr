import { deployMeta } from '../metadata';
import { deployRequest, parseJsonObject, readString, withQuery } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://api.v2.rainyun.com';

function headers(config: DeployTaskConfig): Record<string, string> {
  return { 'x-api-key': requireField(config, 'apikey', 'ApiKey') };
}

async function request(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, payload?: unknown, method?: 'POST' | 'PUT',
): Promise<Record<string, unknown> | null> {
  const text = payload === undefined
    ? await deployRequest(runtime, `${API}${path}`, { headers: headers(config) }, '雨云')
    : await deployRequest(runtime, `${API}${path}`, {
      method: method ?? 'POST',
      headers: { ...headers(config), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, '雨云');
  const body = parseJsonObject(text, '雨云');
  if (body.code === 200) {
    return body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : null;
  }
  throw new Error(typeof body.message === 'string' && body.message ? body.message : '请求失败');
}

export const rainyun: DeployProvider = {
  meta: deployMeta('rainyun'),

  async check(config, runtime) {
    await request(runtime, config, '/product/');
  },

  async deploy(taskConfig, config, material, runtime) {
    const payload = { cert: material.fullchain, key: material.privateKey };
    const current = typeof taskConfig.id === 'string' ? taskConfig.id.trim() : '';
    if (current) {
      await request(runtime, config, `/product/sslcenter/${encodeURIComponent(current)}`, payload, 'PUT');
      runtime.log(`证书ID:${current}更新成功！`);
      return;
    }
    await request(runtime, config, '/product/sslcenter/', payload);
    const listPath = withQuery('/product/sslcenter/', {
      options: '{"columnFilters":{"Domain":""},"sort":[],"page":1,"perPage":1}',
    });
    const data = await request(runtime, config, listPath);
    const records = data && Array.isArray(data.Records) ? data.Records : [];
    const first = records[0] as Record<string, unknown> | undefined;
    const id = first ? readString(first, 'ID') : '';
    if (!id) throw new Error('未找到已上传的证书');
    runtime.saveConfig({ id });
    runtime.log(`证书ID:${id}添加成功！`);
  },
};
