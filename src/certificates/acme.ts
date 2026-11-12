import forge from 'node-forge';
import { AppError } from '../core/errors';

export type AcmeEnvironment = 'staging' | 'production';

export interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert?: string;
  keyChange?: string;
  meta?: { termsOfService?: string };
}

export interface AcmeJwsResponse {
  status: number;
  replayNonce: string | null;
  location: string | null;
  contentType: string;
  body: unknown;
  text: string;
}

export class AcmeProtocolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problemType: string | null = null,
    readonly replayNonce: string | null = null,
  ) {
    super(message);
    this.name = 'AcmeProtocolError';
  }
}

const directories: Record<AcmeEnvironment, string> = {
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  production: 'https://acme-v02.api.letsencrypt.org/directory',
};

function toBase64Url(value: string): string {
  return forge.util.encode64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function uintBase64Url(value: forge.jsbn.BigInteger): string {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  hex = hex.replace(/^(?:00)+(?=[0-9a-f]{2})/i, '');
  const bytes = hex.match(/.{2}/g)?.map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join('') ?? '';
  return toBase64Url(bytes);
}

function allowedOrigin(environment: AcmeEnvironment): string {
  return new URL(directories[environment]).origin;
}

export function acmeDirectoryUrl(environment: AcmeEnvironment): string {
  return directories[environment];
}

export function validateAcmeUrl(environment: AcmeEnvironment, value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AppError(502, 'ACME 服务返回了无效 URL', 'ACME_INVALID_URL'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== allowedOrigin(environment) || parsed.username || parsed.password || parsed.hash) {
    throw new AppError(502, 'ACME 服务 URL 超出允许的 CA 域名', 'ACME_URL_REJECTED');
  }
  return parsed.toString();
}

function responseBody(text: string, contentType: string): unknown {
  if (!text) return null;
  if (!contentType.includes('json')) return text;
  try { return JSON.parse(text) as unknown; } catch { throw new AcmeProtocolError('ACME 返回了无效 JSON', 502); }
}

async function readResponse(response: Response): Promise<{ body: unknown; text: string }> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (text.length > 512 * 1024) throw new AcmeProtocolError('ACME 响应超过允许大小', 502);
  return { body: responseBody(text, contentType), text };
}

export async function loadAcmeDirectory(fetcher: typeof fetch, environment: AcmeEnvironment): Promise<AcmeDirectory> {
  const url = directories[environment];
  const response = await fetcher(url, { method: 'GET', redirect: 'manual' });
  if (response.status !== 200) throw new AcmeProtocolError('无法读取 ACME Directory', response.status);
  const { body } = await readResponse(response);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AcmeProtocolError('ACME Directory 格式无效', 502);
  const value = body as Record<string, unknown>;
  const terms = value.meta && typeof value.meta === 'object' && !Array.isArray(value.meta)
    ? (value.meta as Record<string, unknown>).termsOfService : undefined;
  let termsOfService: string | undefined;
  if (typeof terms === 'string') {
    try {
      const termsUrl = new URL(terms);
      if (termsUrl.protocol === 'https:' && !termsUrl.username && !termsUrl.password) termsOfService = termsUrl.toString();
    } catch { termsOfService = undefined; }
  }
  const directory = {
    newNonce: validateAcmeUrl(environment, String(value.newNonce ?? '')),
    newAccount: validateAcmeUrl(environment, String(value.newAccount ?? '')),
    newOrder: validateAcmeUrl(environment, String(value.newOrder ?? '')),
    ...(typeof value.revokeCert === 'string' ? { revokeCert: validateAcmeUrl(environment, value.revokeCert) } : {}),
    ...(typeof value.keyChange === 'string' ? { keyChange: validateAcmeUrl(environment, value.keyChange) } : {}),
    ...(termsOfService ? { meta: { termsOfService } } : {}),
  };
  return directory;
}

export async function fetchAcmeNonce(fetcher: typeof fetch, environment: AcmeEnvironment, newNonceUrl: string): Promise<string> {
  const response = await fetcher(validateAcmeUrl(environment, newNonceUrl), { method: 'HEAD', redirect: 'manual' });
  if (response.status < 200 || response.status >= 300) throw new AcmeProtocolError('无法取得 ACME Replay-Nonce', response.status);
  const nonce = response.headers.get('Replay-Nonce');
  if (!nonce || nonce.length > 512) throw new AcmeProtocolError('ACME 响应缺少有效 Replay-Nonce', 502);
  return nonce;
}

