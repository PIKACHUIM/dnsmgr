import { certificateInfo } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, parseJsonObject, panelBaseUrl, postForm } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function headers(config: DeployTaskConfig): Record<string, string> {
  const user = requireField(config, 'api_user', 'API令牌ID');
  const key = requireField(config, 'api_key', 'API密钥');
  return { Authorization: `PVEAPIToken=${user}=${key}` };
}

async function request(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params?: Record<string, string>,
): Promise<unknown> {
  const base = panelBaseUrl(config);
  const text = params
    ? await postForm(runtime, `${base}${path}`, params, headers(config), 'Proxmox VE')
    : await deployRequest(runtime, `${base}${path}`, { headers: headers(config) }, 'Proxmox VE');
  const body = parseJsonObject(text, 'Proxmox VE');
  if (body.data !== undefined) return body.data;
  const errors = body.errors;
  if (errors !== undefined) {
    throw new Error(Array.isArray(errors) ? errors.join(';') : typeof errors === 'string' ? errors : '请求失败');
  }
  throw new Error('返回数据解析失败');
}

export const proxmox: DeployProvider = {
  meta: deployMeta('proxmox'),

  async check(config, runtime) {
    await request(runtime, config, '/api2/json/access');
  },

  async deploy(taskConfig, config, material, runtime) {
    const node = requireField(taskConfig, 'node', '节点名称');
    const fingerprint = certificateInfo(material.fullchain).fingerprintSha256;
    const encoded = encodeURIComponent(node);
    const list = await request(runtime, config, `/api2/json/nodes/${encoded}/certificates/info`);
    if (Array.isArray(list)) {
      for (const item of list) {
        const value = item && typeof item === 'object'
          ? String((item as Record<string, unknown>).fingerprint ?? '').toLowerCase().replaceAll(':', '')
          : '';
        if (value === fingerprint) {
          runtime.log(`节点：${node} 证书已存在`);
          return;
        }
      }
    }
    await request(runtime, config, `/api2/json/nodes/${encoded}/certificates/custom`, {
      certificates: material.fullchain,
      key: material.privateKey,
      force: '1',
      restart: '1',
    });
    runtime.log(`节点：${node} 证书部署成功！`);
  },
};
