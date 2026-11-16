import { deployMeta } from '../metadata';
import { postForm, postJson, parseJsonObject } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://www.kuocaicdn.com';

/** 登录后拿到的 kuocai_cdn_token，后续请求放在 Cookie 里。 */
async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const text = await postForm(runtime, `${API}/login/loginUser`, {
    userAccount: requireField(config, 'username', '控制台账号'),
    userPwd: requireField(config, 'password', '控制台密码'),
    remember: 'true',
  }, {}, '括彩云');
  const body = parseJsonObject(text, '括彩云');
  if (body.code !== 'SUCCESS') {
    throw new Error(typeof body.message === 'string' && body.message ? body.message : '登录失败');
  }
  return typeof body.data === 'string' ? body.data : '';
}

function certificateTag(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `cert_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const kuocai: DeployProvider = {
  meta: deployMeta('kuocai'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    const id = requireField(taskConfig, 'id', '域名ID');
    const token = await login(runtime, config);
    const text = await postJson(runtime, `${API}/CdnDomainHttps/httpsConfiguration`, {
      doMainId: id,
      https: {
        certificate_name: certificateTag(),
        certificate_source: '0',
        certificate_value: material.fullchain,
        https_status: 'on',
        private_key: material.privateKey,
      },
    }, { cookie: `kuocai_cdn_token=${token}` }, '括彩云');
    const body = parseJsonObject(text, '括彩云');
    if (body.code !== 'SUCCESS') {
      throw new Error(typeof body.message === 'string' && body.message ? body.message : '请求失败');
    }
    runtime.log(`域名ID:${id}更新成功！`);
  },
};
