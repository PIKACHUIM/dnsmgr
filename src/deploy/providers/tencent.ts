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
  const multi = ['cdn', 'waf', 'teo', 'ddos', 'live', 'vod', 'tcb'].includes(type);
  const ids = multi && instanceId.includes(',')
    ? instanceId.split(',').map((item) => item.trim()).filter(Boolean)
    : [instanceId];
  const instances = type === 'cdn' ? ids.map((id) => `${id}|on`) : ids;
  const payload: Record<string, unknown> = {
    CertificateId: certId, InstanceIdList: instances, ResourceType: type,
  };
  if (type === 'live') payload.Status = 1;
  const data = await tc3Request(runtime, client, 'DeployCertificateInstance', payload);
  runtime.log(`${type.toUpperCase()} 实例 ${instanceId} 部署证书成功！`);
  return Number(data.DeployRecordId ?? 0);
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

export const tencent: DeployProvider = {
  meta: deployMeta('tencent'),

  async check(config, runtime) {
    await tc3Request(runtime, account(config), 'DescribeCertificates', {});
  },

  async deploy(taskConfig, config, material, runtime) {
    const client = account(config);
    const selected = product(taskConfig);
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
