import { md5Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { deployRaw, panelBaseUrl, readSetCookies } from '../http';
import { postHtmlForm } from './kangle-common';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function adminPath(config: DeployTaskConfig): string {
  const raw = typeof config.path === 'string' && config.path.trim() ? config.path.trim() : '/admin';
  return raw.replace(/\/+$/, '');
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const base = panelBaseUrl(config);
  const path = adminPath(config);
  const target = `${base}${path}/index.php?`;
  const response = await deployRaw(runtime, `${base}${path}/index.php?c=sso&a=hello&url=${encodeURIComponent(target)}`, {}, 'Easypanel面板');
  if (response.status !== 302) {
    const body = await response.text();
    throw new Error(`获取SSO凭据失败 (${body.trim().length > 3 && body.trim().length < 50 ? body.trim() : `httpCode=${response.status}`})`);
  }
  const cookies = readSetCookies(response);
  if (cookies.length === 0) throw new Error('获取SSO凭据失败，获取cookie失败');
  const location = response.headers.get('location') ?? '';
  const sessKey = new URL(location, `${base}/`).searchParams.get('r') ?? '';
  if (!sessKey) throw new Error('获取SSO凭据失败，sess_key获取失败');
  const cookie = `${cookies.join('; ')}; `;
  const username = requireField(config, 'username', '管理员用户名');
  const sign = md5Hex(`${sessKey}${username}${sessKey}${requireField(config, 'skey', '面板安全码')}`);
  const second = await deployRaw(runtime, `${base}${path}/index.php?c=sso&a=login&name=${encodeURIComponent(username)}&r=${encodeURIComponent(sessKey)}&s=${sign}`, {
    headers: { cookie },
  }, 'Easypanel面板');
  if (second.status === 302) return cookie;
  const body = await second.text();
  throw new Error(`SSO登录失败 (${body.trim().length > 3 && body.trim().length < 50 ? body.trim() : `httpCode=${second.status}`})`);
}

export const kangleadmin: DeployProvider = {
  meta: deployMeta('kangleadmin'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    const base = panelBaseUrl(config);
    const cookie = await login(runtime, config);
    runtime.log('登录成功');
    if (String(taskConfig.target ?? '') === '1') {
      await postHtmlForm(runtime, `${base}${adminPath(config)}/index.php?c=security&a=ssl`, {
        crt: material.fullchain, key: material.privateKey,
      }, cookie, 'Easypanel面板');
      runtime.log('EasyPanel面板本身的证书部署成功');
      return;
    }
    const name = requireField(taskConfig, 'name', '网站用户名');
    const vhostLogin = await deployRaw(runtime, `${base}${adminPath(config)}/index.php?c=vhost&a=impLogin&name=${encodeURIComponent(name)}`, {
      headers: { cookie },
    }, 'Easypanel面板');
    if (vhostLogin.status !== 302) throw new Error(`用户面板登录失败 (httpCode=${vhostLogin.status})`);
    await deployRaw(runtime, `${base}/vhost/`, { headers: { cookie } }, 'Easypanel面板').then((response) => response.text());

    if (taskConfig.type === '1' && (taskConfig.domains ?? '').trim()) {
      let success = 0;
      let lastError = '';
      for (const domain of splitList(taskConfig.domains)) {
        try {
          await postHtmlForm(runtime, `${base}/vhost/?c=ssl&a=domainSsl`, {
            domain, certificate: material.fullchain, certificate_key: material.privateKey,
          }, cookie, 'Easypanel面板');
          runtime.log(`域名 ${domain} 证书部署成功`);
          success += 1;
        } catch (error) {
          lastError = error instanceof Error ? error.message : '请求失败';
          runtime.log(`域名 ${domain} 证书部署失败：${lastError}`);
        }
      }
      if (success === 0) throw new Error(lastError || '要部署的域名不存在');
      return;
    }
    await postHtmlForm(runtime, `${base}/vhost/?c=ssl&a=ssl`, {
      certificate: material.fullchain, certificate_key: material.privateKey,
    }, cookie, 'Easypanel面板');
    runtime.log('账号级SSL证书部署成功');
  },
};
