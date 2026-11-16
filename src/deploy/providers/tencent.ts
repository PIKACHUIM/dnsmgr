import forge from 'node-forge';
import { deployMeta } from '../metadata';
import { requireField, type DeployMaterial, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmacRaw(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

interface TencentClient {
  secretId: string;
  secretKey: string;
  endpoint: string;
  service: string;
  version: string;
  region?: string;
}

async function tc3Request(
  runtime: DeployRuntime, client: TencentClient, action: string, payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const time = Math.floor(Date.now() / 1000);
  const date = new Date(time * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${client.service}/tc3_request`;
  const canonicalRequest = [
    'POST', '/', '',
    `content-type:application/json; charset=utf-8\nhost:${client.endpoint}\n`,
    'content-type;host',
    await sha256Hex(body),
  ].join('\n');
  const stringToSign = ['TC3-HMAC-SHA256', String(time), credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const secretDate = await hmacRaw(encoder.encode(`TC3${client.secretKey}`), date);
  const secretService = await hmacRaw(secretDate, client.service);
  const secretSigning = await hmacRaw(secretService, 'tc3_request');
  const signature = hex(await hmacRaw(secretSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${client.secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;
  const headers: Record<string, string> = {
    authorization,
    'content-type': 'application/json; charset=utf-8',
    'X-TC-Action': action,
    'X-TC-Timestamp': String(time),
    'X-TC-Version': client.version,
  };
  if (client.region) headers['X-TC-Region'] = client.region;
  const response = await runtime.fetch(`https://${client.endpoint}/`, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(20_000),
  });
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw new Error('腾讯云返回数据解析失败'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('腾讯云返回数据解析失败');
  const result = (parsed as Record<string, unknown>).Response;
  if (!result || typeof result !== 'object') throw new Error('腾讯云返回数据解析失败');
  const data = result as Record<string, unknown>;
  const error = data.Error as Record<string, unknown> | undefined;
  if (error) throw new Error(typeof error.Message === 'string' ? error.Message : `腾讯云请求失败（HTTP ${response.status}）`);
  return data;
}

function account(config: DeployTaskConfig): TencentClient {
  return {
    secretId: requireField(config, 'SecretId', 'SecretId'),
    secretKey: requireField(config, 'SecretKey', 'SecretKey'),
    endpoint: 'ssl.tencentcloudapi.com',
    service: 'ssl',
    version: '2019-12-05',
  };
}

function certificateAlias(material: DeployMaterial): string {
  let notBefore = Math.floor(Date.now() / 1000);
  try {
    const certificate = forge.pki.certificateFromPem(material.fullchain);
    notBefore = Math.floor(certificate.validity.notBefore.getTime() / 1000);
  } catch { /* 解析失败时回退到当前时间，仅用于别名 */ }
  return `${material.commonName.replace(/^\*\./, '')}-${notBefore}`;
}

async function uploadCertificate(
  runtime: DeployRuntime, client: TencentClient, material: DeployMaterial,
): Promise<string> {
  const data = await tc3Request(runtime, client, 'UploadCertificate', {
    CertificatePublicKey: material.fullchain,
    CertificatePrivateKey: material.privateKey,
    CertificateType: 'SVR',
    Alias: certificateAlias(material),
    Repeatable: false,
  });
  const certId = typeof data.CertificateId === 'string' ? data.CertificateId : '';
  if (!certId) throw new Error('上传证书失败：返回的 CertificateId 为空');
  runtime.log(`上传证书成功 CertificateId=${certId}`);
  await tc3Request(runtime, client, 'ModifyCertificatesExpiringNotificationSwitch', {
    CertificateIds: [certId], SwitchStatus: 1,
  }).catch(() => undefined);
  return certId;
}

function product(config: DeployTaskConfig): string {
  return typeof config.product === 'string' && config.product ? config.product : 'cdn';
}

async function deployInstance(
  runtime: DeployRuntime, client: TencentClient, type: string, certId: string, instanceId: string,
): Promise<number> {
  const multi = ['cdn', 'waf', 'teo', 'ddos', 'live', 'vod'].includes(type);
  const ids = multi && instanceId.includes(',')
    ? instanceId.split(',').map((item) => item.trim()).filter(Boolean)
    : [instanceId];
  const instances = type === 'cdn' ? ids.map((id) => `${id}|on`) : ids;
  const payload: Record<string, unknown> = {
    CertificateId: certId, InstanceIdList: instances, ResourceType: type,
  };
  if (type === 'live') payload.Status = 1;
  try {
    const data = await tc3Request(runtime, client, 'DeployCertificateInstance', payload);
    const recordId = Number(data.DeployRecordId ?? 0);
    if (recordId > 0) runtime.state.record_id = String(recordId);
    runtime.log(`${type.toUpperCase()} 实例 ${instanceId} 部署证书成功！`);
    return recordId;
  } catch (error) {
    const previous = runtime.state.record_id;
    if (previous && await deployRecordSucceeded(runtime, client, previous)) {
      runtime.log(`${type.toUpperCase()} 实例 ${instanceId} 已部署证书，无需重复部署`);
      return Number(previous) || 0;
    }
    throw error;
  }
}

/** 对应 PHP 的 deploy_query：上次部署记录成功或仍在进行时视为已部署，避免重复写入失败。 */
async function deployRecordSucceeded(runtime: DeployRuntime, client: TencentClient, recordId: string): Promise<boolean> {
  try {
    const data = await tc3Request(runtime, client, 'DescribeHostDeployRecordDetail', { DeployRecordId: recordId });
    if (Number(data.SuccessTotalCount ?? 0) >= 1 || Number(data.RunningTotalCount ?? 0) >= 1) return true;
    if (Number(data.FailedTotalCount ?? 0) >= 1) {
      const details = Array.isArray(data.DeployRecordDetailList) ? data.DeployRecordDetailList as Record<string, unknown>[] : [];
      const failure = details.find((detail) => typeof detail.ErrorMsg === 'string' && detail.ErrorMsg);
      if (failure) runtime.log(`证书部署失败原因：${String(failure.ErrorMsg)}`);
    }
  } catch (error) {
    runtime.log(`查询证书部署记录失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
  return false;
}

async function deployClb(runtime: DeployRuntime, config: DeployTaskConfig, certId: string): Promise<void> {
  const region = requireField(config, 'regionid', '所属地域ID');
  const loadBalancerId = requireField(config, 'clb_id', '负载均衡ID');
  const domain = typeof config.clb_domain === 'string' ? config.clb_domain.trim() : '';
  const sniSwitch = domain ? 1 : 0;
  const client: TencentClient = {
    secretId: requireField(config, 'SecretId', 'SecretId'),
    secretKey: requireField(config, 'SecretKey', 'SecretKey'),
    endpoint: 'clb.tencentcloudapi.com', service: 'clb', version: '2018-03-17', region,
  };
  const payload: Record<string, unknown> = { LoadBalancerId: loadBalancerId, Protocol: 'HTTPS' };
  const listenerId = typeof config.clb_listener_id === 'string' ? config.clb_listener_id.trim() : '';
  if (listenerId) payload.ListenerIds = [listenerId];
  const data = await tc3Request(runtime, client, 'DescribeListeners', payload);
  const listeners = Array.isArray(data.Listeners) ? data.Listeners as Record<string, unknown>[] : [];
  if (Number(data.TotalCount ?? 0) === 0 || listeners.length === 0) {
    throw new Error(`负载均衡:${loadBalancerId} 监听器列表为空`);
  }
  let count = 0;
  for (const listener of listeners) {
    if (Number(listener.SniSwitch ?? 0) !== sniSwitch) continue;
    const listenerIdValue = String(listener.ListenerId ?? '');
    if (sniSwitch === 1) {
      const rules = Array.isArray(listener.Rules) ? listener.Rules as Record<string, unknown>[] : [];
      for (const rule of rules) {
        if (rule.Domain !== domain) continue;
        const current = (rule.Certificate as Record<string, unknown> | undefined)?.CertId;
        if (current === certId) {
          runtime.log(`负载均衡监听器 ${listenerIdValue} 域名 ${domain} 已部署证书，无需重复部署`);
        } else {
          await tc3Request(runtime, client, 'ModifyDomainAttributes', {
            LoadBalancerId: loadBalancerId, ListenerId: listenerIdValue, Domain: domain,
            Certificate: { SSLMode: 'UNIDIRECTIONAL', CertId: certId },
          });
          runtime.log(`负载均衡监听器 ${listenerIdValue} 域名 ${domain} 部署证书成功！`);
        }
        count += 1;
      }
    } else {
      const current = (listener.Certificate as Record<string, unknown> | undefined)?.CertId;
      if (current === certId) {
        runtime.log(`负载均衡监听器 ${listenerIdValue} 已部署证书，无需重复部署`);
      } else {
        await tc3Request(runtime, client, 'ModifyListener', {
          LoadBalancerId: loadBalancerId, ListenerId: listenerIdValue,
          Certificate: { SSLMode: 'UNIDIRECTIONAL', CertId: certId },
        });
        runtime.log(`负载均衡监听器 ${listenerIdValue} 部署证书成功！`);
      }
      count += 1;
    }
  }
  if (count === 0) throw new Error('没有找到要更新证书的监听器');
}

async function deployScf(runtime: DeployRuntime, config: DeployTaskConfig, certId: string): Promise<void> {
  const region = requireField(config, 'regionid', '所属地域ID');
  const domain = requireField(config, 'domain', '绑定的域名');
  const client: TencentClient = {
    secretId: requireField(config, 'SecretId', 'SecretId'),
    secretKey: requireField(config, 'SecretKey', 'SecretKey'),
    endpoint: 'scf.tencentcloudapi.com', service: 'scf', version: '2018-04-16', region,
  };
  const data = await tc3Request(runtime, client, 'GetCustomDomain', { Domain: domain });
  const certConfig = (data.CertConfig as Record<string, unknown> | undefined) ?? {};
  if (certConfig.CertificateId === certId) {
    runtime.log(`云函数自定义域名 ${domain} 已部署证书，无需重复部署`);
    return;
  }
  certConfig.CertificateId = certId;
  const protocol = data.Protocol === 'HTTP' ? 'HTTP&HTTPS' : data.Protocol;
  await tc3Request(runtime, client, 'UpdateCustomDomain', { Domain: domain, Protocol: protocol, CertConfig: certConfig });
  runtime.log(`云函数自定义域名 ${domain} 部署证书成功！`);
}

async function deployTeo(runtime: DeployRuntime, config: DeployTaskConfig, certId: string): Promise<void> {
  const siteId = requireField(config, 'site_id', '站点ID');
  const domain = requireField(config, 'domain', '绑定的域名');
  const siteType = typeof config.site_type === 'string' ? config.site_type : 'cn';
  await tc3Request(runtime, {
    secretId: requireField(config, 'SecretId', 'SecretId'),
    secretKey: requireField(config, 'SecretKey', 'SecretKey'),
    endpoint: siteType === 'intl' ? 'teo.intl.tencentcloudapi.com' : 'teo.tencentcloudapi.com',
    service: 'teo', version: '2022-09-01',
  }, 'ModifyHostsCertificate', {
    ZoneId: siteId,
    Hosts: domain.split(',').map((item) => item.trim()).filter(Boolean),
    Mode: 'sslcert',
    ServerCertInfo: [{ CertId: certId }],
  });
  runtime.log(`边缘安全加速域名 ${domain} 部署证书成功！`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

interface BoundResources {
  types: string[];
  regions: { ResourceType: string; Regions: string[] }[];
}

/** PHP 侧最长轮询 60–120 秒；Workers 请求预算只有 25 秒，这里按次数封顶并提前返回 null。 */
const SYNC_POLL_ATTEMPTS = 10;
const REGION_RESOURCE_TYPES = ['clb', 'tke', 'apigateway', 'waf', 'tcb', 'tse', 'cos', 'mqtt', 'scf', 'tdmq'];

async function boundResources(
  runtime: DeployRuntime, client: TencentClient, certId: string, attempts = SYNC_POLL_ATTEMPTS,
): Promise<BoundResources | null> {
  const created = await tc3Request(runtime, client, 'CreateCertificateBindResourceSyncTask', {
    CertificateIds: [certId], IsCache: 1,
  });
  const tasks = Array.isArray(created.CertTaskIds) ? created.CertTaskIds as Record<string, unknown>[] : [];
  const taskId = tasks[0]?.TaskId;
  if (taskId === undefined || taskId === null || String(taskId) === '') {
    throw new Error('创建关联云资源查询任务失败：返回任务ID为空');
  }
  runtime.log(`创建关联云资源查询任务成功 TaskId=${String(taskId)}`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let data: Record<string, unknown>;
    try {
      data = await tc3Request(runtime, client, 'DescribeCertificateBindResourceTaskResult', { TaskIds: [taskId] });
    } catch (error) {
      throw new Error(`查询关联云资源任务结果失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    const results = Array.isArray(data.SyncTaskBindResourceResult)
      ? data.SyncTaskBindResourceResult as Record<string, unknown>[] : [];
    const result = results[0];
    if (!result) throw new Error('查询关联云资源任务结果失败：返回结果为空');
    if (Number(result.Status) === 2) {
      const failure = result.Error as Record<string, unknown> | undefined;
      throw new Error(`关联云资源查询任务执行失败：${typeof failure?.Message === 'string' ? failure.Message : '未知错误'}`);
    }
    if (Number(result.Status) === 1) {
      const types: string[] = [];
      const regions: BoundResources['regions'] = [];
      const entries = Array.isArray(result.BindResourceResult)
        ? result.BindResourceResult as Record<string, unknown>[] : [];
      for (const entry of entries) {
        const resourceType = typeof entry.ResourceType === 'string' ? entry.ResourceType : '';
        if (!resourceType) continue;
        let total = 0;
        const names: string[] = [];
        const regionEntries = Array.isArray(entry.BindResourceRegionResult)
          ? entry.BindResourceRegionResult as Record<string, unknown>[] : [];
        for (const region of regionEntries) {
          if (Number(region.TotalCount ?? 0) <= 0) continue;
          total += Number(region.TotalCount ?? 0);
          if (typeof region.Region === 'string' && region.Region) names.push(region.Region);
        }
        if (total <= 0) continue;
        types.push(resourceType);
        if (names.length > 0 && REGION_RESOURCE_TYPES.includes(resourceType)) {
          regions.push({ ResourceType: resourceType, Regions: names });
        }
      }
      return { types, regions };
    }
    await sleep(1000);
  }
  return null;
}

/** product=update：用 UploadUpdateCertificateInstance 原地更新证书内容，CertificateId 保持不变。 */
async function updateCertificateContent(
  runtime: DeployRuntime, client: TencentClient, taskConfig: DeployTaskConfig, material: DeployMaterial,
): Promise<void> {
  const certId = requireField(taskConfig, 'cert_id', '证书ID');
  const resources = await boundResources(runtime, client, certId);
  if (!resources) throw new Error('关联云资源查询任务超时未完成，请稍后重试');
  const types = resources.types.filter((type) => type === 'clb');
  const regions = resources.regions.filter((entry) => entry.ResourceType === 'clb');
  const payload: Record<string, unknown> = {
    OldCertificateId: certId,
    CertificatePublicKey: material.fullchain,
    CertificatePrivateKey: material.privateKey,
    ResourceTypes: types,
    ResourceTypesRegions: regions,
  };
  let submitted = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let data: Record<string, unknown>;
    try {
      data = await tc3Request(runtime, client, 'UploadUpdateCertificateInstance', payload);
    } catch (error) {
      throw new Error(`更新证书内容失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    if (Number(data.DeployStatus) === 1) { submitted = true; break; }
    await sleep(1000);
  }
  runtime.log(`更新证书内容${submitted ? '成功' : '已提交'}，可能需要一些时间完成各资源的证书更新部署`);
}

/** product=update_new：一键更新关联资源并生成新的 CertificateId，回写到任务配置。 */
async function updateCertificateWithNewId(
  runtime: DeployRuntime, client: TencentClient, taskConfig: DeployTaskConfig, material: DeployMaterial,
): Promise<void> {
  const oldCertId = requireField(taskConfig, 'cert_id', '证书ID');
  const resources = await boundResources(runtime, client, oldCertId, 12);
  if (!resources) runtime.log('关联云资源查询任务超时，将跳过资源查询，仅上传新证书');
  const types = resources?.types ?? [];
  const regions = resources?.regions ?? [];

  if (types.length === 0) {
    runtime.log('未检测到该证书关联的云资源实例，将仅上传新证书');
    let newCertId: string | null = null;
    try {
      const data = await tc3Request(runtime, client, 'UploadCertificate', {
        CertificatePublicKey: material.fullchain,
        CertificatePrivateKey: material.privateKey,
        CertificateType: 'SVR',
        Alias: certificateAlias(material),
        Repeatable: true,
        AllowDownload: true,
      });
      newCertId = typeof data.CertificateId === 'string' && data.CertificateId ? data.CertificateId : null;
      if (newCertId) {
        runtime.log(`新证书上传成功 CertificateId=${newCertId}`);
        runtime.saveConfig({ cert_id: newCertId });
        runtime.log(`证书ID已更新为 ${newCertId}`);
        await tc3Request(runtime, client, 'ModifyCertificatesExpiringNotificationSwitch', {
          CertificateIds: [newCertId], SwitchStatus: 1,
        }).catch(() => undefined);
      } else {
        runtime.log('上传新证书失败：返回的 CertificateId 为空');
      }
    } catch (error) {
      runtime.log(`上传新证书失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    await deleteOldCertificate(runtime, client, taskConfig, oldCertId, newCertId);
    return;
  }

  runtime.log(`发现关联云资源类型：${types.join(', ')}`);
  const payload: Record<string, unknown> = {
    OldCertificateId: oldCertId,
    CertificatePublicKey: material.fullchain,
    CertificatePrivateKey: material.privateKey,
    ResourceTypes: types,
  };
  if (regions.length > 0) payload.ResourceTypesRegions = regions;

  let newCertId: string | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let data: Record<string, unknown>;
    try {
      data = await tc3Request(runtime, client, 'UpdateCertificateInstance', payload);
    } catch (error) {
      throw new Error(`一键更新旧证书资源失败：${error instanceof Error ? error.message : '请求失败'}`);
    }
    if (Number(data.DeployRecordId ?? 0) > 0) {
      runtime.log(`一键更新任务创建成功 DeployRecordId=${String(data.DeployRecordId)}`);
      newCertId = await findNewCertificateId(runtime, client, material.commonName);
      break;
    }
    await sleep(2000);
  }
  if (newCertId) {
    runtime.saveConfig({ cert_id: newCertId });
    runtime.log(`证书ID已更新为 ${newCertId}`);
  }
  await deleteOldCertificate(runtime, client, taskConfig, oldCertId, newCertId);
  runtime.log('一键更新旧证书资源已提交，可能需要一些时间完成各资源的证书更新部署');
}

async function deleteOldCertificate(
  runtime: DeployRuntime, client: TencentClient, config: DeployTaskConfig, oldCertId: string, newCertId: string | null,
): Promise<void> {
  if (config.delete_old_cert !== '1') return;
  if (newCertId && newCertId === oldCertId) {
    runtime.log('新证书ID与旧证书ID相同（证书内容未变），跳过删除');
    return;
  }
  try {
    await tc3Request(runtime, client, 'DeleteCertificate', { CertificateId: oldCertId });
    runtime.log(`旧证书 ${oldCertId} 已从腾讯云删除`);
  } catch (error) {
    runtime.log(`删除旧证书 ${oldCertId} 失败：${error instanceof Error ? error.message : '请求失败'}`);
  }
}

/** 一键更新后按证书域名回查新生成的 CertificateId（对应 PHP 的 find_new_cert_id）。 */
async function findNewCertificateId(
  runtime: DeployRuntime, client: TencentClient, commonName: string,
): Promise<string | null> {
  const name = commonName.replace(/^\*\./, '');
  if (!name) return null;
  try {
    const data = await tc3Request(runtime, client, 'DescribeCertificates', { SearchKey: name, Limit: 20 });
    const certificates = Array.isArray(data.Certificates) ? data.Certificates as Record<string, unknown>[] : [];
    const candidates = certificates
      .filter((certificate) => Number(certificate.Status) === 1
        && (certificate.Domain === name || certificate.Domain === `*.${name}`))
      .sort((left, right) => Date.parse(String(right.CertEndTime ?? '')) - Date.parse(String(left.CertEndTime ?? '')));
    const found = candidates[0]?.CertificateId;
    return typeof found === 'string' && found ? found : null;
  } catch (error) {
    runtime.log(`查询新证书ID失败：${error instanceof Error ? error.message : '请求失败'}`);
    return null;
  }
}

export const tencent: DeployProvider = {
  meta: deployMeta('tencent'),

  async check(config, runtime) {
    await tc3Request(runtime, account(config), 'DescribeCertificates', {});
  },

  async deploy(taskConfig, config, material, runtime) {
    const client = account(config);
    const selected = product(taskConfig);
    if (selected === 'update') {
      await updateCertificateContent(runtime, client, taskConfig, material);
      return;
    }
    if (selected === 'update_new') {
      await updateCertificateWithNewId(runtime, client, taskConfig, material);
      return;
    }
    if (selected === 'upload') {
      await uploadCertificate(runtime, client, material);
      return;
    }
    const certId = await uploadCertificate(runtime, client, material);
    runtime.state.cert_id = certId;

    if (selected === 'clb') return deployClb(runtime, taskConfig, certId);
    if (selected === 'scf') return deployScf(runtime, taskConfig, certId);
    if (selected === 'teo') return deployTeo(runtime, taskConfig, certId);

    const domain = requireField(taskConfig, 'domain', '绑定的域名');
    if (selected === 'ddos') {
      await deployInstance(runtime, client, 'ddos', certId, `${requireField(taskConfig, 'lighthouse_id', '实例ID')}|${domain}|443`);
      return;
    }
    if (selected === 'cos') {
      const region = requireField(taskConfig, 'regionid', '所属地域ID');
      const bucket = requireField(taskConfig, 'cos_bucket', '存储桶名称');
      const regional = { ...client, region };
      await deployInstance(runtime, regional, 'cos', certId, `${region}|${bucket}|${domain}`);
      return;
    }
    if (selected === 'tke') {
      const region = requireField(taskConfig, 'regionid', '所属地域ID');
      const cluster = requireField(taskConfig, 'tke_cluster_id', '集群ID');
      const namespace = requireField(taskConfig, 'tke_namespace', '命名空间');
      const secret = requireField(taskConfig, 'tke_secret', '证书的 secret 名称');
      const regional = { ...client, region };
      await deployInstance(runtime, regional, 'tke', certId, `${cluster}|${namespace}|${secret}`);
      return;
    }
    if (selected === 'lighthouse') {
      const region = requireField(taskConfig, 'regionid', '所属地域ID');
      const instance = requireField(taskConfig, 'lighthouse_id', '实例ID');
      const regional = { ...client, region };
      await deployInstance(runtime, regional, 'lighthouse', certId, `${region}|${instance}|${domain}`);
      return;
    }
    if (selected === 'tse') {
      const region = requireField(taskConfig, 'regionid', '所属地域ID');
      const regional = { ...client, region };
      await deployInstance(runtime, regional, 'tse', certId, domain);
      return;
    }
    if (selected === 'waf') {
      const region = typeof taskConfig.region === 'string' && taskConfig.region ? taskConfig.region : 'ap-guangzhou';
      await deployInstance(runtime, { ...client, region }, 'waf', certId, domain);
      return;
    }
    await deployInstance(runtime, client, selected, certId, domain);
  },
};
