import { certificateInfo } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, joinUrl, panelBaseUrl, parseJsonObject, readArray, readString } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string,
  payload?: Record<string, unknown>, method: 'GET' | 'POST' = 'POST',
): Promise<unknown> {
  const base = joinUrl(panelBaseUrl(config), '/api/v1');
  const text = await deployRequest(runtime, `${base}${path}`, {
    method,
    headers: {
      'X-API-Key': requireField(config, 'api_key', 'API Key'),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  }, 'SamWaf');
  const body = parseJsonObject(text, 'SamWaf');
  if (body.code === 0) return body.data ?? null;
  throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '请求失败');
}

function sameSerial(value: unknown, serialHex: string): boolean {
  const normalized = serialHex.replace(/^0+/, '') || '0';
  let target: bigint;
  try { target = BigInt(`0x${normalized}`); } catch { return false; }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value) === target;
  if (typeof value !== 'string' || !value) return false;
  try {
    if (/^\d+$/.test(value)) return BigInt(value) === target;
    if (/^[0-9a-fA-F]+$/.test(value)) return BigInt(`0x${value}`) === target;
  } catch { return false; }
  return false;
}

export const samwaf: DeployProvider = {
  meta: deployMeta('samwaf'),

  async check(config, runtime) {
    await api(runtime, config, '/sysinfo/version', undefined, 'GET');
  },

  async deploy(taskConfig, config, material, runtime) {
    const id = typeof taskConfig.id === 'string' ? taskConfig.id.trim() : '';
    if (id) {
      await api(runtime, config, '/sslconfig/edit', {
        id, cert_content: material.fullchain, key_content: material.privateKey,
      });
      runtime.log(`证书ID:${id}更新成功！`);
      return;
    }
    try {
      await api(runtime, config, '/sslconfig/add', {
        cert_content: material.fullchain, key_content: material.privateKey,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : '请求失败';
      throw new Error(`证书添加失败，${detail}`);
    }
    const info = certificateInfo(material.fullchain);
    const list = await api(runtime, config, '/sslconfig/list', {
      domains: info.commonName, pageIndex: 1, pageSize: 10,
    });
    const rows = list && typeof list === 'object' ? readArray(list as Record<string, unknown>, 'list') : [];
    const found = rows.find((row) => sameSerial(row.serial_no, info.serialNumber));
    const created = found ? readString(found, 'id') : '';
    if (!created) throw new Error('证书添加成功但未能获取证书ID');
    runtime.saveConfig({ id: created });
    runtime.log(`证书ID:${created}添加成功！`);
  },
};
