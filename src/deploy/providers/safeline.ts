import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonObject, readArray, readString } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, payload?: Record<string, unknown>,
): Promise<unknown> {
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      'X-SLCE-API-TOKEN': requireField(config, 'token', 'API Token'),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  }, '雷池WAF');
  const body = parseJsonObject(text, '雷池WAF');
  if (body.data !== undefined) return body.data;
  if (typeof body.msg === 'string' && body.msg) throw new Error(body.msg);
  return null;
}

/** PHP 里的通配匹配：example.com → *.com，a.example.com → *.example.com。 */
function wildcardOf(domain: string): string {
  const dot = domain.indexOf('.');
  return dot < 0 ? `*${domain}` : `*${domain.slice(dot)}`;
}

export const safeline: DeployProvider = {
  meta: deployMeta('safeline'),

  async check(config, runtime) {
    await api(runtime, config, '/api/open/system');
  },

  async deploy(_taskConfig, config, material, runtime) {
    if (material.domains.length === 0) throw new Error('没有设置要部署的域名');
    const data = await api(runtime, config, '/api/open/cert');
    const body = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    runtime.log(`获取证书列表成功(total=${String(body.total ?? 0)})`);
    let success = 0;
    let lastError = '';
    for (const node of readArray(body, 'nodes')) {
      const domains = Array.isArray(node.domains) ? node.domains.map(String) : [];
      if (domains.length === 0) continue;
      const matched = domains.some((domain) => material.domains.includes(domain) || material.domains.includes(wildcardOf(domain)));
      if (!matched) continue;
      const id = readString(node, 'id');
      try {
        await api(runtime, config, '/api/open/cert', {
          id: node.id, manual: { crt: material.fullchain, key: material.privateKey }, type: 2,
        });
        runtime.log(`证书ID:${id}更新成功！`);
        success += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : '请求失败';
        runtime.log(`证书ID:${id}更新失败：${lastError}`);
      }
    }
    if (success > 0) return;
    await api(runtime, config, '/api/open/cert', {
      manual: { crt: material.fullchain, key: material.privateKey }, type: 2,
    });
    runtime.log(lastError ? `已有证书均更新失败，已上传新证书（${lastError}）` : '证书上传成功！');
  },
};
