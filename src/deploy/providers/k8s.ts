import { deployMeta } from '../metadata';
import { deployRaw, joinUrl, parseJsonObject } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

interface YamlLine {
  indent: number;
  text: string;
}

/** 去掉行尾注释；引号内的 # 保留。 */
function stripComment(line: string): string {
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === quote && line[index - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index);
  }
  return line;
}

function splitKey(text: string): [string, string] | null {
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote && text[index - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ':' && (index + 1 === text.length || /\s/.test(text[index + 1]!))) {
      return [unquote(text.slice(0, index).trim()), text.slice(index + 1).trim()];
    }
  }
  return null;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/**
 * kubeconfig 只需要 YAML 的一小部分：块映射、块序列、引号标量与块标量。
 * 手写解析器比引入完整 YAML 依赖更可控，也避免把执行环境绑到 Node API。
 */
export function parseKubeconfigYaml(source: string): Record<string, unknown> {
  const lines: YamlLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, text: stripComment(raw.trim()) });
  }
  let index = 0;

  function parseBlock(indent: number): unknown {
    const first = lines[index];
    if (!first) return null;
    if (first.text.startsWith('-')) return parseSequence(indent);
    return parseMapping(indent);
  }

  function parseSequence(indent: number): unknown[] {
    const items: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent !== indent || !line.text.startsWith('-')) break;
      const rest = line.text.slice(1).trim();
      if (rest === '') {
        index += 1;
        const next = lines[index];
        items.push(next && next.indent > indent ? parseBlock(next.indent) : null);
        continue;
      }
      line.indent = indent + 2;
      line.text = rest;
      items.push(parseBlock(indent + 2));
    }
    return items;
  }

  function parseMapping(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent !== indent || line.text.startsWith('-')) break;
      const pair = splitKey(line.text);
      index += 1;
      if (!pair) continue;
      const [key, rawValue] = pair;
      if (rawValue === '') {
        const next = lines[index];
        // kubectl 生成的 kubeconfig 把序列顶格写在键下方，因此同级 `-` 也算嵌套。
        const nested = next && (next.indent > indent || (next.indent === indent && next.text.startsWith('-')));
        result[key] = nested && next ? parseBlock(next.indent) : null;
        continue;
      }
      if (/^[|>][+-]?$/.test(rawValue)) {
        const folded = rawValue.startsWith('>');
        const collected: string[] = [];
        while (index < lines.length && lines[index]!.indent > indent) {
          collected.push(lines[index]!.text);
          index += 1;
        }
        result[key] = collected.join(folded ? ' ' : '\n');
        continue;
      }
      if (rawValue === '{}') { result[key] = {}; continue; }
      if (rawValue === '[]') { result[key] = []; continue; }
      result[key] = unquote(rawValue);
    }
    return result;
  }

  const parsed = parseBlock(lines[0]?.indent ?? 0);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

interface KubeClient {
  server: string;
  token: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function indexByName(value: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of asArray(value)) {
    const name = item.name;
    if (typeof name === 'string') map.set(name, item);
  }
  return map;
}

function parseClient(kubeconfig: string): KubeClient {
  let document: Record<string, unknown>;
  try { document = parseKubeconfigYaml(kubeconfig); } catch { throw new Error('Kubeconfig格式错误'); }
  if (!document || Object.keys(document).length === 0) throw new Error('Kubeconfig格式错误');
  const current = document['current-context'];
  if (typeof current !== 'string' || !current) throw new Error('Kubeconfig缺少current-context');
  const context = indexByName(document.contexts).get(current);
  if (!context) throw new Error(`Kubeconfig中找不到current-context: ${current}`);
  const contextBody = asRecord(context.context);
  const clusterName = contextBody.cluster;
  const userName = contextBody.user;
  if (typeof clusterName !== 'string' || typeof userName !== 'string') {
    throw new Error(`Kubeconfig中context缺少cluster或user: ${current}`);
  }
  const cluster = indexByName(document.clusters).get(clusterName);
  const user = indexByName(document.users).get(userName);
  if (!cluster) throw new Error(`Kubeconfig中找不到cluster: ${clusterName}`);
  if (!user) throw new Error(`Kubeconfig中找不到user: ${userName}`);
  const server = asRecord(cluster.cluster).server;
  if (typeof server !== 'string' || !server) throw new Error('Kubeconfig中找不到cluster.server');

  const userBody = asRecord(user.user);
  if (userBody['client-certificate-data'] || userBody['client-certificate']) {
    throw new Error('Kubeconfig使用客户端证书认证，当前部署环境无法携带客户端证书，请改用 token 认证的 kubeconfig');
  }
  const provider = asRecord(asRecord(userBody['auth-provider']).config);
  const token = userBody.token ?? provider['access-token'];
  if (typeof token !== 'string' || !token) {
    throw new Error('Kubeconfig中找不到可用凭据，请使用 token 认证的 kubeconfig');
  }
  return { server: server.replace(/\/+$/, ''), token };
}