export function createAcmeAccountKey(): string {
  const pair = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 });
  return forge.pki.privateKeyToPem(pair.privateKey);
}

export function accountJwk(privateKeyPem: string): { kty: 'RSA'; n: string; e: string } {
  const key = forge.pki.privateKeyFromPem(privateKeyPem);
  if (key.n.bitLength() < 2048) throw new AppError(503, 'ACME 账户 RSA 密钥长度无效', 'ACME_ACCOUNT_KEY_INVALID');
  return { kty: 'RSA', n: uintBase64Url(key.n), e: uintBase64Url(key.e) };
}

export async function accountThumbprint(privateKeyPem: string): Promise<string> {
  const jwk = accountJwk(privateKeyPem);
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return toBase64Url(String.fromCharCode(...new Uint8Array(digest)));
}

export async function dns01Value(privateKeyPem: string, token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) throw new AppError(502, 'ACME challenge token 格式无效', 'ACME_CHALLENGE_INVALID');
  const authorization = `${token}.${await accountThumbprint(privateKeyPem)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authorization));
  return toBase64Url(String.fromCharCode(...new Uint8Array(digest)));
}

export function createCertificateKeyAndCsr(domains: string[]): { privateKey: string; csrDer: string; keySize: number } {
  if (domains.length < 1 || domains.length > 20) throw new AppError(400, '一次最多签发 20 个域名', 'INVALID_CERT_DOMAINS');
  const pair = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = pair.publicKey;
  csr.setSubject([{ name: 'commonName', value: domains[0]!.replace(/^\*\./, '') }]);
  csr.setAttributes([{
    name: 'extensionRequest',
    extensions: [{ name: 'subjectAltName', altNames: domains.map((value) => ({ type: 2, value })) }],
  }]);
  csr.sign(pair.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes();
  return { privateKey: forge.pki.privateKeyToPem(pair.privateKey), csrDer: toBase64Url(der), keySize: pair.privateKey.n.bitLength() };
}

export async function signAcmeJws(options: {
  privateKeyPem: string;
  nonce: string;
  url: string;
  payload: unknown;
  kid?: string;
}): Promise<{ protected: string; payload: string; signature: string }> {
  const key = forge.pki.privateKeyFromPem(options.privateKeyPem);
  const protectedHeader: Record<string, unknown> = { alg: 'RS256', nonce: options.nonce, url: options.url };
  if (options.kid) protectedHeader.kid = options.kid;
  else protectedHeader.jwk = accountJwk(options.privateKeyPem);
  const protected64 = toBase64Url(JSON.stringify(protectedHeader));
  const payload64 = options.payload === '' ? '' : toBase64Url(JSON.stringify(options.payload));
  const signingInput = `${protected64}.${payload64}`;
  const digest = forge.md.sha256.create();
  digest.update(signingInput, 'utf8');
  return {
    protected: protected64,
    payload: payload64,
    signature: toBase64Url(key.sign(digest)),
  };
}

export async function postAcmeJws(fetcher: typeof fetch, options: {
  environment: AcmeEnvironment;
  privateKeyPem: string;
  nonce: string;
  url: string;
  payload: unknown;
  kid?: string;
}): Promise<AcmeJwsResponse> {
  const url = validateAcmeUrl(options.environment, options.url);
  const jws = await signAcmeJws(options);
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/jose+json', Accept: 'application/json, application/pem-certificate-chain' },
    body: JSON.stringify(jws),
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) throw new AcmeProtocolError('ACME 重定向响应已拒绝', response.status);
  const { body, text } = await readResponse(response);
  const contentType = response.headers.get('content-type') ?? '';
  let problemType: string | null = null;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const type = (body as Record<string, unknown>).type;
    if (typeof type === 'string' && type.length <= 256) problemType = type;
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AcmeProtocolError(`ACME 请求失败（HTTP ${response.status}）`, response.status, problemType, response.headers.get('Replay-Nonce'));
  }
  return {
    status: response.status,
    replayNonce: response.headers.get('Replay-Nonce'),
    location: response.headers.get('Location'),
    contentType,
    body,
    text,
  };
}
