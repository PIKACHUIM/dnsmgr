import { deployMeta } from '../metadata';
import { deployRaw, formBody, parseJsonObject, readString } from '../http';
import { md5Hex } from '../../dns/sign';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://api.west.cn/api/v2';

function decodeGbk(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

async function execute(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const username = requireField(config, 'username', '用户名');
  const password = requireField(config, 'api_password', 'API密码');
  const time = String(Date.now());
  const body = formBody({
    ...params,
    username,
    time,
    token: md5Hex(`${username}${password}${time}`),
  }).replaceAll('+', '%20');
  const response = await deployRaw(runtime, `${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, '西部数码');
  const text = decodeGbk(await response.arrayBuffer());
  if (!response.ok) throw new Error(`西部数码返回 HTTP ${response.status}`);
  const result = parseJsonObject(text, '西部数码');
  if (result.result === 200) {
    return result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? result.data as Record<string, unknown>
      : {};
  }
  throw new Error(typeof result.msg === 'string' && result.msg ? result.msg : '请求失败');
}

export const west: DeployProvider = {
  meta: deployMeta('west'),

  async check(config, runtime) {
    await execute(runtime, config, '/vhost/', { act: 'products' });
  },

  async deploy(taskConfig, config, material, runtime) {
    const sitename = requireField(taskConfig, 'sitename', 'FTP账号');
    let info: Record<string, unknown>;
    try {
      info = await execute(runtime, config, '/vhost/', { act: 'vhostssl', sitename, cmd: 'info' });
    } catch (error) {
      throw new Error(`获取虚拟主机SSL配置失败:${error instanceof Error ? error.message : '请求失败'}`);
    }
    try {
      await execute(runtime, config, '/vhost/', {
        act: 'vhostssl', sitename, cmd: 'import',
        keycontent: material.privateKey, certcontent: material.fullchain,
      });
    } catch (error) {
      throw new Error(`上传SSL证书失败:${error instanceof Error ? error.message : '请求失败'}`);
    }
    runtime.log('SSL证书上传成功');

    if (!info.SSLEnabled) {
      try {
        await execute(runtime, config, '/vhost/', { act: 'vhostssl', sitename, cmd: 'openssl' });
      } catch (error) {
        throw new Error(`虚拟主机部署SSL失败:${error instanceof Error ? error.message : '请求失败'}`);
      }
    } else {
      const ssl = info.sslcert && typeof info.sslcert === 'object'
        ? (info.sslcert as Record<string, unknown>).ssl
        : undefined;
      if (ssl && typeof ssl === 'object' && !Array.isArray(ssl)) {
        for (const [domain, row] of Object.entries(ssl as Record<string, unknown>)) {
          if (!material.domains.includes(domain)) continue;
          const sslid = row && typeof row === 'object' ? readString(row as Record<string, unknown>, 'sysid') : '';
          try {
            await execute(runtime, config, '/vhost/', {
              act: 'vhostssl', sitename, cmd: 'clearsslcache', sslid, dm: domain,
            });
            runtime.log(`更新${domain}证书缓存成功`);
          } catch (error) {
            runtime.log(`更新${domain}证书缓存失败:${error instanceof Error ? error.message : '请求失败'}`);
          }
        }
      }
    }
    runtime.log(`虚拟主机${sitename}部署SSL成功`);
  },
};
