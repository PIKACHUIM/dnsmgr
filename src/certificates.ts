import forge from 'node-forge';
import { AppError } from './core/errors';

const maxCertificates = 10;
const maxFullchainBytes = 48 * 1024;
const maxPrivateKeyBytes = 16 * 1024;
const domainPattern = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** 旧签名 `POST /api/cert/order` 沿用 PHP 的固定密码，既有自动化依赖该行为；面板下载改用随机密码。 */
export const legacyPfxPassword = '123456';
const pfxPasswordAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export interface InspectedCertificate {
  domains: string[];
  issuer: string;
  keySize: number;
  issuedAt: number;
  expiresAt: number;
}

interface ParsedCertificateMaterial extends InspectedCertificate {
  certificates: forge.pki.Certificate[];
  privateKey: forge.pki.rsa.PrivateKey;
}

export function normalizeCertificateDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new AppError(400, '一次需提交 1–20 个证书域名', 'INVALID_CERT_DOMAINS');
  }
  const domains = value.map((entry) => {
    if (typeof entry !== 'string') throw new AppError(400, '证书域名格式无效', 'INVALID_CERT_DOMAINS');
    const domain = entry.trim().toLowerCase().replace(/\.$/, '');
    if (!domainPattern.test(domain)) throw new AppError(400, '仅支持有效的 ASCII DNS 域名和单层通配符', 'INVALID_CERT_DOMAINS');
    return domain;
  });
  if (new Set(domains).size !== domains.length) throw new AppError(400, '证书域名不能重复', 'INVALID_CERT_DOMAINS');
  return domains;
}

function parseMaterial(fullchain: string, privateKeyPem: string): ParsedCertificateMaterial {
  if (new TextEncoder().encode(fullchain).length > maxFullchainBytes || new TextEncoder().encode(privateKeyPem).length > maxPrivateKeyBytes) {
    throw new AppError(413, '证书链或私钥文件超过允许大小', 'CERTIFICATE_MATERIAL_TOO_LARGE');
  }
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const blocks = fullchain.match(pattern);
  if (!blocks?.length || blocks.length > maxCertificates || fullchain.replace(pattern, '').trim()) {
    throw new AppError(400, '证书链 PEM 格式无效', 'INVALID_CERTIFICATE');
  }

  let certificates: forge.pki.Certificate[];
  let privateKey: forge.pki.rsa.PrivateKey;
  try {
    certificates = blocks.map((pem) => forge.pki.certificateFromPem(pem));
    privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  } catch {
    throw new AppError(400, '仅支持有效的 X.509 PEM 证书链和未加密 RSA PEM 私钥', 'INVALID_CERTIFICATE_MATERIAL');
  }

  const leaf = certificates[0]!;
  const publicKey = leaf.publicKey as forge.pki.rsa.PublicKey;
  if (!publicKey.n || !publicKey.e || publicKey.n.compareTo(privateKey.n) !== 0 || publicKey.e.compareTo(privateKey.e) !== 0) {
    throw new AppError(400, '证书与私钥不匹配', 'CERTIFICATE_KEY_MISMATCH');
  }
  const keySize = privateKey.n.bitLength();
  if (keySize < 2048) throw new AppError(400, 'RSA 私钥至少需要 2048 位', 'WEAK_CERTIFICATE_KEY');

  const subjectAltName = leaf.getExtension('subjectAltName') as { altNames?: { type?: number; value?: unknown }[] } | undefined;
  const names = (subjectAltName?.altNames ?? [])
    .filter((entry) => entry.type === 2 && typeof entry.value === 'string')
    .map((entry) => (entry.value as string).toLowerCase().replace(/\.$/, ''));
  if (names.length === 0) {
    const commonName = leaf.subject.getField('CN')?.value;
    if (typeof commonName === 'string') names.push(commonName.toLowerCase().replace(/\.$/, ''));
  }
  const domains = [...new Set(names.filter((name) => domainPattern.test(name)))].slice(0, 100);
  if (domains.length === 0) throw new AppError(400, '证书没有可用的 DNS 主机名', 'CERTIFICATE_DOMAINS_MISSING');

  const issuer = leaf.issuer.getField('CN')?.value;
  return {
    certificates,
    privateKey,
    domains,
    issuer: typeof issuer === 'string' && issuer.trim() ? issuer.trim().slice(0, 255) : '未知 CA',
    keySize,
    issuedAt: Math.floor(leaf.validity.notBefore.getTime() / 1000),
    expiresAt: Math.floor(leaf.validity.notAfter.getTime() / 1000),
  };
}

export function inspectCertificate(fullchain: string, privateKeyPem: string): InspectedCertificate {
  const { domains, issuer, keySize, issuedAt, expiresAt } = parseMaterial(fullchain, privateKeyPem);
  return { domains, issuer, keySize, issuedAt, expiresAt };
}

function buildPkcs12(fullchain: string, privateKeyPem: string, password: string): string {
  try {
    const material = parseMaterial(fullchain, privateKeyPem);
    const pfx = forge.pkcs12.toPkcs12Asn1(
      material.privateKey,
      material.certificates,
      password,
      { algorithm: '3des', count: 2048 },
    );
    return forge.asn1.toDer(pfx).getBytes();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'PFX 文件生成失败', 'CERT_PFX_FAILED');
  }
}

/** 生成每次下载都不同的 PFX 密码；去掉易混淆字符，并用拒绝采样避免取模偏差。 */
export function randomPfxPassword(length = 16): string {
  const characters: string[] = [];
  while (characters.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte >= 224) continue;
      characters.push(pfxPasswordAlphabet[byte % pfxPasswordAlphabet.length]!);
      if (characters.length === length) break;
    }
  }
  return characters.join('');
}

export function pfxBytes(fullchain: string, privateKeyPem: string, password: string): Uint8Array {
  if (!password) throw new AppError(500, 'PFX 密码不能为空', 'CERT_PFX_PASSWORD_MISSING');
  return Uint8Array.from(buildPkcs12(fullchain, privateKeyPem, password), (character) => character.charCodeAt(0));
}

export function exportLegacyPfx(fullchain: string, privateKeyPem: string): string {
  return forge.util.encode64(buildPkcs12(fullchain, privateKeyPem, legacyPfxPassword));
}

export function legacyPfxBytes(fullchain: string, privateKeyPem: string): Uint8Array {
  return pfxBytes(fullchain, privateKeyPem, legacyPfxPassword);
}

export function certificateDerBase64Url(fullchain: string): string {
  const block = fullchain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
  if (!block) throw new AppError(400, '证书链 PEM 格式无效', 'INVALID_CERTIFICATE');
  try {
    const certificate = forge.pki.certificateFromPem(block);
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
    return forge.util.encode64(der).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
  } catch {
    throw new AppError(400, '证书链 PEM 格式无效', 'INVALID_CERTIFICATE');
  }
}
