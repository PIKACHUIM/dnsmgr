import { certificateInfo, certificateName } from '../cert';
import { deployMeta } from '../metadata';
import { DeployHttpError, deployRequest, parseJsonObject } from '../http';
import { requireField, type DeployProvider, type DeployMaterial, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://api.axisnow.io';

function errorMessage(error: unknown): string {
  if (error instanceof DeployHttpError) {
    try {
      const body = parseJsonObject(error.body, 'AxisNow');
      const messages = Array.isArray(body.errors)
        ? body.errors.map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as Record<string, unknown>).message === 'string' ? String((item as Record<string, unknown>).message) : '')).filter(Boolean)
        : [];
      if (messages.length > 0) return messages.join('; ');
      if (error.body.trim()) return error.body.trim().slice(0, 300);
    } catch { /* 落到默认提示 */ }
  }
  return error instanceof Error ? error.message : '请求失败';
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, method: 'GET' | 'POST',
  path: string, payload?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const text = await deployRequest(runtime, `${API}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${requireField(config, 'token', 'Token')}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  }, 'AxisNow');
  const body = parseJsonObject(text, 'AxisNow');
  if (body.success) {
    return body.result && typeof body.result === 'object' && !Array.isArray(body.result)
      ? body.result as Record<string, unknown>
      : null;
  }
  throw new Error(errorMessage(new DeployHttpError(200, text, 'AxisNow')));
}

export const axisnow: DeployProvider = {
  meta: deployMeta('axisnow'),

  async check(config, runtime) {
    try {
      await api(runtime, config, 'GET', '/client/v1/certificates');
    } catch (error) {
      throw new Error(`Token无效或请求失败:${errorMessage(error)}`);
    }
  },

  async deploy(_taskConfig, config, material: DeployMaterial, runtime) {
    const name = certificateName(material.fullchain);
    const fingerprint = certificateInfo(material.fullchain).fingerprintSha256;
    const uuid = runtime.state.uuid ?? '';
    if (uuid) {
      try {
        const existing = await api(runtime, config, 'GET', `/client/v1/certificates/${encodeURIComponent(uuid)}`);
        const certificate = existing && typeof existing.certificate === 'string' ? existing.certificate : '';
        if (certificate && certificateInfo(certificate).fingerprintSha256 === fingerprint) {
          runtime.log(`相同证书${name}已存在，UUID:${uuid}`);
          return;
        }
        runtime.log(`原证书内容不同或无法核对，将上传新证书，原UUID:${uuid}`);
      } catch (error) {
        runtime.log(`原证书获取失败(${errorMessage(error)})，将重新上传证书`);
      }
    }
    let uploaded: Record<string, unknown> | null;
    try {
      uploaded = await api(runtime, config, 'POST', '/client/v1/certificates', {
        type: 'upload',
        name,
        certificate: material.fullchain,
        private_key: material.privateKey,
      });
    } catch (error) {
      throw new Error(`上传证书失败:${errorMessage(error)}`);
    }
    const created = uploaded && typeof uploaded.uuid === 'string' ? uploaded.uuid.trim() : '';
    if (!created) throw new Error('上传证书失败:响应未返回证书UUID');
    runtime.state.uuid = created;
    runtime.log(`上传证书成功，UUID:${created}`);
  },
};