async function request(
  runtime: DeployRuntime, client: KubeClient, method: string, path: string, body?: string,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${client.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await deployRaw(runtime, joinUrl(client.server, path), {
    method, headers, body, timeoutMs: 30_000,
  }, 'Kubernetes API');
  return { status: response.status, text: await response.text() };
}

function failure(action: string, response: { status: number; text: string }): Error {
  const detail = response.text.trim().slice(0, 300);
  return new Error(`${action}失败 (HTTP ${response.status})${detail ? `：${detail}` : ''}`);
}

export const k8s: DeployProvider = {
  meta: deployMeta('k8s'),

  async check(config, runtime) {
    const kubeconfig = requireField(config, 'kubeconfig', 'Kubeconfig');
    const client = parseClient(kubeconfig);
    const response = await request(runtime, client, 'GET', '/version');
    if (response.status !== 200) throw failure('连接Kubernetes API服务器', response);
  },

  async deploy(taskConfig, config, material, runtime) {
    const namespace = requireField(taskConfig, 'namespace', '命名空间');
    const secretName = requireField(taskConfig, 'secret_name', 'Secret名称');
    const client = parseClient(requireField(config, 'kubeconfig', 'Kubeconfig'));

    const secretPayload = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: secretName, namespace },
      type: 'kubernetes.io/tls',
      data: {
        'tls.crt': base64Of(material.fullchain),
        'tls.key': base64Of(material.privateKey),
      },
    };
    const secretPath = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(secretName)}`;
    const existing = await request(runtime, client, 'GET', secretPath);
    if (existing.status === 404) {
      runtime.log(`Secret:${secretName} 不存在，正在创建...`);
      const created = await request(runtime, client, 'POST',
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`, JSON.stringify(secretPayload));
      if (created.status < 200 || created.status >= 300) throw failure('创建Secret', created);
      runtime.log(`Secret:${namespace} 创建成功`);
    } else if (existing.status >= 200 && existing.status < 300) {
      runtime.log(`Secret:${secretName} 已存在，正在更新...`);
      const patched = await request(runtime, client, 'PATCH', secretPath, JSON.stringify({
        data: secretPayload.data, type: 'kubernetes.io/tls',
      }));
      if (patched.status < 200 || patched.status >= 300) throw failure('更新Secret', patched);
      runtime.log(`Secret:${secretName} 更新成功`);
    } else {
      throw failure('获取Secret', existing);
    }

    const ingresses = splitList(taskConfig.ingresses);
    if (ingresses.length === 0) return;
    const ingressBase = `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses`;
    for (const name of ingresses) {
      const response = await request(runtime, client, 'GET', `${ingressBase}/${encodeURIComponent(name)}`);
      if (response.status < 200 || response.status >= 300) throw failure(`获取Ingress '${name}'`, response);
      let ingress: Record<string, unknown>;
      try { ingress = parseJsonObject(response.text, 'Ingress'); } catch { throw new Error(`解析Ingress '${name}' JSON失败`); }
      const spec = asRecord(ingress.spec);
      const hosts = [...new Set(asArray(spec.rules)
        .map((rule) => rule.host)
        .filter((host): host is string => typeof host === 'string' && host !== ''))];
      const tls = asArray(spec.tls).map((entry) => ({ ...entry }));
      const target = tls.find((entry) => entry.secretName === secretName);
      if (target) {
        target.hosts = [...new Set([...(Array.isArray(target.hosts) ? target.hosts : []), ...hosts])];
      } else {
        tls.push({ secretName, hosts });
      }
      const patched = await request(runtime, client, 'PATCH', `${ingressBase}/${encodeURIComponent(name)}`,
        JSON.stringify({ spec: { tls } }));
      if (patched.status < 200 || patched.status >= 300) throw failure(`更新Ingress '${name}'`, patched);
      runtime.log(`Ingress '${name}' 更新TLS成功`);
    }
  },
};

function base64Of(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
