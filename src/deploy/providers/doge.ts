import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, formBody, parseJsonObject, readArray, readString } from '../http';
import { hmacSha1Hex } from '../sign';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://api.dogecloud.com';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  const body = params ? formBody(params) : '';
  const signature = await hmacSha1Hex(requireField(config, 'SecretKey', 'SecretKey'), `${path}\n${body}`);
  const text = await deployRequest(runtime, `${API}${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: `TOKEN ${requireField(config, 'AccessKey', 'AccessKey')}:${signature}`,
      ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? body : undefined,
  }, '多吉云');
  const result = parseJsonObject(text, '多吉云');
  if (result.code === 200) {
    return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? result.data as Record<string, unknown>
      : null;
  }
  throw new Error(typeof result.msg === 'string' && result.msg ? result.msg : '请求失败');
}

async function certificateId(
  runtime: DeployRuntime, config: DeployTaskConfig, material: Parameters<DeployProvider['deploy']>[2],
): Promise<string> {
  const name = certificateName(material.fullchain);
  const list = await api(runtime, config, '/cdn/cert/list.json');
  const certs = list ? readArray(list, 'certs') : [];
  let found = '';
  const now = Math.floor(Date.now() / 1000);
  for (const cert of certs) {
    if (readString(cert, 'note') === name) {
      found = readString(cert, 'id');
      runtime.log(`证书${name}已存在，证书ID:${found}`);
      continue;
    }
    const expire = Number(cert.expire ?? 0);
    if (expire < now && Number(cert.domainCount ?? 0) === 0) {
      try {
        await api(runtime, config, '/cdn/cert/delete.json', { id: readString(cert, 'id') });
        runtime.log(`证书${readString(cert, 'name')}已过期，删除证书成功`);
      } catch (error) {
        runtime.log(`证书${readString(cert, 'name')}已过期，删除证书失败:${error instanceof Error ? error.message : '请求失败'}`);
      }
      await sleep(300);
    }
  }
  if (found) return found;
  let uploaded: Record<string, unknown> | null;
  try {
    uploaded = await api(runtime, config, '/cdn/cert/upload.json', {
      note: name, cert: material.fullchain, private: material.privateKey,
    });
  } catch (error) {
    throw new Error(`上传证书失败:${error instanceof Error ? error.message : '请求失败'}`);
  }
  const id = uploaded ? readString(uploaded, 'id') : '';
  if (!id) throw new Error('上传证书失败:响应未返回证书ID');
  runtime.log(`上传证书成功，证书ID:${id}`);
  await sleep(500);
  return id;
}

export const doge: DeployProvider = {
  meta: deployMeta('doge'),

  async check(config, runtime) {
    await api(runtime, config, '/cdn/cert/list.json');
  },

  async deploy(taskConfig, config, material, runtime) {
    const domains = splitList(taskConfig.domain);
    if (domains.length === 0) throw new Error('绑定的域名不能为空');
    const id = await certificateId(runtime, config, material);
    for (const domain of domains) {
      await api(runtime, config, '/cdn/cert/bind.json', { id, domain });
      runtime.log(`CDN域名 ${domain} 绑定证书成功！`);
    }
    runtime.state.cert_id = id;
  },
};
