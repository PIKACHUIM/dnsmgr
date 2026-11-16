import forge from 'node-forge';
import { md5Hex } from '../../dns/sign';
import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonObject, postForm, readArray, readString } from '../http';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

function tokenParams(config: DeployTaskConfig): Record<string, string> {
  const time = String(Math.floor(Date.now() / 1000));
  return { request_token: md5Hex(time + md5Hex(requireField(config, 'key', '接口密钥'))), request_time: time };
}

async function api(
  runtime: DeployRuntime, config: DeployTaskConfig, path: string, params: Record<string, string | number>,
): Promise<Record<string, unknown>> {
  const text = await postForm(runtime, `${panelBaseUrl(config)}${path}`, {
    ...tokenParams(config), ...params,
  }, {}, '宝塔Win面板');
  return parseJsonObject(text, '宝塔Win面板');
}

function ensureTrue(body: Record<string, unknown>, fallback: string): void {
  if (body.status) return;
  throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : fallback);
}

/** 对应 PHP 的 openssl_pkcs12_export：叶子证书 + 私钥 + 固定密码。 */
function createPfx(fullchain: string, privateKey: string, password: string): ArrayBuffer {
  let certificate: forge.pki.Certificate;
  let key: forge.pki.PrivateKey;
  try {
    certificate = forge.pki.certificateFromPem(fullchain);
    key = forge.pki.privateKeyFromPem(privateKey);
  } catch {
    throw new Error('证书解析失败');
  }
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [certificate], password, { algorithm: '3des' });
  const binary = forge.asn1.toDer(asn1).getBytes();
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index++) view[index] = binary.charCodeAt(index);
  return buffer;
}

export const btwin: DeployProvider = {
  meta: deployMeta('btwin'),

  async check(config, runtime) {
    const body = await api(runtime, config, '/config/get_config', {});
    const panel = body.panel && typeof body.panel === 'object' ? body.panel as Record<string, unknown> : {};
    if (!panel.status) throw new Error(typeof body.msg === 'string' && body.msg ? body.msg : '面板地址无法连接');
  },

  async deploy(taskConfig, config, material, runtime) {
    const base = panelBaseUrl(config);
    if (taskConfig.type === '1') {
      ensureTrue(await api(runtime, config, '/config/set_panel_ssl', {
        ssl_key: material.privateKey, ssl_pem: material.fullchain,
      }), '面板证书部署失败');
      runtime.log('面板证书部署成功');
      return;
    }

    const isIis = taskConfig.type === '0' && taskConfig.is_iis === '1';
    let pfxPath = '';
    const pfxPassword = '123456';
    if (isIis) {
      const settings = await api(runtime, config, '/panel/get_config', {});
      const paths = settings.paths && typeof settings.paths === 'object' ? settings.paths as Record<string, unknown> : {};
      const iisConfig = settings.config && typeof settings.config === 'object' ? settings.config as Record<string, unknown> : {};
      const soft = readString(paths, 'soft');
      if (!soft) throw new Error(typeof settings.msg === 'string' && settings.msg ? settings.msg : '面板地址无法连接');
      if (readString(iisConfig, 'webserver') !== 'iis') throw new Error('当前安装的Web服务器不是IIS');
      const pfx = createPfx(material.fullchain, material.privateKey, pfxPassword);
      const directory = `${soft}/temp/ssl/${Date.now()}`;
      pfxPath = `${directory}/cert.pfx`;
      const form = new FormData();
      for (const [key, value] of Object.entries(tokenParams(config))) form.append(key, value);
      form.append('path', directory);
      form.append('filename', 'cert.pfx');
      form.append('size', String(pfx.byteLength));
      form.append('start', '0');
      form.append('blob', new Blob([pfx], { type: 'application/octet-stream' }), 'cert.pfx');
      form.append('force', 'true');
      const text = await deployRequest(runtime, `${base}/files/upload`, { method: 'POST', body: form }, '宝塔Win面板');
      ensureTrue(parseJsonObject(text, '宝塔Win面板'), '证书上传失败');
    }

    let success = 0;
    let lastError = '';
    for (const site of splitList(taskConfig.sites)) {
      try {
        if (isIis) {
          ensureTrue(await api(runtime, config, '/site/set_site_domain_ssl', {
            domain: site, path: pfxPath, password: pfxPassword,
          }), `域名 ${site} 证书部署失败`);
          runtime.log(`域名 ${site} 证书部署成功`);
        } else {
          const list = await api(runtime, config, '/datalist/get_data_list', {
            table: 'sites', search_type: 'PHP', search: site, p: 1, limit: 10, type: -1,
          });
          const rows = readArray(list, 'data');
          if (rows.length === 0) throw new Error(`网站 ${site} 不存在`);
          const match = rows.find((row) => readString(row, 'name') === site);
          if (!match) throw new Error(`网站 ${site} 不存在`);
          ensureTrue(await api(runtime, config, '/site/set_site_ssl', {
            siteid: readString(match, 'id'), status: 'true', sslType: '',
            cert: material.fullchain, key: material.privateKey,
          }), `网站 ${site} 证书部署失败`);
          runtime.log(`网站 ${site} 证书部署成功`);
        }
        success += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : '请求失败';
        runtime.log(`${isIis ? '域名' : '网站'} ${site} 证书部署失败：${lastError}`);
      }
    }
    if (success === 0) throw new Error(lastError || '要部署的网站不存在');
  },
};
