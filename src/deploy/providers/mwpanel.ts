import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonObject, postForm } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function headers(config: DeployTaskConfig): Record<string, string> {
  return {
    'app-id': requireField(config, 'appid', '应用ID'),
    'app-secret': requireField(config, 'appsecret', '应用密钥'),
  };
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `${panelBaseUrl(config)}${path}`;
  const text = params
    ? await postForm(runtime, url, params, headers(config), 'MW面板')
    : await deployRequest(runtime, url, { headers: headers(config) }, 'MW面板');
  return parseJsonObject(text, 'MW面板');
}

function ensureOk(body: Record<string, unknown>): void {
  if (body.status) return;
  throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '返回数据解析失败');
}

export const mwpanel: DeployProvider = {
  meta: deployMeta('mwpanel'),

  async check(config, runtime) {
    ensureOk(await api(runtime, config, '/task/count'));
  },

  async deploy(taskConfig, config, material, runtime) {
    if (taskConfig.type === '1') {
      ensureOk(await api(runtime, config, '/setting/save_panel_ssl', {
        privateKey: material.privateKey, certPem: material.fullchain, choose: 'local',
      }));
      runtime.log('面板证书部署成功');
      return;
    }
    let success = 0;
    let lastError = '';
    for (const site of splitList(taskConfig.sites)) {
      try {
        ensureOk(await api(runtime, config, '/site/set_ssl', {
          type: '1', siteName: site, key: material.privateKey, csr: material.fullchain,
        }));
        runtime.log(`网站 ${site} 证书部署成功`);
        success += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : '请求失败';
        runtime.log(`网站 ${site} 证书部署失败：${lastError}`);
      }
    }
    if (success === 0) throw new Error(lastError || '要部署的网站不存在');
  },
};
