import forge from 'node-forge';
import { AppError } from './core/errors';

const maxCertificates = 10;
const maxFullchainBytes = 48 * 1024;
const maxPrivateKeyBytes = 16 * 1024;
const domainPattern = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const legacyPfxPassword = '123456';

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

export function exportLegacyPfx(fullchain: string, privateKeyPem: string): string {
  try {
    const material = parseMaterial(fullchain, privateKeyPem);
    const pfx = forge.pkcs12.toPkcs12Asn1(
      material.privateKey,
      material.certificates,
      legacyPfxPassword,
      { algorithm: '3des', count: 2048 },
    );
    return forge.util.encode64(forge.asn1.toDer(pfx).getBytes());
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'PFX 文件生成失败', 'CERT_PFX_FAILED');
  }
}

export function legacyPfxBytes(fullchain: string, privateKeyPem: string): Uint8Array {
  const encoded = exportLegacyPfx(fullchain, privateKeyPem);
  return Uint8Array.from(forge.util.decode64(encoded), (character) => character.charCodeAt(0));
}
