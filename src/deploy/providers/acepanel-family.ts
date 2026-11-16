import { hmacSha256Hex, sha256Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { deployRequest, parseJsonObject, panelBaseUrl } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

/**
 * AcePanel 与耗子面板（ratpanel）接口、鉴权、字段完全一致，PHP 侧也是两份同源实现，
 * 这里共用一套逻辑，只用 meta 区分账户类型。
 */
export function acePanelFamily(type: 'acepanel' | 'ratpanel'): DeployProvider {
  async function api(
    runtime: DeployRuntime, config: DeployTaskConfig, path: string,
    payload: Record<string, unknown> | null, method: 'GET' | 'POST' = 'POST',
  ): Promise<Record<string, unknown>> {
    const base = panelBaseUrl(config);
    const url = `${base}/api${path}`;
    const body = method === 'GET' ? '' : JSON.stringify(payload ?? {});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonicalRequest = [method, `/api${path}`, '', await sha256Hex(body)].join('\n');
    const stringToSign = ['HMAC-SHA256', timestamp, await sha256Hex(canonicalRequest)].join('\n');
    const signature = await hmacSha256Hex(requireField(config, 'token', '访问令牌'), stringToSign);
    const text = await deployRequest(runtime, url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Timestamp': timestamp,
        Authorization: `HMAC-SHA256 Credential=${requireField(config, 'id', '用户名')}, Signature=${signature}`,
      },
      body: method === 'GET' ? undefined : body,
    }, '面板');
    return parseJsonObject(text, '面板');
  }

  function ensureSuccess(body: Record<string, unknown>, fallback: string): void {
    if (body.msg === 'success') return;
    throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : fallback);
  }

  return {
    meta: deployMeta(type),

    async check(config, runtime) {
      ensureSuccess(await api(runtime, config, '/user/info', null, 'GET'), '面板地址无法连接');
    },

    async deploy(taskConfig, config, material, runtime) {
      if (taskConfig.type === '1') {
        ensureSuccess(await api(runtime, config, '/setting/cert', {
          cert: material.fullchain, key: material.privateKey,
        }), '面板证书部署失败');
        runtime.log('面板证书部署成功');
        return;
      }
      let success = 0;
      let lastError = '';
      for (const site of splitList(taskConfig.sites)) {
        try {
          ensureSuccess(await api(runtime, config, '/website/cert', {
            name: site, cert: material.fullchain, key: material.privateKey,
          }), `网站 ${site} 证书部署失败`);
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
}
