import { deployMeta } from '../metadata';
import { deployRaw, panelBaseUrl, postForm } from '../http';
import { hmacSha256Hex } from '../../dns/sign';
import { hmacMd5Hex } from '../sign';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function cookie(config: DeployTaskConfig): string {
  const apikey = requireField(config, 'apikey', '接口密钥');
  return `PHPSESSID=${hmacMd5Hex(apikey, `php_sessid=${apikey}`)}`;
}

function errorText(html: string): string {
  const match = /<p id="error"[^>]*>([\s\S]*?)(?:<\/p>|<br\s*\/?>)/.exec(html);
  return match && match[1] ? match[1].replace(/<[^>]+>/g, '').trim() : '';
}

/**
 * AMH 的登录接口用 amapi_sign 签名。
 * 注意：PHP 原实现里 `'amapi_expires=' . time() + 120` 因运算符优先级被算成了数字，
 * 这里按文档语义发送真正的过期时间戳，签名覆盖实际提交的报文。
 */
async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const apikey = requireField(config, 'apikey', '接口密钥');
  const payload = `amapi_expires=${Math.floor(Date.now() / 1000) + 120}`;
  const response = await deployRaw(runtime, `${panelBaseUrl(config)}/?c=amapi&a=login`, {
    method: 'POST',
    headers: { cookie: cookie(config), 'content-type': 'application/x-www-form-urlencoded' },
    body: `${payload}&amapi_sign=${await hmacSha256Hex(apikey, payload)}`,
  }, 'AMH面板');
  const location = response.headers.get('location') ?? '';
  if (response.status === 302 && location.includes('amh_token=')) {
    const token = /amh_token=([A-Za-z0-9]+)/.exec(location)?.[1];
    if (token) return token;
    throw new Error('面板返回数据异常');
  }
  if (response.status === 200) {
    const detail = errorText(await response.text());
    if (detail) throw new Error(detail);
  }
  throw new Error('面板地址无法连接');
}

export const amh: DeployProvider = {
  meta: deployMeta('amh'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    const env = requireField(taskConfig, 'env_name', '环境名称');
    const vhosts = (taskConfig.vhost_name ?? '').split('\n').map((item) => item.trim()).filter(Boolean);
    if (vhosts.length === 0) throw new Error('网站标识域名不能为空');
    const token = await login(runtime, config);
    for (const vhost of vhosts) {
      const path = `/?c=amssl&a=admin_amssl&envs_name=${encodeURIComponent(env)}&vhost_name=${encodeURIComponent(vhost)}&ModuleSort=app`;
      const html = await postForm(runtime, `${panelBaseUrl(config)}${path}`, {
        submit_key_crt: 'y',
        key_input1: 'key_input1',
        key_content1: material.privateKey,
        crt_input1: 'crt_input1',
        crt_content1: material.fullchain,
        amh_token: token,
      }, { cookie: cookie(config) }, 'AMH面板');
      if (html.includes('<p id="success"')) {
        runtime.log(`网站 ${vhost} 证书部署成功`);
        continue;
      }
      const detail = errorText(html);
      if (detail) {
        runtime.log(`网站 ${vhost} 证书部署失败：${detail}`);
        throw new Error(detail);
      }
      throw new Error(`网站 ${vhost} 证书部署失败：未知错误`);
    }
  },
};
