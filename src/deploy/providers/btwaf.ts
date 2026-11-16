import { md5Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { postJson, parseJsonObject, panelBaseUrl, readArray, readString } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig, type DeployMaterial } from '../types';

async function request(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const time = String(Math.floor(Date.now() / 1000));
  const key = requireField(config, 'key', '接口密钥');
  const text = await postJson(runtime, `${panelBaseUrl(config)}${path}`, params, {
    waf_request_time: time,
    waf_request_token: md5Hex(time + md5Hex(key)),
  }, '堡塔云WAF');
  const body = parseJsonObject(text, '堡塔云WAF');
  if (body.code === 0) return body;
  throw new Error(typeof body.res === 'string' && body.res ? body.res : '返回数据解析失败');
}

async function deploySite(
  runtime: DeployRuntime, config: DeployTaskConfig, siteName: string, material: DeployMaterial,
): Promise<void> {
  const list = await request(runtime, config, '/api/wafmastersite/get_site_list', {
    p: 1, p_size: 10, site_name: siteName,
  });
  const res = list.res && typeof list.res === 'object' ? list.res as Record<string, unknown> : {};
  const sites = readArray(res, 'list');
  const site = sites.find((item) => readString(item, 'site_name') === siteName);
  if (!site) throw new Error('网站名称不存在');
  const server = site.server && typeof site.server === 'object' ? site.server as Record<string, unknown> : {};
  const ports = Array.isArray(server.listen_ssl_port) && server.listen_ssl_port.length > 0
    ? server.listen_ssl_port
    : ['443'];
  await request(runtime, config, '/api/wafmastersite/modify_site', {
    types: 'openCert',
    site_id: site.site_id,
    server: {
      listen_ssl_port: ports,
      ssl: { is_ssl: 1, private_key: material.privateKey, full_chain: material.fullchain },
    },
  });
}

export const btwaf: DeployProvider = {
  meta: deployMeta('btwaf'),

  async check(config, runtime) {
    await request(runtime, config, '/api/user/latest_version', {});
  },

  async deploy(taskConfig, config, material, runtime) {
    if (taskConfig.type === '1') {
      await request(runtime, config, '/api/config/set_cert', {
        certContent: material.fullchain, keyContent: material.privateKey,
      });
      runtime.log('面板证书部署成功');
      return;
    }
    let success = 0;
    let lastError = '';
    for (const site of splitList(taskConfig.sites)) {
      try {
        await deploySite(runtime, config, site, material);
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
