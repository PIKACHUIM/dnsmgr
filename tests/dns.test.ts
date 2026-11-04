import { describe, expect, it, vi } from 'vitest';
import { DnsError } from '../src/dns/types';
import { lookupDomainExpiration } from '../src/dns/expiration';
import { checkDnsRecordValue, lookupPublicDnsRecords } from '../src/dns/record-check';
import { createCloudflareProvider } from '../src/dns/providers/cloudflare';
import { createAliyunProvider } from '../src/dns/providers/aliyun';
import { createDnspodProvider } from '../src/dns/providers/dnspod';
import { createProvider, providerCatalog, providerMeta, validateProviderConfig } from '../src/dns/registry';

interface Call { url: string; init: RequestInit }

function fakeFetch(handler: (call: Call, body: Record<string, unknown> | null) => unknown) {
  const calls: Call[] = [];
  const implementation = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    const result = handler(call, body);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, implementation };
}

const zone = { id: 'zone-1', name: 'example.com', recordCount: 0 };

describe('Cloudflare provider', () => {
  it('maps paused and root names back to UI semantics', async () => {
    const { implementation, calls } = fakeFetch(() => ({
      success: true,
      result: [
        { id: 'r1', name: 'example.com', type: 'A', content: '1.1.1.1', ttl: 1, proxied: true, comment: null },
        { id: 'r2', name: 'www.example.com_pause', type: 'A', content: '2.2.2.2', ttl: 600, proxied: false },
        { id: 'r3', name: '__root___pause.example.com', type: 'TXT', content: 'verify', ttl: 600, proxied: false },
        { id: 'r4', name: '_sip._tcp.example.com', type: 'SRV', content: 'ignored', ttl: 600, proxied: false, data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.com' } },
      ],
      result_info: { total_count: 4 },
    }));
    const provider = createCloudflareProvider({ apikey: 'token' }, implementation);

    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.total).toBe(4);
    expect(page.items.map((item) => [item.name, item.status])).toEqual([
      ['@', 1], ['www', 0], ['@', 0], ['_sip._tcp', 1],
    ]);
    expect(page.items[3]!.value).toBe('10 5 5060 sip.example.com');
    expect(calls[0]!.url).toContain('/zones/zone-1/dns_records');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('writes fully qualified names and proxies only when requested', async () => {
    const { implementation, calls } = fakeFetch((call) => call.init.method === 'POST'
      ? { success: true, result: { id: 'new-1' } }
      : { success: true, result: { id: 'r1', name: 'www.example.com', type: 'A', content: '1.1.1.1', ttl: 600, proxied: false } });
    const provider = createCloudflareProvider({ apikey: 'token' }, implementation);

    const recordId = await provider.addRecord(zone, {
      name: 'www', type: 'A', value: '1.1.1.1', line: '1', ttl: 600, mx: null, weight: null, remark: 'note',
    });
    await provider.setRecordStatus(zone, 'r1', false);

    expect(recordId).toBe('new-1');
    const post = calls.find((call) => call.init.method === 'POST')!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({
      name: 'www.example.com', type: 'A', content: '1.1.1.1', proxied: true, comment: 'note',
    });
    const patch = calls.find((call) => call.init.method === 'PATCH')!;
    expect(JSON.parse(String(patch.init.body))).toEqual({ name: 'www.example.com_pause' });
  });

  it('surfaces provider errors instead of returning success', async () => {
    const failing = (async () => new Response(JSON.stringify({
      success: false, errors: [{ message: 'Invalid API Token' }], result: null,
    }), { status: 200 })) as typeof fetch;
    await expect(createCloudflareProvider({ apikey: 'bad' }, failing).check()).rejects.toThrow('Invalid API Token');
  });
});

describe('Aliyun provider', () => {
  it('signs RPC requests and maps record fields', async () => {
    const { implementation, calls } = fakeFetch((_call, _body) => ({
      TotalCount: 1,
      DomainRecords: { Record: [{ RecordId: '100', RR: 'www', Type: 'A', Value: '3.3.3.3', Line: 'default', TTL: 600, Status: 'ENABLE', Remark: 'web' }] },
    }));
    const provider = createAliyunProvider({ AccessKeyId: 'ak', AccessKeySecret: 'sk' }, implementation);

    const page = await provider.listRecords({ id: '', name: 'example.com', recordCount: 0 }, { page: 2, pageSize: 10, name: 'www' });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('Action')).toBe('DescribeDomainRecords');
    expect(url.searchParams.get('DomainName')).toBe('example.com');
    expect(url.searchParams.get('PageNumber')).toBe('2');
    expect(url.searchParams.get('Signature')).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(url.searchParams.get('SignatureMethod')).toBe('HMAC-SHA1');
    expect(page.items[0]!).toMatchObject({ id: '100', name: 'www', value: '3.3.3.3', status: 1, remark: 'web' });
  });

  it('rejects when the platform returns an error code', async () => {
    const failing = (async () => new Response(JSON.stringify({
      Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.',
    }), { status: 404 })) as typeof fetch;
    await expect(createAliyunProvider({ AccessKeyId: 'ak', AccessKeySecret: 'sk' }, failing).check())
      .rejects.toThrow('Specified access key is not found.');
  });
});

describe('DNSPod provider', () => {
  it('sends TC3 authorization and maps records', async () => {
    const { implementation, calls } = fakeFetch(() => ({
      Response: {
        RequestId: 'req-1',
        RecordCountInfo: { TotalCount: 1 },
        RecordList: [{ RecordId: 9, Name: 'www', Type: 'CNAME', Value: 'target.example.com', Line: '默认', LineId: '0', TTL: 600, Status: 'DISABLE', Remark: 'x' }],
      },
    }));
    const provider = createDnspodProvider({ SecretId: 'id', SecretKey: 'key' }, implementation);

    const page = await provider.listRecords({ id: '', name: 'example.com', recordCount: 0 }, { page: 1, pageSize: 20 });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=id\/\d{4}-\d{2}-\d{2}\/dnspod\/tc3_request/);
    expect(headers['X-TC-Action']).toBe('DescribeRecordList');
    expect(page.items[0]!).toMatchObject({ id: '9', type: 'CNAME', status: 0, line: '0' });
  });

  it('maps Response.Error to DnsError', async () => {
    const failing = (async () => new Response(JSON.stringify({
      Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'SecretId 不存在' } },
    }), { status: 200 })) as typeof fetch;
    await expect(createDnspodProvider({ SecretId: 'id', SecretKey: 'key' }, failing).check())
      .rejects.toBeInstanceOf(DnsError);
  });
});

