import { deployMeta } from '../metadata';
import { deployRaw, parseJsonObject } from '../http';
import { hmacMd5Hex } from '../sign';
import { requireField, splitList, type DeployProvider, type DeployRuntime, type DeployTaskConfig } from '../types';

const encoder = new TextEncoder();
const ACCOUNT_SIGN_KEY = 'ba461799-fde8-429f-8cc4-4b6d306e2339';
const CONSOLE_SIGN_KEY = '4c1f7fbf-c732-42b0-ab10-4634a8bbe834';

function millis(): number {
  return Date.now();
}

function clientInfo(deviceId: string, appName: string): Record<string, string | number> {
  return {
    PLATFORM: 'web',
    OS: 'windows',
    APPID: '__UNI__unicloud_console',
    DEVICEID: deviceId,
    scene: 1001,
    appId: '__UNI__unicloud_console',
    appLanguage: 'zh-Hans',
    appName,
    appVersion: '1.0.0',
    appVersionCode: '100',
    browserName: 'chrome',
    browserVersion: '132.0.0.0',
    deviceId,
    deviceModel: 'PC',
    deviceType: 'pc',
    hostName: 'chrome',
    hostVersion: '132.0.0.0',
    osName: 'windows',
    osVersion: '10 x64',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    uniCompilerVersion: '5.23',
    uniPlatform: 'web',
    uniRuntimeVersion: '5.23',
    locale: 'zh-Hans',
    LOCALE: 'zh-Hans',
  };
}

function pemBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const body = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

interface EnvelopeKey {
  algorithm?: unknown;
  version?: unknown;
  keyId?: unknown;
  challengeId?: unknown;
  publicKey?: unknown;
}

async function passwordEnvelope(keyData: EnvelopeKey, username: string, password: string): Promise<Record<string, unknown>> {
  if (keyData.algorithm !== 'RSA-OAEP-256+A256GCM') {
    throw new Error(`不支持的密码加密算法:${String(keyData.algorithm)}`);
  }
  if (typeof keyData.publicKey !== 'string') throw new Error('密码加密失败: 无效的 RSA 公钥');
  const header = {
    version: keyData.version,
    algorithm: keyData.algorithm,
    keyId: keyData.keyId,
    challengeId: keyData.challengeId,
  };
  const payload = {
    action: 'login',
    challengeId: keyData.challengeId,
    issuedAt: millis(),
    password,
    email: username,
  };
  const aad = encoder.encode(JSON.stringify(header));
  const aesKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: aad, tagLength: 128,
  }, cryptoKey, encoder.encode(JSON.stringify(payload))));
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  let rsaKey: CryptoKey;
  try {
    rsaKey = await crypto.subtle.importKey('spki', pemBytes(keyData.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  } catch {
    throw new Error('密码加密失败: 无效的 RSA 公钥');
  }
  let encryptedKey: ArrayBuffer;
  try {
    encryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaKey, aesKey);
  } catch {
    throw new Error('密码加密失败: RSA 公钥长度不足');
  }
  return {
    ...header,
    encryptedKey: base64(new Uint8Array(encryptedKey)),
    iv: base64(iv),
    ciphertext: base64(ciphertext),
    tag: base64(tag),
  };
}

async function invoke(
  runtime: DeployRuntime, url: string, spaceId: string, signKey: string, biz: Record<string, unknown>,
  clientInfoValue: Record<string, string | number>, extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {
    method: 'serverless.function.runtime.invoke',
    params: JSON.stringify(biz),
    spaceId,
    timestamp: String(millis()),
  };
  const signature = (() => {
    const payload = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
    return hmacMd5Hex(signKey, payload);
  })();
  const response = await deployRaw(runtime, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      origin: 'https://account.dcloud.net.cn',
      referer: 'https://account.dcloud.net.cn/',
      'content-type': 'application/json',
      'x-client-info': JSON.stringify(clientInfoValue),
      'x-serverless-sign': signature,
      ...extraHeaders,
    },
    body: JSON.stringify(params),
    timeoutMs: 20_000,
  }, 'uniCloud');
  const text = await response.text();
  return parseJsonObject(text, 'uniCloud');
}

