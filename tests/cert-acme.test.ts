import { describe, expect, it } from 'vitest';
import forge from 'node-forge';
import {
  accountJwk, accountThumbprint, createAcmeAccountKey, createCertificateKeyAndCsr,
  dns01Value, loadAcmeDirectory, signAcmeJws, validateAcmeUrl,
} from '../src/certificates/acme';

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return forge.util.decode64(base64);
}

describe('ACME cryptographic helpers', () => {
  it('creates an RSA account JWK and an RFC 7638 thumbprint', async () => {
    const privateKey = createAcmeAccountKey();
    const jwk = accountJwk(privateKey);
    expect(jwk).toMatchObject({ kty: 'RSA' });
    expect(jwk.n.length).toBeGreaterThan(300);
    expect(jwk.e).toBe('AQAB');
    expect(await accountThumbprint(privateKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('signs ACME JWS with RS256 and represents POST-as-GET with an empty payload', async () => {
    const privateKeyPem = createAcmeAccountKey();
    const key = forge.pki.privateKeyFromPem(privateKeyPem);
    const signed = await signAcmeJws({
      privateKeyPem, nonce: 'test-replay-nonce', url: 'https://acme-staging-v02.api.letsencrypt.org/acme/new-order',
      payload: '', kid: 'https://acme-staging-v02.api.letsencrypt.org/acme/acct/123',
    });
    const protectedHeader = JSON.parse(decodeBase64Url(signed.protected)) as Record<string, unknown>;
    expect(protectedHeader).toMatchObject({
      alg: 'RS256', nonce: 'test-replay-nonce',
      kid: 'https://acme-staging-v02.api.letsencrypt.org/acme/acct/123',
    });
    expect(signed.payload).toBe('');
    const digest = forge.md.sha256.create();
    digest.update(`${signed.protected}.`, 'utf8');
    const signature = forge.util.createBuffer(decodeBase64Url(signed.signature)).getBytes();
    expect(forge.pki.rsa.setPublicKey(key.n, key.e).verify(digest.digest().bytes(), signature)).toBe(true);
  });

  it('creates an RSA CSR with the requested DNS identifiers', () => {
    const generated = createCertificateKeyAndCsr(['example.test', '*.example.test']);
    expect(generated.keySize).toBe(2048);
    expect(generated.privateKey).toContain('BEGIN RSA PRIVATE KEY');
    const base64 = generated.csrDer.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - generated.csrDer.length % 4) % 4);
    const csr = forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(forge.util.decode64(base64)));
    expect(csr.verify()).toBe(true);
    const extensionRequest = csr.attributes.find((attribute) => attribute.name === 'extensionRequest');
    expect(extensionRequest?.extensions?.find((extension: { name?: string }) => extension.name === 'subjectAltName')?.altNames)
      .toEqual([{ type: 2, value: 'example.test' }, { type: 2, value: '*.example.test' }]);
  });

  it('computes DNS-01 value from the ACME key authorization', async () => {
    const privateKey = createAcmeAccountKey();
    const token = 'Y0g2sFx_7u1Q';
    const thumbprint = await accountThumbprint(privateKey);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${token}.${thumbprint}`));
    const expected = forge.util.encode64(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
    expect(await dns01Value(privateKey, token)).toBe(expected);
  });

  it('fetches and validates only the configured ACME origin', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      newNonce: 'https://acme-staging-v02.api.letsencrypt.org/acme/new-nonce',
      newAccount: 'https://acme-staging-v02.api.letsencrypt.org/acme/new-account',
      newOrder: 'https://acme-staging-v02.api.letsencrypt.org/acme/new-order',
      meta: { termsOfService: 'https://letsencrypt.org/repository/' },
    }), { headers: { 'content-type': 'application/json' } });
    const directory = await loadAcmeDirectory(fetcher as typeof fetch, 'staging');
    expect(directory.newOrder).toContain('/acme/new-order');
    expect(directory.meta?.termsOfService).toBe('https://letsencrypt.org/repository/');
    expect(() => validateAcmeUrl('staging', 'https://attacker.invalid/acme')).toThrow('超出允许的 CA 域名');
  });
});