describe('domain expiration lookup', () => {
  it('resolves the TLD through the IANA bootstrap and parses the RDAP expiration event', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const payload = url.hostname === 'data.iana.org'
        ? { services: [[['com'], ['https://rdap.verisign.com/com/v1/']]] }
        : { events: [{ eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await expect(lookupDomainExpiration('Example.COM', fetchImpl)).resolves.toBe(1_893_456_000);
    expect(calls).toEqual([
      'https://data.iana.org/rdap/dns.json',
      'https://rdap.verisign.com/com/v1/domain/example.com',
    ]);
  });

  it('uses the longest matching RDAP bootstrap suffix', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const payload = url.hostname === 'data.iana.org'
        ? { services: [
          [['uk'], ['https://rdap.registry.uk/']],
          [['co.uk'], ['https://rdap.registry.uk/co/']],
        ] }
        : { events: [{ eventAction: 'expiration', eventDate: '2031-02-03T00:00:00Z' }] };
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    await expect(lookupDomainExpiration('example.co.uk', fetchImpl)).resolves.toBe(1_927_843_200);
    expect(calls[1]).toBe('https://rdap.registry.uk/co/domain/example.co.uk');
  });

  it('rejects insecure bootstrap endpoints and responses without an expiration event', async () => {
    const insecure = vi.fn(async () => new Response(JSON.stringify({
      services: [[['com'], ['http://127.0.0.1/']]],
    }), { status: 200 }));
    await expect(lookupDomainExpiration('example.com', insecure as typeof fetch)).rejects.toMatchObject({ reason: 'RDAP_UNSUPPORTED_TLD' });
    expect(insecure).toHaveBeenCalledTimes(1);

    const missingDate = vi.fn(async (input: RequestInfo | URL) => {
      const payload = new URL(String(input)).hostname === 'data.iana.org'
        ? { services: [[['com'], ['https://rdap.verisign.com/com/v1/']]] }
        : { events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    await expect(lookupDomainExpiration('example.com', missingDate as typeof fetch)).rejects.toMatchObject({ reason: 'RDAP_EXPIRATION_MISSING' });
  });
});

describe('public DNS record checks', () => {
  it('uses the fixed DoH resolver and queries the validated hostname and record type', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('dns.alidns.com');
      expect(url.searchParams.get('name')).toBe('www.example.com');
      expect(url.searchParams.get('type')).toBe('1');
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] }), { status: 200 });
    });

    await expect(lookupPublicDnsRecords('www.example.com', 'A', fetchImpl)).resolves.toEqual(['1.1.1.1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('normalizes DNS names, MX priority, TXT quotes and equivalent IP forms', () => {
    expect(checkDnsRecordValue('MAIL.Example.COM.', ['10 mail.example.com.'], 'MX').status).toBe('active');
    expect(checkDnsRecordValue('v=spf1 include:example.com', ['"v=spf1 include:example.com"'], 'TXT').status).toBe('active');
    expect(checkDnsRecordValue('001.001.001.001', ['1.1.1.1'], 'A').status).toBe('active');
    expect(checkDnsRecordValue('2001:0db8:0:0:0:0:0:1', ['2001:db8::1'], 'AAAA').status).toBe('active');
    expect(checkDnsRecordValue('target.example.com', ['wrong.example.com.'], 'CNAME')).toEqual({
      status: 'mismatch', actual: ['wrong.example.com'], expected: 'target.example.com',
    });
    expect(checkDnsRecordValue('1.1.1.1', [], 'A')).toEqual({ status: 'not_found', actual: [] });
  });

  it('rejects invalid query names and reports resolver errors instead of not_found', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ Status: 2 }), { status: 200 }));
    await expect(lookupPublicDnsRecords('bad name.example.com', 'A', fetchImpl as typeof fetch))
      .rejects.toMatchObject({ reason: 'INVALID_DNS_QUERY_NAME' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(lookupPublicDnsRecords('www.example.com', 'A', fetchImpl as typeof fetch))
      .rejects.toMatchObject({ reason: 'DNS_LOOKUP_FAILED' });
  });
});

