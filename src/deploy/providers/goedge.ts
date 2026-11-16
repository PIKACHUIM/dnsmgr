import { certificateInfo, certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, parseJsonObject, panelBaseUrl, readString } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function token(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}/APIAccessTokenService/getAPIAccessToken`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: config.usertype ?? '',
      accessKeyId: requireField(config, 'accessKeyId', 'AccessKey ID'),
      accessKey: requireField(config, 'accessKey', 'AccessKey'),
    }),
  }, 'GoEdge');
  const body = parseJsonObject(text, 'GoEdge');
  if (body.code !== 200) throw new Error(typeof body.message === 'string' && body.message ? body.message : '登录成功，获取AccessToken失败');
  const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {};
  const value = readString(data, 'token');
  if (!value) throw new Error('登录成功，获取AccessToken失败');
  return value;
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, payload: Record<string, unknown> | undefined,
  accessToken: string,
): Promise<Record<string, unknown> | null> {
  const headerName = String(config.systype ?? '0') === '1' ? 'x-cloud-access-token' : 'x-edge-access-token';
  const text = await deployRequest(runtime, `${panelBaseUrl(config)}${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: { [headerName]: accessToken, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  }, 'GoEdge');
  const body = parseJsonObject(text, 'GoEdge');
  if (body.code === 200) {
    return body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : null;
  }
  throw new Error(typeof body.message === 'string' && body.message ? body.message : '返回数据解析失败');
}

function decodeList(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value));
  } catch {
    throw new Error('证书列表为空');
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

export const goedge: DeployProvider = {
  meta: deployMeta('goedge'),

  async check(config, runtime) {
    await token(runtime, config);
  },

  async deploy(_taskConfig, config, material, runtime) {
    if (material.domains.length === 0) throw new Error('没有设置要部署的域名');
    const accessToken = await token(runtime, config);
    let data: Record<string, unknown> | null;
    try {
      data = await api(runtime, config, '/SSLCertService/listSSLCerts', {
        domains: material.domains, offset: 0, size: 10,
      }, accessToken);
    } catch (error) {
      throw new Error(`获取证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    const list = decodeList(data?.sslCertsJSON);
    runtime.log(`获取证书列表成功(total=${list.length})`);
    const info = certificateInfo(material.fullchain);
    const base = {
      isOn: true,
      isCA: false,
      certData: btoa(material.fullchain),
      keyData: btoa(material.privateKey),
      timeBeginAt: info.notBefore,
      timeEndAt: info.notAfter,
      dnsNames: material.domains,
      commonNames: [info.issuerCommonName],
    };
    if (list.length > 0) {
      for (const row of list) {
        await api(runtime, config, '/SSLCertService/updateSSLCert', {
          sslCertId: row.id,
          name: row.name,
          description: row.description,
          serverName: row.serverName,
          ...base,
        }, accessToken);
        runtime.log(`证书ID:${readString(row, 'id')}更新成功！`);
      }
      return;
    }
    const name = certificateName(material.fullchain);
    const created = await api(runtime, config, '/SSLCertService/createSSLCert', {
      name,
      description: name,
      serverName: info.commonName,
      ...base,
    }, accessToken);
    runtime.log(`证书ID:${created ? readString(created, 'sslCertId') : ''}添加成功！`);
  },
};
