import { md5Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { joinUrl, panelBaseUrl, parseJsonObject, postForm } from '../http';
import { requireField, splitList, type DeployMaterial, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function request(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params: Record<string, string>,
): Promise<string> {
  const url = panelBaseUrl(config);
  const key = requireField(config, 'key', '接口密钥');
  const time = String(Math.floor(Date.now() / 1000));
  return postForm(runtime, joinUrl(url, path), {
    request_token: md5Hex(time + md5Hex(key)),
    request_time: time,
    ...params,
  }, {}, '宝塔面板');
}

function result(text: string, fallback: string): Record<string, unknown> {
  try {
    return parseJsonObject(text, '宝塔面板');
  } catch {
    throw new Error(fallback);
  }
}

function ensureSuccess(text: string, fallback: string): void {
  const body = result(text, fallback);
  if (body.status) return;
  throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : fallback);
}

type DeployKind = 'site' | 'panel' | 'mail' | 'docker' | 'proxy';

const KIND_LABEL: Record<Exclude<DeployKind, 'panel'>, string> = {
  site: '网站', mail: '邮局域名', docker: 'Docker 域名', proxy: '反向代理',
};

function taskKind(config: DeployTaskConfig): DeployKind {
  const value = typeof config.type === 'string' ? config.type : '0';
  if (value === '1') return 'panel';
  if (value === '2') return 'mail';
  if (value === '3') return 'docker';
  if (value === '4') return 'proxy';
  return 'site';
}

async function deployOne(
  runtime: DeployRuntime, config: DeployTaskConfig, kind: Exclude<DeployKind, 'panel'>, name: string, material: DeployMaterial,
): Promise<void> {
  const common = { key: material.privateKey, csr: material.fullchain };
  const label = KIND_LABEL[kind];
  if (kind === 'site') {
    ensureSuccess(await request(runtime, config, '/site?action=SetSSL', { type: '0', siteName: name, ...common }),
      `${label} ${name} 证书部署失败`);
    return;
  }
  if (kind === 'mail') {
    ensureSuccess(await request(runtime, config, '/plugin?action=a&name=mail_sys&s=set_mail_certificate_multiple',
      { domain: name, act: 'add', ...common }), `${label} ${name} 证书部署失败`);
    return;
  }
  if (kind === 'docker') {
    ensureSuccess(await request(runtime, config, '/mod/docker/com/set_ssl', { site_name: name, ...common }),
      `${label} ${name} 证书部署失败`);
    return;
  }
  ensureSuccess(await request(runtime, config, '/mod/proxy/com/set_ssl', { site_name: name, ...common }),
    `${label} ${name} 证书部署失败`);
}

export const btpanel: DeployProvider = {
  meta: deployMeta('btpanel'),

  async check(config, runtime) {
    const text = await request(runtime, config, '/config?action=get_config', {});
    const body = result(text, '面板地址无法连接');
    if (body.status === 1 || body.status === true || typeof body.sites_path === 'string') return;
    throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '面板地址无法连接');
  },

  async deploy(taskConfig, config, material, runtime) {
    const kind = taskKind(taskConfig);
    if (kind === 'panel') {
      ensureSuccess(await request(runtime, config, '/config?action=SavePanelSSL', {
        privateKey: material.privateKey, certPem: material.fullchain,
      }), '面板证书部署失败');
      runtime.log('面板证书部署成功');
      return;
    }
    const sites = splitList(taskConfig.sites);
    if (sites.length === 0) throw new Error('要部署的网站不存在');
    let success = 0;
    let lastError = '';
    for (const site of sites) {
      try {
        await deployOne(runtime, config, kind, site, material);
        runtime.log(`${KIND_LABEL[kind]} ${site} 证书部署成功`);
        success += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : '部署失败';
        runtime.log(`${KIND_LABEL[kind]} ${site} 证书部署失败：${lastError}`);
      }
    }
    if (success === 0) throw new Error(lastError || '要部署的网站不存在');
  },
};
