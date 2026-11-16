import { deployMeta } from '../metadata';
import { basicAuth, deployRaw, formBody, joinUrl } from '../http';
import {
  requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig,
} from '../types';

/** DirectAdmin 地址必须是纯 HTTPS 源：不带路径、凭据、查询或片段。 */
function panelUrl(config: DeployTaskConfig): string {
  const raw = requireField(config, 'url', '面板地址').replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('DirectAdmin 面板地址格式无效，必须为不带路径、凭据、查询或片段的 HTTPS 地址'); }
  const path = url.pathname === '' || url.pathname === '/' ? '' : url.pathname;
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || path) {
    throw new Error('DirectAdmin 面板地址格式无效，必须为不带路径、凭据、查询或片段的 HTTPS 地址');
  }
  return `https://${url.host}`;
}

const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

function parseDomains(value: string | undefined): string[] {
  const seen = new Set<string>();
  for (const item of splitList(value)) {
    const domain = item.toLowerCase();
    if (!HOSTNAME.test(domain)) throw new Error(`DirectAdmin 域名格式不正确：${domain}`);
    seen.add(domain);
  }
  return [...seen];
}

function parseResponse(status: number, text: string): Record<string, unknown> {
  if (status === 401 || status === 403) throw new Error('DirectAdmin 认证失败，请检查用户名和认证密码');
  if (status < 200 || status >= 300) throw new Error(`DirectAdmin 请求失败（HTTP ${status}）`);
  const trimmed = text.trim();
  if (!trimmed) throw new Error('DirectAdmin 响应格式异常：响应内容为空');
  let data: Record<string, unknown>;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('DirectAdmin 响应格式异常：JSON 无法解析'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('DirectAdmin 响应格式异常：JSON 无法解析');
    data = parsed as Record<string, unknown>;
  } else {
    data = {};
    for (const [key, value] of new URLSearchParams(trimmed)) data[key] = value;
  }
  if (!('error' in data)) throw new Error('DirectAdmin 响应格式异常：缺少 error 状态字段');
  const error = data.error;
  if (String(error) !== '0' && error !== false) {
    const detail = String(data.details ?? data.text ?? '').trim();
    throw new Error(detail || 'DirectAdmin 返回未知错误');
  }
  return data;
}

interface DerElement {
  tag: number;
  /** 元素内容（不含 tag 与长度字段）。 */
  value: Uint8Array;
  /** 元素起始偏移，便于取回完整原始字节。 */
  start: number;
  end: number;
}

function readElement(der: Uint8Array, offset: number): DerElement {
  if (offset + 2 > der.length) throw new Error('ASN.1 数据不完整');
  const start = offset;
  const tag = der[offset++]!;
  const first = der[offset++]!;
  let length: number;
  if ((first & 0x80) === 0) {
    length = first;
  } else {
    const bytes = first & 0x7f;
    if (bytes < 1 || bytes > 4 || offset + bytes > der.length) throw new Error('ASN.1 长度字段无效');
    length = 0;
    for (let i = 0; i < bytes; i++) length = length * 256 + der[offset++]!;
  }
  if (offset + length > der.length) throw new Error('ASN.1 内容长度越界');
  return { tag, value: der.subarray(offset, offset + length), start, end: offset + length };
}

function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) { bytes.unshift(rest & 0xff); rest = Math.floor(rest / 256); }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

const OID_EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];

function equals(a: Uint8Array, b: number[]): boolean {
  return a.length === b.length && b.every((byte, index) => a[index] === byte);
}

/**
 * DirectAdmin 只认 SEC1（EC PRIVATE KEY）格式，PKCS#8 的 ECC 私钥需要重新包装：
 * 取出 SEC1 结构后补上 PKCS#8 里携带的曲线参数。
 */
