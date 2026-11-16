import { certificateInfo } from '../cert';
import { deployMeta } from '../metadata';
import { deployRequest, panelBaseUrl, parseJsonObject, readArray, readString } from '../http';
import { requireField, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

interface Session {
  sid: string;
  synotoken: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 群晖返回的 valid_from 形如 "Nov 16 08:00:00 2026 GMT"，按固定格式解析。 */
function parseValidFrom(value: string): number {
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/.exec(value.trim());
  if (!match) return 0;
  const month = MONTHS.indexOf(match[1] ?? '');
  if (month < 0) return 0;
  const time = Date.UTC(
    Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]),
  );
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<Session> {
  const base = panelBaseUrl(config);
  const endpoint = `${base}/webapi/${String(config.version ?? '0') === '1' ? 'auth.cgi' : 'entry.cgi'}`;
  const body = new URLSearchParams({
    api: 'SYNO.API.Auth',
    version: '6',
    method: 'login',
    session: 'webui',
    account: requireField(config, 'username', '用户名'),
    passwd: requireField(config, 'password', '密码'),
    format: 'sid',
    enable_syno_token: 'yes',
  }).toString();
  const text = await deployRequest(runtime, endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  }, '群晖面板');
  const body_json = parseJsonObject(text, '群晖面板');
  if (body_json.success && body_json.data && typeof body_json.data === 'object') {
    const data = body_json.data as Record<string, unknown>;
    return { sid: readString(data, 'sid'), synotoken: readString(data, 'synotoken') };
  }
  if (body_json.error !== undefined) throw new Error(`登录失败：${JSON.stringify(body_json.error)}`);
  throw new Error('请求失败：登录接口返回异常');
}

export const synology: DeployProvider = {
  meta: deployMeta('synology'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    const session = await login(runtime, config);
    const base = panelBaseUrl(config);
    const info = certificateInfo(material.fullchain);
    const desc = typeof taskConfig.desc === 'string' ? taskConfig.desc : '';
    const listQuery = new URLSearchParams({
      api: 'SYNO.Core.Certificate.CRT',
      version: '1',
      method: 'list',
      _sid: session.sid,
      SynoToken: session.synotoken,
    }).toString();
    const listText = await deployRequest(runtime, `${base}/webapi/entry.cgi?${listQuery}`, {
    }, '群晖面板');
    const listBody = parseJsonObject(listText, '群晖面板');
    if (!listBody.success) throw new Error(`获取证书列表失败：${JSON.stringify(listBody.error ?? '请求失败')}`);
    runtime.log('获取证书列表成功');

    const data = listBody.data && typeof listBody.data === 'object' ? listBody.data as Record<string, unknown> : {};
    let id = '';
    let validFrom = 0;
    for (const item of readArray(data, 'certificates')) {
      const subject = item.subject && typeof item.subject === 'object' ? item.subject as Record<string, unknown> : {};
      if (readString(subject, 'common_name') === info.commonName || (desc !== '' && readString(item, 'desc') === desc)) {
        id = readString(item, 'id');
        validFrom = parseValidFrom(readString(item, 'valid_from'));
        break;
      }
    }
    if (id && validFrom === info.notBefore) {
      runtime.log(`证书ID:${id}已存在，无需更新`);
      return;
    }
    await importCertificate(runtime, config, material, session, id, desc);
  },
};

async function importCertificate(
  runtime: DeployRuntime, config: DeployTaskConfig, material: Parameters<DeployProvider['deploy']>[2],
  session: Session, id: string, desc: string,
): Promise<void> {
  const base = panelBaseUrl(config);
  const query = new URLSearchParams({
    api: 'SYNO.Core.Certificate',
    version: '1',
    method: 'import',
    _sid: session.sid,
    SynoToken: session.synotoken,
  }).toString();
  const form = new FormData();
  form.append('key', new Blob([material.privateKey], { type: 'application/x-pem-file' }), 'key.pem');
  form.append('cert', new Blob([material.fullchain], { type: 'application/x-pem-file' }), 'cert.pem');
  if (id) form.append('id', id);
  form.append('desc', desc);
  const text = await deployRequest(runtime, `${base}/webapi/entry.cgi?${query}`, {
    method: 'POST',
    body: form,
    timeoutMs: 30_000,
  }, '群晖面板');
  const body = parseJsonObject(text, '群晖面板');
  if (body.success) {
    runtime.log(id ? `证书ID:${id}更新成功！` : '证书上传成功！');
    return;
  }
  throw new Error(id ? `证书ID:${id}更新失败：${JSON.stringify(body.error ?? '请求失败')}` : `证书上传失败：${JSON.stringify(body.error ?? '请求失败')}`);
}
