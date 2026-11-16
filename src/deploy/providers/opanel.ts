import { md5Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonObject, readArray, readString } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig, type DeployMaterial } from '../types';

function apiBase(config: DeployTaskConfig): string {
  const version = typeof config.version === 'string' && config.version ? config.version : 'v1';
  return `${panelBaseUrl(config)}/api/${version}`;
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string,
  payload?: Record<string, unknown>, node?: string,
): Promise<Record<string, unknown> | null> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    '1Panel-Token': md5Hex(`1panel${requireField(config, 'key', '接口密钥')}${timestamp}`),
    '1Panel-Timestamp': timestamp,
    'content-type': 'application/json',
  };
  if (node) headers.CurrentNode = node;
  const text = await deployRequest(runtime, `${apiBase(config)}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload ?? {}),
  }, '1Panel');
  const body = parseJsonObject(text, '1Panel');
  if (body.code === 200) {
    return body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : null;
  }
  throw new Error(typeof body.message === 'string' && body.message ? body.message : '请求失败');
}

function wildcardOf(domain: string): string {
  const dot = domain.indexOf('.');
  return dot < 0 ? `*${domain}` : `*${domain.slice(dot)}`;
}

async function deployToNode(
  runtime: DeployRuntime, taskConfig: DeployTaskConfig, config: DeployTaskConfig,
  material: DeployMaterial, node: string,
): Promise<void> {
  const prefix = node ? `节点 [${node}] ` : '';
  const current = typeof taskConfig.id === 'string' ? taskConfig.id.trim() : '';
  if (current) {
    try {
      await api(runtime, config, '/websites/ssl/upload', {
        sslID: Number(current), type: 'paste', certificate: material.fullchain, privateKey: material.privateKey, description: '',
      }, node);
      runtime.log(`${prefix}证书ID:${current}更新成功！`);
    } catch (error) {
      throw new Error(`${prefix}证书ID:${current}更新失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    return;
  }
  if (material.domains.length === 0) throw new Error('没有设置要部署的域名');
  let data: Record<string, unknown> | null;
  try {
    data = await api(runtime, config, '/websites/ssl/search', {
      page: 1, pageSize: 500, orderBy: 'expire_date', order: 'null',
    }, node);
  } catch (error) {
    throw new Error(`${prefix}获取证书列表失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  runtime.log(`${prefix}获取证书列表成功(total=${String(data?.total ?? 0)})`);
  let success = 0;
  for (const row of data ? readArray(data, 'items') : []) {
    const primary = readString(row, 'primaryDomain');
    if (!primary) continue;
    const domains = [primary, ...splitList(typeof row.domains === 'string' ? row.domains : '')];
    const matched = domains.some((domain) => material.domains.includes(domain) || material.domains.includes(wildcardOf(domain)));
    if (!matched) continue;
    try {
      await api(runtime, config, '/websites/ssl/upload', {
        sslID: row.id, type: 'paste', certificate: material.fullchain, privateKey: material.privateKey, description: '',
      }, node);
      runtime.log(`${prefix}证书ID:${readString(row, 'id')}更新成功！`);
      success += 1;
    } catch (error) {
      runtime.log(`${prefix}证书ID:${readString(row, 'id')}更新失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
  }
  if (success > 0) return;
  await api(runtime, config, '/websites/ssl/upload', {
    sslID: 0, type: 'paste', certificate: material.fullchain, privateKey: material.privateKey, description: '',
  }, node);
  runtime.log(`${prefix}证书上传成功！`);
}

export const opanel: DeployProvider = {
  meta: deployMeta('opanel'),

  async check(config, runtime) {
    await api(runtime, config, '/settings/search');
  },

  async deploy(taskConfig, config, material, runtime) {
    const nodes = splitList(taskConfig.node_name);
    if (taskConfig.type === '3') {
      const payload = { cert: material.fullchain, key: material.privateKey, ssl: 'Enable', sslID: null, sslType: 'import-paste' };
      if (nodes.length === 0) {
        try {
          await api(runtime, config, '/core/settings/ssl/update', payload);
          runtime.log('面板证书更新成功！');
        } catch (error) {
          throw new Error(`面板证书更新失败：${error instanceof Error ? error.message : '请求失败'}`);
        }
        return;
      }
      let success = 0;
      try {
        await api(runtime, config, '/core/settings/ssl/update', payload);
        runtime.log('主节点面板证书更新成功！');
        success += 1;
      } catch (error) {
        runtime.log(`主节点面板证书更新失败：${error instanceof Error ? error.message : '请求失败'}`);
      }
      for (const node of nodes) {
        try {
          await api(runtime, config, '/core/settings/ssl/update', payload, node);
          runtime.log(`节点 [${node}] 面板证书更新成功！`);
          success += 1;
        } catch (error) {
          runtime.log(`节点 [${node}] 面板证书更新失败：${error instanceof Error ? error.message : '请求失败'}`);
        }
      }
      if (success === 0) throw new Error('所有节点证书更新失败');
      return;
    }
    if (nodes.length === 0) {
      await deployToNode(runtime, taskConfig, config, material, '');
      return;
    }
    let success = 0;
    try {
      await deployToNode(runtime, taskConfig, config, material, '');
      success += 1;
    } catch (error) {
      runtime.log(`主节点部署失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    for (const node of nodes) {
      try {
        await deployToNode(runtime, taskConfig, config, material, node);
        success += 1;
      } catch (error) {
        runtime.log(`节点 [${node}] 部署失败：${error instanceof Error ? error.message : '请求失败'}`);
      }
    }
    if (success === 0) throw new Error('所有节点部署失败');
  },
};