function toSec1(key: string): string {
  let der: Uint8Array;
  try {
    const body = key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
    const binary = atob(body);
    der = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error('ECC PKCS#8 私钥 Base64 内容无效');
  }
  const outer = readElement(der, 0);
  if (outer.tag !== 0x30 || outer.end !== der.length) throw new Error('PKCS#8 外层结构无效');
  let offset = 0;
  const version = readElement(outer.value, offset);
  offset = version.end;
  const algorithm = readElement(outer.value, offset);
  offset = algorithm.end;
  const keyElement = readElement(outer.value, offset);
  if (version.tag !== 0x02 || algorithm.tag !== 0x30 || keyElement.tag !== 0x04 || keyElement.value.length === 0) {
    throw new Error('PKCS#8 ECC 私钥结构无效');
  }
  let algorithmOffset = 0;
  const algorithmOid = readElement(algorithm.value, algorithmOffset);
  algorithmOffset = algorithmOid.end;
  const curveStart = algorithmOffset;
  const curveOid = readElement(algorithm.value, algorithmOffset);
  const curve = algorithm.value.subarray(curveStart, curveOid.end);
  if (algorithmOid.tag !== 0x06 || curveOid.tag !== 0x06 || curve.length === 0) {
    throw new Error('PKCS#8 ECC 曲线参数缺失');
  }
  const sec1 = keyElement.value;
  const sec1Outer = readElement(sec1, 0);
  if (sec1Outer.tag !== 0x30 || sec1Outer.end !== sec1.length) throw new Error('SEC1 ECC 私钥结构无效');
  let contentOffset = 0;
  const sec1Version = readElement(sec1Outer.value, contentOffset);
  contentOffset = sec1Version.end;
  const privateOctet = readElement(sec1Outer.value, contentOffset);
  contentOffset = privateOctet.end;
  if (sec1Version.tag !== 0x02 || privateOctet.tag !== 0x04) throw new Error('SEC1 ECC 私钥字段无效');
  const remaining = sec1Outer.value.subarray(contentOffset);
  let rebuilt: Uint8Array;
  if (remaining.length > 0 && remaining[0] === 0xa0) {
    rebuilt = sec1;
  } else {
    const parameters = new Uint8Array(1 + encodeLength(curve.length).length + curve.length);
    parameters[0] = 0xa0;
    parameters.set(encodeLength(curve.length), 1);
    parameters.set(curve, 1 + encodeLength(curve.length).length);
    const content = new Uint8Array(privateOctet.end + parameters.length + remaining.length);
    let cursor = 0;
    content.set(sec1Outer.value.subarray(0, sec1Version.end), cursor); cursor += sec1Version.end;
    content.set(sec1Outer.value.subarray(sec1Version.end, privateOctet.end), cursor);
    cursor += privateOctet.end - sec1Version.end;
    content.set(parameters, cursor); cursor += parameters.length;
    content.set(remaining, cursor);
    const prefix = new Uint8Array(1 + encodeLength(content.length).length);
    prefix[0] = 0x30;
    prefix.set(encodeLength(content.length), 1);
    rebuilt = new Uint8Array(prefix.length + content.length);
    rebuilt.set(prefix);
    rebuilt.set(content, prefix.length);
  }
  const base64 = btoa(String.fromCharCode(...rebuilt));
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN EC PRIVATE KEY-----\n${lines.join('\n')}\n-----END EC PRIVATE KEY-----\n`;
}

function normalizePrivateKey(privateKey: string): string {
  if (!privateKey.trimStart().startsWith('-----BEGIN PRIVATE KEY-----')) return privateKey;
  let der: Uint8Array;
  try {
    const binary = atob(privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, ''));
    der = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error('SSL 私钥格式无效');
  }
  let offset = 0;
  let algorithm: Uint8Array;
  try {
    const outer = readElement(der, 0);
    if (outer.tag !== 0x30) throw new Error('bad');
    const version = readElement(outer.value, 0);
    const algorithmElement = readElement(outer.value, version.end);
    if (version.tag !== 0x02 || algorithmElement.tag !== 0x30) throw new Error('bad');
    algorithm = algorithmElement.value;
  } catch {
    throw new Error('SSL 私钥格式无效');
  }
  const oid = readElement(algorithm, 0);
  if (oid.tag !== 0x06 || !equals(oid.value, OID_EC_PUBLIC_KEY)) return privateKey;
  try {
    return toSec1(privateKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知错误';
    throw new Error(`ECC 私钥转换为 DirectAdmin 兼容格式失败：${reason}`);
  }
}

async function request(
  runtime: DeployRuntime, config: DeployTaskConfig, method: 'GET' | 'POST', path: string,
  form?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const base = panelUrl(config);
  const headers: Record<string, string> = {
    accept: 'application/x-www-form-urlencoded, application/json',
    authorization: basicAuth(requireField(config, 'username', '用户名'), requireField(config, 'password', '认证密码')),
  };
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = await deployRaw(runtime, joinUrl(base, path), {
    method, headers, body: form ? formBody(form) : undefined, redirect: 'manual',
  }, 'DirectAdmin');
  const text = await response.text();
  return parseResponse(response.status, text);
}

export const directadmin: DeployProvider = {
  meta: deployMeta('directadmin'),

  async check(config, runtime) {
    panelUrl(config);
    requireField(config, 'username', '用户名');
    requireField(config, 'password', '认证密码');
    await request(runtime, config, 'GET', '/CMD_API_LOGIN_TEST');
  },

  async deploy(taskConfig, config, material, runtime) {
    const domains = parseDomains(taskConfig.domain);
    if (domains.length === 0) throw new Error('没有设置要部署的 DirectAdmin 域名');
    if (!material.fullchain.trim() || !material.privateKey.trim()) throw new Error('SSL 证书或私钥内容不能为空');
    const certificate = `${normalizePrivateKey(material.privateKey).trimEnd()}\n${material.fullchain.trimStart()}`;
    for (const domain of domains) {
      await request(runtime, config, 'POST', '/CMD_API_SSL', {
        domain, action: 'save', type: 'paste', certificate,
      });
      runtime.log(`DirectAdmin 域名 ${domain} 证书部署成功`);
    }
  },
};
