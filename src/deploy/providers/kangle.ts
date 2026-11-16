import { md5Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { deployRaw, panelBaseUrl, readSetCookies } from '../http';
import { postHtmlForm } from './kangle-common';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const LABEL = 'Kangle用户面板';

async function loginByPassword(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const base = panelBaseUrl(config);
  const response = await deployRaw(runtime, `${base}/vhost/index.php?c=session&a=login`, {
    method: 'POST',
    headers: {
      referer: `${base}/vhost/index.php?c=session&a=loginForm`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      username: requireField(config, 'username', '网站用户名'),
      passwd: requireField(config, 'password', '网站密码'),
    }).toString(),
  }, LABEL);
  const body = await response.text();
  if (response.status === 302) {
    const cookies = readSetCookies(response);
    if (cookies.length === 0) throw new Error('登录失败，获取cookie失败');
    return `${cookies.join('; ')}; `;
  }
  if (body.includes('验证码错误')) throw new Error('登录失败，需输入验证码');
  if (body.includes('密码错误')) throw new Error('登录失败，用户名或密码错误');
  throw new Error(`登录失败 (httpCode=${response.status})`);
}

async function loginBySkey(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const base = panelBaseUrl(config);
  const response = await deployRaw(runtime, `${base}/vhost/index.php?c=sso&a=hello&url=${encodeURIComponent(`${base}/index.php?`)}`, {}, LABEL);
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
  const username = requireField(config, 'username', '网站用户名');
  const sign = md5Hex(`${sessKey}${username}${sessKey}${requireField(config, 'skey', '面板安全码')}`);
  const second = await deployRaw(
    runtime,
    `${base}/vhost/index.php?c=sso&a=login&name=${encodeURIComponent(username)}&r=${encodeURIComponent(sessKey)}&s=${sign}`,
    { headers: { cookie } },
    LABEL,
  );
  if (second.status === 302) return cookie;
  const body = await second.text();
  throw new Error(`SSO登录失败 (${body.trim().length > 3 && body.trim().length < 50 ? body.trim() : `httpCode=${second.status}`})`);
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  return String(config.auth ?? '0') === '1'
    ? loginBySkey(runtime, config)
    : loginByPassword(runtime, config);
}

export const kangle: DeployProvider = {
  meta: deployMeta('kangle'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    const base = panelBaseUrl(config);
    const cookie = await login(runtime, config);
    runtime.log('登录成功');
    await deployRaw(runtime, `${base}/vhost/`, { headers: { cookie } }, LABEL).then((response) => response.text());

    if (taskConfig.type === '1' && (taskConfig.domains ?? '').trim()) {
      let success = 0;
      let lastError = '';
      for (const domain of splitList(taskConfig.domains)) {
        try {
          await postHtmlForm(runtime, `${base}/vhost/?c=ssl&a=domainSsl`, {
            domain, certificate: material.fullchain, certificate_key: material.privateKey,
          }, cookie, LABEL);
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
    }, cookie, LABEL);
    runtime.log('账号级SSL证书部署成功');
  },
};
