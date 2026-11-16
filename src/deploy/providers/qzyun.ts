import { deployMeta } from '../metadata';
import { deployRaw, formBody, readSetCookies } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const BASE_URL = 'https://panel.qzyun.cn';
const ROUTER_STATE_TREE = '%5B%22%22%2C%7B%22children%22%3A%5B%22(app)%22%2C%7B%22children%22%3A%5B%22(product)%22%2C%7B%22children%22%3A%5B%22certificate%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D';

interface ActionResult {
  success?: boolean;
  error?: unknown;
  message?: unknown;
}

interface Session {
  runtime: DeployRuntime;
  cookie: string;
  actions: Map<string, string>;
}

function isDocumentId(value: string): boolean {
  return /^[a-z0-9]{24}$/i.test(value);
}

async function request(
  session: Session, path: string, options: {
    method?: 'GET' | 'POST'; form?: Record<string, string>; multipart?: Record<string, string>;
    headers?: Record<string, string>; timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: string; location: string }> {
  const absolute = /^https?:\/\//i.test(path);
  const url = absolute ? path : `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    referer: absolute ? `${BASE_URL}/` : `${BASE_URL}${path}`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36',
    ...options.headers,
  };
  if (session.cookie) headers.cookie = session.cookie;
  let body: string | FormData | undefined;
  if (options.multipart) {
    const form = new FormData();
    for (const [name, value] of Object.entries(options.multipart)) form.append(name, value);
    body = form;
  } else if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = formBody(options.form);
  }
  const response = await deployRaw(session.runtime, url, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
    redirect: 'manual',
    timeoutMs: options.timeoutMs ?? 15_000,
  }, '全栈云');
  const cookies = readSetCookies(response);
  if (cookies.length > 0) {
    const map = new Map<string, string>();
    for (const pair of session.cookie.split('; ')) {
      const index = pair.indexOf('=');
      if (index > 0) map.set(pair.slice(0, index), pair.slice(index + 1));
    }
    for (const pair of cookies) {
      const index = pair.indexOf('=');
      if (index > 0) map.set(pair.slice(0, index), pair.slice(index + 1));
    }
    session.cookie = [...map].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const location = response.headers.get('location') ?? '';
  return {
    status: response.status,
    body: await response.text(),
    location: /^https?:\/\//i.test(location) ? location : location ? `${BASE_URL}${location.startsWith('/') ? '' : '/'}${location}` : '',
  };
}

function extractJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** 把 Next.js RSC 的流式片段拼回一段可检索的 JSON 文本。 */
function extractRsc(html: string): string {
  const pattern = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
  let result = '';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    let payload: unknown;
    try { payload = JSON.parse(match[1]!); } catch { continue; }
    if (Array.isArray(payload) && payload[0] === 1 && typeof payload[1] === 'string') result += payload[1];
  }
  return result;
}

function findFromRsc(
  html: string, needle: string, accept: (value: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const rsc = extractRsc(html);
  const found: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const position = rsc.indexOf(needle, offset);
    if (position < 0) break;
    const start = rsc.lastIndexOf('{"id":', position);
    if (start >= 0) {
      const object = extractJsonObject(rsc, start);
      if (object) {
        try {
          const parsed = JSON.parse(object) as Record<string, unknown>;
          if (accept(parsed)) found.push(parsed);
        } catch { /* 片段不完整时跳过 */ }
      }
    }
    offset = position + needle.length;
  }
  return found;
}

function parseActionResult(body: string): ActionResult | null {
  const matches = [...body.matchAll(/(?:^|\n)[a-z0-9]+:(\{[^\r\n]*\})/gi)].map((match) => match[1]!);
  for (const json of matches.reverse()) {
    try {
      const parsed = JSON.parse(json) as ActionResult;
      if (parsed && typeof parsed === 'object'
        && ('success' in parsed || 'error' in parsed || 'message' in parsed)) return parsed;
    } catch { /* 忽略非 JSON 行 */ }
  }
  return null;
}

function sameOriginUrl(src: string): string | null {
  if (src.startsWith('/')) return `${BASE_URL}${src}`;
  try { return new URL(src).host === new URL(BASE_URL).host ? src : null; } catch { return null; }
}

async function findAction(session: Session, html: string, actionName: string): Promise<string> {
  const cached = session.actions.get(actionName);
  if (cached) return cached;
  const sources = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map((match) => match[1]!.replaceAll('&amp;', '&'));
  const pattern = new RegExp(`createServerReference\\)\\("([a-f0-9]{32,64})"[\\s\\S]{0,300},"${actionName}"\\)`);
  for (const src of new Set(sources)) {
    const url = sameOriginUrl(src);
    if (!url) continue;
    const response = await request(session, url);
    if (response.status !== 200) continue;
    const match = pattern.exec(response.body);
    if (match) {
      session.actions.set(actionName, match[1]!);
      return match[1]!;
    }
  }
  throw new Error(`无法识别全栈云接口动作：${actionName}，可能是全栈云前端已更新`);
}

async function postAction(
  session: Session, path: string, actionId: string, fields: Record<string, string>,
): Promise<{ status: number; body: string; location: string }> {
  return request(session, path, {
    method: 'POST',
    multipart: fields,
    headers: {
      accept: 'text/x-component',
      'next-action': actionId,
      'next-router-state-tree': ROUTER_STATE_TREE,
    },
    timeoutMs: 30_000,
  });
}

async function login(session: Session, config: DeployTaskConfig): Promise<void> {
  const email = requireField(config, 'email', '登录邮箱');
  const password = requireField(config, 'password', '密码');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('全栈云登录邮箱格式不正确');
  const page = await request(session, '/login');
  if (page.status !== 200) throw new Error(`打开全栈云登录页失败(httpCode=${page.status})`);
  const actionId = await findAction(session, page.body, 'login');
  const response = await postAction(session, '/login', actionId, {
    '1_email': email,
    '1_password': password,
    '0': '[{"error":null,"success":false},"$K1"]',
  });
  if (response.status >= 300 && response.status < 400) {
    if (!session.cookie) throw new Error('全栈云登录失败：重定向响应未返回登录会话');
    return;
  }
  const result = parseActionResult(response.body);
  if (response.status !== 200 || (result && result.success === false)) {
    const message = result?.error ?? result?.message ?? `请求失败(httpCode=${response.status})`;
    throw new Error(`全栈云登录失败：${String(message)}`);
  }
  if (!session.cookie) throw new Error('全栈云登录失败：未获取到登录会话');
}

function findCertificateDocumentId(html: string, name: string): string {
  const matches = findFromRsc(html, `"name":${JSON.stringify(name)}`, (value) =>
    value.name === name && 'startTime' in value && 'privateKey' in value && 'content' in value && 'documentId' in value);
  const ids = [...new Set(matches.map((value) => String(value.documentId)))];
  if (ids.length === 1) return ids[0]!;
  if (ids.length > 1) throw new Error('全栈云中存在多张同名证书，请改为填写证书文档ID');
  throw new Error(`全栈云中未找到证书“${name}”`);
}

function findCertificateNameByDocumentId(html: string, documentId: string): string {
  const matches = findFromRsc(html, `"documentId":${JSON.stringify(documentId)}`, (value) =>
    'name' in value && 'content' in value);
  if (matches[0]) return String(matches[0].name);
  throw new Error('全栈云中未找到证书名称');
}

function findDomainInfo(html: string, domain: string): { id: unknown; documentId: unknown } | null {
  const matches = findFromRsc(html, `"domain":${JSON.stringify(domain)}`, (value) =>
    value.domain === domain && 'id' in value && 'documentId' in value);
  const match = matches[0];
  return match ? { id: match.id, documentId: match.documentId } : null;
}

function isCertificateBound(html: string, documentId: string, domain: string): boolean {
  const matches = findFromRsc(html, `"documentId":${JSON.stringify(documentId)}`, (value) => Array.isArray(value.cdnDomains));
  return matches.some((value) => (value.cdnDomains as Record<string, unknown>[])
    .some((entry) => entry && typeof entry === 'object' && entry.domain === domain));
}

async function addCertificate(
  session: Session, page: string, name: string, material: { fullchain: string; privateKey: string },
): Promise<string> {
  const actionId = await findAction(session, page, 'addCertificateAction');
  const response = await postAction(session, '/certificate', actionId, {
    '1_certificateName': name,
    '1_serverCertificate': material.fullchain,
    '1_privateKey': material.privateKey,
    '0': '[{"success":false,"message":""},"$K1"]',
  });
  const result = parseActionResult(response.body);
  if (response.status !== 200 || !result || result.success !== true) {
    const message = result?.message ?? `请求失败(httpCode=${response.status})`;
    throw new Error(`全栈云证书添加失败：${String(message)}`);
  }
  const refreshed = await request(session, '/certificate');
  const documentId = findCertificateDocumentId(refreshed.body, name);
  session.runtime.log(`全栈云证书添加成功，文档ID：${documentId}`);
  return documentId;
}

async function bindDomain(
  session: Session, domain: string, documentId: string, certificate: string,
  material: { fullchain: string; privateKey: string },
): Promise<void> {
  const domainPage = await request(session, `/cdn/domain/${encodeURIComponent(domain)}`);
  if (domainPage.status !== 200) throw new Error(`获取全栈云域名信息失败(httpCode=${domainPage.status})`);
  const info = findDomainInfo(domainPage.body, domain);
  if (!info) throw new Error(`全栈云中未找到域名“${domain}”`);

  const certificatePage = await request(session, '/certificate');
  if (isCertificateBound(certificatePage.body, documentId, domain)) {
    session.runtime.log(`全栈云证书已绑定域名，跳过：${domain}`);
    return;
  }
  const actionId = await findAction(session, certificatePage.body, 'bindDomainCdnServer');
  const certificateName = isDocumentId(certificate)
    ? findCertificateNameByDocumentId(certificatePage.body, documentId) : certificate;
  const response = await postAction(session, '/certificate', actionId, {
    '1_domainName': domain,
    '1_Id': String(info.id),
    '1_documentId': String(info.documentId),
    '1_CertificateName': certificateName,
    '1_ServerCertificate': material.fullchain,
    '1_CertificateDocumentId': documentId,
    '1_PrivateKey': material.privateKey,
    '0': '[{"success":false,"message":""},"$K1"]',
  });
  const result = parseActionResult(response.body);
  if (response.status !== 200 || !result || result.success !== true) {
    const message = result?.message ?? `请求失败(httpCode=${response.status})`;
    throw new Error(`全栈云证书绑定域名失败：${String(message)}`);
  }
  session.runtime.log(`全栈云证书已绑定域名：${domain}`);
}

export const qzyun: DeployProvider = {
  meta: deployMeta('qzyun'),

  async check(config, runtime) {
    const session: Session = { runtime, cookie: '', actions: new Map() };
    await login(session, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    const session: Session = { runtime, cookie: '', actions: new Map() };
    const certificate = requireField(taskConfig, 'certificate', '证书名称或文档ID');
    const domain = typeof taskConfig.domain === 'string' ? taskConfig.domain.trim() : '';
    if (!material.fullchain.trim() || !material.privateKey.trim()) throw new Error('证书或私钥内容为空');

    await login(session, config);
    const page = await request(session, '/certificate');
    if (page.status !== 200) throw new Error(`获取全栈云证书列表失败(httpCode=${page.status})`);

    let documentId: string;
    let added = false;
    if (isDocumentId(certificate)) {
      documentId = certificate;
    } else {
      try {
        documentId = findCertificateDocumentId(page.body, certificate);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('未找到证书'))) throw error;
        documentId = await addCertificate(session, page.body, certificate, material);
        added = true;
      }
    }

    if (!added) {
      const actionId = await findAction(session, page.body, 'updateCertificateAction');
      const response = await postAction(session, '/certificate', actionId, {
        '1_certDocumentId': documentId,
        '1_serverCertificate': material.fullchain,
        '1_privateKey': material.privateKey,
        '0': '[{"success":false,"message":""},"$K1"]',
      });
      const result = parseActionResult(response.body);
      if (response.status !== 200 || !result || result.success !== true) {
        const message = result?.message ?? `请求失败(httpCode=${response.status})`;
        throw new Error(`全栈云证书更新失败：${String(message)}`);
      }
    }

    if (domain) await bindDomain(session, domain, documentId, certificate, material);

    runtime.saveConfig({ certificate: documentId });
    runtime.log(`全栈云证书处理成功，文档ID：${documentId}`);
  },
};
