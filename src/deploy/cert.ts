import forge from 'node-forge';

export interface DeployCertificateInfo {
  commonName: string;
  issuerCommonName: string;
  notBefore: number;
  notAfter: number;
  /** 十六进制序列号（对应 PHP 的 serialNumberHex）。 */
  serialNumber: string;
  fingerprintSha256: string;
}

/** 解析证书链中的第一张证书：CN、生效时间与 SHA-256 指纹（对应 PHP 的 openssl_* 调用）。 */
export function certificateInfo(fullchain: string): DeployCertificateInfo {
  let certificate: forge.pki.Certificate;
  try {
    certificate = forge.pki.certificateFromPem(fullchain);
  } catch {
    throw new Error('证书解析失败');
  }
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
  const fingerprintSha256 = forge.md.sha256.create().update(der).digest().toHex();
  return {
    commonName: String(certificate.subject.getField('CN')?.value ?? ''),
    issuerCommonName: String(certificate.issuer.getField('CN')?.value ?? ''),
    notBefore: Math.floor(certificate.validity.notBefore.getTime() / 1000),
    notAfter: Math.floor(certificate.validity.notAfter.getTime() / 1000),
    serialNumber: certificate.serialNumber,
    fingerprintSha256,
  };
}

/** PHP 里普遍使用的证书名：去掉通配符的 CN + 生效时间戳。 */
export function certificateName(fullchain: string): string {
  const info = certificateInfo(fullchain);
  return `${info.commonName.replace(/^\*\./, '')}-${info.notBefore}`;
}
