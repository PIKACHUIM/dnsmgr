import { deployMeta } from '../metadata';
import { deployRaw, formBody, joinUrl, readSetCookies } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

interface PanelResponse {
  status: number;
  body: string;
  location: string;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#0?39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按 name / id 抓取隐藏域里的表单令牌，兼容属性顺序颠倒的写法。 */
function extractValue(html: string, name: string, byId = false): string {
  const attr = byId ? 'id' : 'name';
  const quoted = escapeRegExp(name);
  const patterns = [
    new RegExp(`${attr}="${quoted}"[^>]*value="([^"]*)"`, 'i'),
    new RegExp(`value="([^"]*)"[^>]*${attr}="${quoted}"`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return decodeEntities(match[1] ?? '');
  }
  return '';
}

function parseAlerts(html: string): string[] {
  const messages: string[] = [];
  const pattern = /class="alert alert-(?:danger|warning|success)"[^>]*>([\s\S]*?)<\/div>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const text = decodeEntities((match[1] ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) messages.push(text);
  }
  return messages;
}

function pathOf(url: string): string {
  if (!url) return '';
  try { return new URL(url).pathname || '/'; } catch { return ''; }
}

function createSession(runtime: DeployRuntime, base: string) {
  const cookies = new Map<string, string>();
  async function request(
    path: string, init: { method: 'GET' | 'POST'; body?: string; referer?: string } = { method: 'GET' },
  ): Promise<PanelResponse> {
    const url = /^https?:\/\//i.test(path) ? path : joinUrl(base, path);
    const headers: Record<string, string> = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer: init.referer ?? `${base}/`,
    };
    if (init.method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers.origin = base;
    }
    if (cookies.size > 0) {
      headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const response = await deployRaw(runtime, url, {
      method: init.method, headers, body: init.body, redirect: 'manual', timeoutMs: 15_000,
    }, 'CloudPanel');
    for (const pair of readSetCookies(response)) {
      const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const location = response.headers.get('location') ?? '';
    return { status: response.status, body: await response.text(), location: location ? absoluteUrl(base, location) : '' };
  }
  return { request, hasSession: () => cookies.size > 0 };
}

function absoluteUrl(base: string, location: string): string {
  if (!location) return '';
  if (/^https?:\/\//i.test(location)) return location;
  return location.startsWith('/') ? `${base}${location}` : `${base}/${location.replace(/^\/+/, '')}`;
}

function isLoginPage(body: string, location: string): boolean {
  if (pathOf(location) === '/login') return true;
  return body.includes('name="userName"') && body.includes('action="/login"');
}

function isTwoFactorLocation(location: string): boolean {
  const path = pathOf(location).toLowerCase();
  return path.includes('2fa') || path.includes('two-factor') || path.includes('totp');
}

function accountCredentials(config: DeployTaskConfig): { base: string; username: string; password: string } {
  const raw = requireField(config, 'url', '面板地址').replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('CloudPanel 面板地址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('CloudPanel 面板地址格式无效');
  return {
    base: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`,
    username: requireField(config, 'username', '登录用户名'),
    password: requireField(config, 'password', '登录密码'),
  };
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig) {
  const { base, username, password } = accountCredentials(config);
  const session = createSession(runtime, base);
  const page = await session.request('/login');
  if (page.status !== 200) throw new Error(`打开 CloudPanel 登录页失败(httpCode=${page.status})`);
  const csrf = extractValue(page.body, '_csrf_token');
  if (!csrf) throw new Error('获取登录 CSRF 令牌失败');
  const response = await session.request('/login', {
    method: 'POST',
    body: formBody({ userName: username, password, _csrf_token: csrf }),
    referer: `${base}/login`,
  });
  if (isTwoFactorLocation(response.location) || /two-factor|authenticator|one-time password/i.test(response.body)) {
    throw new Error('当前 CloudPanel 账户启用了双因素认证，暂不支持');
  }
  if (response.status >= 300 && response.status < 400) {
    if (!session.hasSession()) throw new Error('CloudPanel 登录失败：未获取到登录会话');
    const home = await session.request(pathOf(response.location) || '/');
    if (isLoginPage(home.body, home.location)) throw new Error('CloudPanel 登录失败，请检查用户名和密码');
    return { base, request: session.request };
  }
  const alerts = parseAlerts(response.body);
  if (alerts.length > 0) throw new Error(`CloudPanel 登录失败：${alerts[0]}`);
  if (isLoginPage(response.body, response.location)) throw new Error('CloudPanel 登录失败，请检查用户名和密码');
  throw new Error(`CloudPanel 登录失败(httpCode=${response.status})`);
}

async function deploySite(
  runtime: DeployRuntime, session: Awaited<ReturnType<typeof login>>, domain: string,
  material: { fullchain: string; privateKey: string },
): Promise<void> {
  const path = `/site/${encodeURIComponent(domain)}/certificate/import`;
  const page = await session.request(path);
  if (isLoginPage(page.body, page.location)) throw new Error('打开证书导入页失败，站点不存在或登录已失效');
  if (page.status !== 200) throw new Error(`打开证书导入页失败(httpCode=${page.status})`);
  const token = extractValue(page.body, 'site_import_certificate[_token]')
    || extractValue(page.body, 'site_import_certificate__token', true);
  if (!token) throw new Error('获取证书导入表单令牌失败');

  const body = formBody({
    'site_import_certificate[privateKey]': material.privateKey,
    'site_import_certificate[certificate]': material.fullchain,
    'site_import_certificate[certificateChain]': '',
    'site_import_certificate[submit]': 'Import and Install',
    'site_import_certificate[_token]': token,
  });
  const response = await session.request(path, {
    method: 'POST', body, referer: `${session.base}${path}`,
  });
  if (response.status >= 300 && response.status < 400) {
    if (isLoginPage('', response.location)) throw new Error('登录已失效，证书导入未完成');
    if (response.location.includes('/certificates') || response.location.includes(`/site/${domain}`)) return;
  }
  const alerts = parseAlerts(response.body);
  if (alerts.length > 0) throw new Error(alerts.join('；'));
  if (response.status === 200 && response.body.includes('site_import_certificate')) {
    throw new Error('证书导入失败，请检查证书与私钥是否匹配');
  }
  if (response.status >= 500) {
    throw new Error(`证书导入失败，面板返回 ${response.status}，请确认证书格式后在 CloudPanel 后台手动导入排查`);
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`证书导入失败(httpCode=${response.status})`);
}

export const cloudpanel: DeployProvider = {
  meta: deployMeta('cloudpanel'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    accountCredentials(config);
    if (!material.fullchain.trim() || !material.privateKey.trim()) throw new Error('SSL 证书或私钥内容不能为空');
    const targets = splitList(taskConfig.sites);
    if (targets.length === 0) throw new Error('没有设置要部署的网站域名');
    const session = await login(runtime, config);
    let success = 0;
    let lastError = '';
    for (const domain of targets) {
      try {
        await deploySite(runtime, session, domain, material);
        runtime.log(`网站 ${domain} 证书部署成功`);
        success += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : '部署失败';
        runtime.log(`网站 ${domain} 证书部署失败：${lastError}`);
      }
    }
    if (success === 0) throw new Error(lastError || '要部署的网站不存在');
  },
};
