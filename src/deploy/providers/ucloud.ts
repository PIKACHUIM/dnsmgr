import { certificateInfo } from '../cert';
import { deployMeta } from '../metadata';
import { postJson, parseJsonObject, readArray, readString } from '../http';
import { sha1Hex } from '../sign';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const API = 'https://api.ucloud.cn/';

async function request(
  runtime: DeployRuntime, config: DeployTaskConfig, action: string, params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const publicKey = requireField(config, 'PublicKey', '公钥');
  const privateKey = requireField(config, 'PrivateKey', '私钥');
  const payload: Record<string, string> = { Action: action, PublicKey: publicKey, ...params };
  const sorted = Object.keys(payload).sort();
  const signature = await sha1Hex(`${sorted.map((key) => `${key}${payload[key]}`).join('')}${privateKey}`);
  const text = await postJson(runtime, API, { ...payload, Signature: signature }, {}, 'UCloud');
  const body = parseJsonObject(text, 'UCloud');
  if (body.RetCode === 0) return body;
  throw new Error(typeof body.Message === 'string' && body.Message ? body.Message : '返回数据解析失败');
}

function certificateName(fullchain: string): string {
  const info = certificateInfo(fullchain);
  return `${info.commonName.replaceAll('*', '').replaceAll('.', '')}-${info.notBefore}`;
}

export const ucloud: DeployProvider = {
  meta: deployMeta('ucloud'),

  async check(config, runtime) {
    await request(runtime, config, 'GetCertificateList', { Mode: 'free' });
  },

  async deploy(taskConfig, config, material, runtime) {
    const domainId = requireField(taskConfig, 'domain_id', '云分发资源ID');
    const certName = certificateName(material.fullchain);
    try {
      await request(runtime, config, 'AddCertificate', {
        CertName: certName, UserCert: material.fullchain, PrivateKey: material.privateKey,
      });
      runtime.log(`添加证书成功，名称:${certName}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '请求失败';
      if (!detail.includes('cert already exist')) throw new Error(`添加证书失败 ${detail}`);
      runtime.log(`证书已存在，名称:${certName}`);
    }
    let data: Record<string, unknown>;
    try {
      data = await request(runtime, config, 'GetUcdnDomainConfig', { 'DomainId.0': domainId });
    } catch (error) {
      throw new Error(`获取加速域名配置失败 ${error instanceof Error ? error.message : '请求失败'}`);
    }
    const domainRow = readArray(data, 'DomainList')[0];
    if (!domainRow) throw new Error(`云分发资源ID:${domainId}不存在`);
    const domain = readString(domainRow, 'Domain');
    const statusCn = readString(domainRow, 'HttpsStatusCn');
    const statusAbroad = readString(domainRow, 'HttpsStatusAbroad');
    if (readString(domainRow, 'CertNameCn') === certName || readString(domainRow, 'CertNameAbroad') === certName) {
      runtime.log(`云分发${domainId}证书已配置，无需重复操作`);
      return;
    }
    let certList: Record<string, unknown>;
    try {
      certList = await request(runtime, config, 'GetCertificateBaseInfoList', { Domain: domain });
    } catch (error) {
      throw new Error(`获取可用证书列表失败 ${error instanceof Error ? error.message : '请求失败'}`);
    }
    const certs = readArray(certList, 'CertList');
    if (certs.length === 0) throw new Error('可用证书列表为空');
    let certId = '';
    for (const cert of certs) {
      if (readString(cert, 'CertName') === certName) {
        certId = readString(cert, 'CertId');
        break;
      }
    }
    if (!certId) throw new Error('证书ID不存在');
    runtime.log(`证书ID获取成功:${certId}`);
    const params: Record<string, string> = { DomainId: domainId, CertName: certName, CertId: certId, CertType: 'ucdn' };
    if (statusCn === 'enable') params.HttpsStatusCn = statusCn;
    if (statusAbroad === 'enable') params.HttpsStatusAbroad = statusAbroad;
    if (statusCn !== 'enable' && statusAbroad !== 'enable') params.HttpsStatusCn = 'enable';
    try {
      await request(runtime, config, 'UpdateUcdnDomainHttpsConfigV2', params);
    } catch (error) {
      throw new Error(`https加速配置失败 ${error instanceof Error ? error.message : '请求失败'}`);
    }
    runtime.log(`云分发${domainId}证书配置成功！`);
    runtime.state.cert_id = certId;
    runtime.state.cert_name = certName;
  },
};