async function login(runtime: DeployRuntime, config: DeployTaskConfig): Promise<string> {
  const username = requireField(config, 'username', '账号');
  const password = requireField(config, 'password', '密码');
  const deviceId = `${millis()}${Math.floor(Math.random() * 9_000_000) + 1_000_000}`;
  const info = clientInfo(deviceId, '账号中心');
  const challenge = await invoke(runtime, 'https://account.dcloud.net.cn/client', 'uni-id-server', ACCOUNT_SIGN_KEY, {
    functionTarget: 'uni-id-co',
    functionArgs: {
      method: 'createPasswordChallenge',
      params: [{
        action: 'login',
        resetAppId: '__UNI__unicloud_console',
        resetUniPlatform: 'web',
      }],
      clientInfo: info,
    },
  }, info);
  if (challenge.success !== true) throw new Error('获取密码加密密钥失败');
  const keyData = challenge.data as EnvelopeKey | undefined;
  if (!keyData || typeof keyData !== 'object') throw new Error('获取密码加密密钥失败');
  const envelope = await passwordEnvelope(keyData, username, password);

  const result = await invoke(runtime, 'https://account.dcloud.net.cn/client', 'uni-id-server', ACCOUNT_SIGN_KEY, {
    functionTarget: 'uni-id-co',
    functionArgs: {
      method: 'login',
      params: [{
        captcha: '',
        resetAppId: '__UNI__unicloud_console',
        resetUniPlatform: 'web',
        isReturnToken: false,
        passwordEnvelope: envelope,
      }],
      clientInfo: info,
    },
  }, info);
  if (result.success !== true) throw new Error('登录失败');
  const data = result.data;
  if (!data || typeof data !== 'object') throw new Error('登录失败');
  const body = data as Record<string, unknown>;
  if (Number(body.errCode ?? -1) !== 0) {
    throw new Error(`登录失败:${String(body.errMsg ?? '')}`);
  }
  const token = body.newToken && typeof body.newToken === 'object'
    ? (body.newToken as Record<string, unknown>).token : undefined;
  if (typeof token !== 'string' || !token) throw new Error('登录失败');
  return token;
}

async function userToken(runtime: DeployRuntime, uniIdToken: string): Promise<string> {
  const info = clientInfo(`${millis()}${Math.floor(Math.random() * 9_000_000) + 1_000_000}`, 'uniCloud控制台');
  const result = await invoke(runtime, 'https://unicloud.dcloud.net.cn/client', 'dc-6nfabcn6ada8d3dd', CONSOLE_SIGN_KEY, {
    functionTarget: 'uni-cloud-kernel',
    functionArgs: {
      action: 'user/getUserToken',
      data: { isLogin: true },
      clientInfo: info,
      uniIdToken,
    },
  }, info, { 'x-client-token': uniIdToken });
  if (result.success !== true) throw new Error('获取token失败');
  const data = result.data;
  if (!data || typeof data !== 'object') throw new Error('获取token失败');
  const body = data as Record<string, unknown>;
  if (Number(body.code ?? -1) !== 0) throw new Error('获取token失败');
  const inner = body.data;
  if (!inner || typeof inner !== 'object') throw new Error('获取token失败');
  const payload = inner as Record<string, unknown>;
  if (Number(payload.ret ?? -1) !== 0) throw new Error(`获取token失败:${String(payload.desc ?? '')}`);
  const final = payload.data;
  const token = final && typeof final === 'object' ? (final as Record<string, unknown>).token : undefined;
  if (typeof token !== 'string' || !token) throw new Error('获取token失败');
  return token;
}

export const unicloud: DeployProvider = {
  meta: deployMeta('unicloud'),

  async check(config, runtime) {
    await login(runtime, config);
  },

  async deploy(taskConfig, config, material, runtime) {
    requireField(taskConfig, 'domains', '绑定的域名');
    const spaceId = requireField(taskConfig, 'spaceId', '服务空间ID');
    const provider = typeof taskConfig.provider === 'string' && taskConfig.provider ? taskConfig.provider : 'aliyun';
    const token = await userToken(runtime, await login(runtime, config));
    for (const domain of splitList(taskConfig.domains)) {
      const response = await deployRaw(runtime, 'https://unicloud-api.dcloud.net.cn/unicloud/api/host/create-domain-with-cert', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', token },
        body: JSON.stringify({
          appid: '',
          provider,
          spaceId,
          domain,
          cert: encodeURIComponent(material.fullchain),
          key: encodeURIComponent(material.privateKey),
        }),
        timeoutMs: 20_000,
      }, 'uniCloud');
      const text = await response.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch { parsed = null; }
      if (parsed && Number(parsed.ret ?? -1) === 0) {
        runtime.log(`域名:${domain} 证书更新成功！`);
        continue;
      }
      if (parsed && typeof parsed.desc === 'string') {
        throw new Error(`域名:${domain} 证书更新失败:${parsed.desc}`);
      }
      throw new Error(`域名:${domain} 证书更新失败:${text.slice(0, 200)}`);
    }
  },
};
