import { describe, expect, it, vi } from 'vitest';
import { DnsError } from '../src/dns/types';
import { createCloudflareProvider } from '../src/dns/providers/cloudflare';
import { createAliyunProvider } from '../src/dns/providers/aliyun';
import { createDnspodProvider } from '../src/dns/providers/dnspod';
import { createProvider, providerMeta, validateProviderConfig } from '../src/dns/registry';

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

describe('provider registry', () => {
  it('only advertises drivers that are actually implemented', () => {
    expect(providerMeta('cloudflare').supported).toBe(true);
    expect(() => providerMeta('aws')).toThrow(/尚未移植/);
    expect(() => createProvider('baidu', {})).toThrow(/尚未移植/);
    expect(() => validateProviderConfig('aliyun', { AccessKeyId: 'ak' })).toThrow(/AccessKeySecret/);
  });
});
