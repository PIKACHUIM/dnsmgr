import { certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { DeployHttpError, postJson, parseJsonObject } from '../http';
import { requireField, type DeployProvider } from '../types';

const API = 'https://cdn.api.baishan.com';

export const baishan: DeployProvider = {
  meta: deployMeta('baishan'),

  async check(config) {
    requireField(config, 'token', 'token');
  },

  async deploy(taskConfig, config, material, runtime) {
    const id = requireField(taskConfig, 'id', '证书ID');
    const token = requireField(config, 'token', 'token');
    try {
      const text = await postJson(runtime, `${API}/v2/domain/certificate?token=${encodeURIComponent(token)}`, {
        cert_id: id,
        name: certificateName(material.fullchain),
        certificate: material.fullchain,
        key: material.privateKey,
      }, {}, '白山云');
      const body = parseJsonObject(text, '白山云');
      if (body.code === 0) {
        runtime.log(`证书ID:${id}更新成功！`);
        return;
      }
      throw new Error(typeof body.message === 'string' ? body.message : '请求失败');
    } catch (error) {
      const detail = error instanceof DeployHttpError ? error.message : error instanceof Error ? error.message : '请求失败';
      if (detail.includes('this certificate is exists')) {
        runtime.log(`证书ID:${id}已存在，无需更新`);
        return;
      }
      throw new Error(detail);
    }
  },
};