describe('provider registry', () => {
  it('advertises every ported driver and rejects unknown ones', () => {
    expect(providerMeta('cloudflare').supported).toBe(true);
    expect(providerCatalog().unported).toEqual([]);
    for (const type of [
      'aliyun', 'aliyunesa', 'aws', 'baidu', 'bt', 'cloudflare', 'dnsla', 'dnsmgr', 'dnspod', 'dynv6',
      'goedge', 'henet', 'huawei', 'huoshan', 'jdcloud', 'namesilo', 'powerdns', 'qingcloud', 'spaceship',
      'technitium', 'tencenteo', 'west',
    ]) {
      expect(providerMeta(type).supported).toBe(true);
    }
    expect(() => providerMeta('nope')).toThrow(/未知/);
    expect(() => createProvider('nope', {})).toThrow(/未知/);
    expect(() => validateProviderConfig('aliyun', { AccessKeyId: 'ak' })).toThrow(/AccessKeySecret/);
  });

  it('requires the documented fields for non-AK/SK drivers', () => {
    expect(() => validateProviderConfig('goedge', { base_url: 'https://x' })).toThrow(/AccessKey ID/);
    expect(() => validateProviderConfig('powerdns', { ip: '127.0.0.1', port: '8081' })).toThrow(/API Key/);
    expect(validateProviderConfig('dynv6', { token: 't' })).toEqual({ token: 't' });
  });
});
