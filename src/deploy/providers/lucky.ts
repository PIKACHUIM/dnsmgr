import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonObject, readArray, readString } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function base(config: DeployTaskConfig): string {
  const path = typeof config.path === 'string' ? config.path : '';
  return `${panelBaseUrl(config)}${path}`;
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string,
  payload?: Record<string, unknown>, method: 'GET' | 'PUT' = 'GET',
): Promise<Record<string, unknown>> {
  const text = await deployRequest(runtime, `${base(config)}${path}`, {
    method,
    headers: {
      openToken: requireField(config, 'opentoken', 'OpenToken'),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  }, 'Lucky');
  const body = parseJsonObject(text, 'Lucky');
  if (body.ret === 0) return body;
  throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '请求失败');
}

export const lucky: DeployProvider = {
  meta: deployMeta('lucky'),

  async check(config, runtime) {
    await api(runtime, config, '/api/modules/list');
  },

  async deploy(_taskConfig, config, material, runtime) {
    if (material.domains.length === 0) throw new Error('没有设置要部署的域名');
    const body = await api(runtime, config, '/api/ssl');
    runtime.log('获取证书列表成功');
    let success = 0;
    let lastError = '';
    for (const row of readArray(body, 'list')) {
      const info = row.CertsInfo && typeof row.CertsInfo === 'object' ? row.CertsInfo as Record<string, unknown> : {};
      const domains = Array.isArray(info.Domains) ? info.Domains.map(String) : [];
      if (domains.length === 0) continue;
      if (!domains.some((domain) => material.domains.includes(domain))) continue;
      const key = readString(row, 'Key');
      try {
        await api(runtime, config, '/api/ssl', {
          Key: row.Key,
          CertBase64: btoa(material.fullchain),
          KeyBase64: btoa(material.privateKey),
          AddFrom: 'file',
          Enable: true,
          MappingToPath: false,
          Remark: typeof row.Remark === 'string' ? row.Remark : '',
          AllSyncClient: false,
        }, 'PUT');
        runtime.log(`证书ID:${key}更新成功！`);
        success += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : '请求失败';
        runtime.log(`证书ID:${key}更新失败：${lastError}`);
      }
    }
    if (success === 0) throw new Error(lastError || '没有要更新的证书');
  },
};
