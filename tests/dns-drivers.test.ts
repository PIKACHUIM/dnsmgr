import { describe, expect, it } from 'vitest';
import { DnsError } from '../src/dns/types';
import { createAwsProvider } from '../src/dns/providers/aws';
import { createBaiduProvider } from '../src/dns/providers/baidu';
import { createBtProvider } from '../src/dns/providers/bt';
import { createDnslaProvider } from '../src/dns/providers/dnsla';
import { createDnsmgrProvider } from '../src/dns/providers/dnsmgr';
import { createDynv6Provider } from '../src/dns/providers/dynv6';
import { createGoEdgeProvider } from '../src/dns/providers/goedge';
import { createHenetProvider } from '../src/dns/providers/henet';
import { createHuaweiProvider } from '../src/dns/providers/huawei';
import { createHuoshanProvider } from '../src/dns/providers/huoshan';
import { createJdcloudProvider } from '../src/dns/providers/jdcloud';
import { createNamesiloProvider } from '../src/dns/providers/namesilo';
import { createPowerDnsProvider } from '../src/dns/providers/powerdns';
import { createQingcloudProvider } from '../src/dns/providers/qingcloud';
import { createSpaceshipProvider } from '../src/dns/providers/spaceship';
import { createTechnitiumProvider } from '../src/dns/providers/technitium';
import { createTencentEoProvider } from '../src/dns/providers/tencenteo';
import { createWestProvider } from '../src/dns/providers/west';
import { createAliyunEsaProvider } from '../src/dns/providers/aliyunesa';
import { createDnspodProvider } from '../src/dns/providers/dnspod';

interface Call { url: string; init: RequestInit; body: string }

function fakeFetch(handler: (call: Call) => { body: unknown; status?: number; text?: boolean }) {
  const calls: Call[] = [];
  const implementation = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init, body: typeof init.body === 'string' ? init.body : '' };
    calls.push(call);
    const result = handler(call);
    const status = result.status ?? 200;
    if (result.text) return new Response(String(result.body), { status });
    return new Response(JSON.stringify(result.body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, implementation };
}

const zone = { id: 'zone-1', name: 'example.com', recordCount: 0 };
const input = { name: 'www', type: 'A', value: '1.1.1.1', line: 'default', ttl: 600, mx: null, weight: null, remark: null };

describe('AWS Route53 driver', () => {
  it('signs with SigV4 and parses XML record sets', async () => {
    const { calls, implementation } = fakeFetch((call) => {
      if (call.url.includes('/hostedzone?')) {
        return {
          text: true,
          body: '<ListHostedZonesResponse><HostedZones><HostedZone><Id>/hostedzone/Z1</Id><Name>example.com.</Name>'
            + '<ResourceRecordSetCount>2</ResourceRecordSetCount></HostedZone></HostedZones><IsTruncated>false</IsTruncated></ListHostedZonesResponse>',
        };
      }
      return {
        text: true,
        body: '<ListResourceRecordSetsResponse><ResourceRecordSets>'
          + '<ResourceRecordSet><Name>www.example.com.</Name><Type>A</Type><TTL>600</TTL>'
          + '<ResourceRecords><ResourceRecord><Value>1.1.1.1</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>'
          + '<ResourceRecordSet><Name>example.com.</Name><Type>MX</Type><TTL>300</TTL>'
          + '<ResourceRecords><ResourceRecord><Value>10 mail.example.com.</Value></ResourceRecord></ResourceRecords></ResourceRecordSet>'
          + '</ResourceRecordSets><IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>',
      };
    });
    const provider = createAwsProvider({ AccessKeyId: 'AK', SecretAccessKey: 'SK' }, implementation);

    const domains = await provider.listDomains({ page: 1, pageSize: 20 });
    expect(domains.items[0]).toMatchObject({ id: 'Z1', name: 'example.com', recordCount: 2 });
    expect(calls[0]!.init.headers).toMatchObject({ host: 'route53.amazonaws.com' });
    expect(String((calls[0]!.init.headers as Record<string, string>).Authorization))
      .toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/us-east-1\/route53\/aws4_request/);

    const page = await provider.listRecords({ ...zone, id: 'Z1' }, { page: 1, pageSize: 20 });
    expect(page.items).toEqual([
      expect.objectContaining({ name: 'www', type: 'A', value: '1.1.1.1', ttl: 600 }),
      expect.objectContaining({ name: '@', type: 'MX', value: 'mail.example.com', mx: 10 }),
    ]);
  });

  it('rejects unsupported status changes instead of silently succeeding', async () => {
    const provider = createAwsProvider({ AccessKeyId: 'AK', SecretAccessKey: 'SK' }, fakeFetch(() => ({ body: {} })).implementation);
    await expect(provider.setRecordStatus(zone, 'x', false)).rejects.toBeInstanceOf(DnsError);
  });
});

describe('Huawei drive', () => {
  it('signs with SDK-HMAC-SHA256 and maps absolute names', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: {
        recordsets: [{
          id: 'r1', name: 'www.example.com.', type: 'A', records: ['1.1.1.1'], line: 'default',
          ttl: 300, status: 'ACTIVE', weight: 0,
        }],
        metadata: { total_count: 1 },
      },
    }));
    const provider = createHuaweiProvider({ AccessKeyId: 'AK', SecretAccessKey: 'SK' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20, name: 'www' });
    expect(page.items[0]).toMatchObject({ name: 'www', type: 'A', value: '1.1.1.1' });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^SDK-HMAC-SHA256 Access=AK, SignedHeaders=/);
    expect(calls[0]!.url).toContain('name=www.example.com.');
  });
});

describe('Volcengine drive', () => {
  it('splits MX priority out of the record value', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: {
        ResponseMetadata: {},
        Result: {
          Records: [{ RecordID: 'r1', Host: '@', Type: 'MX', Value: '10 mail.example.com', Line: 'default', TTL: 600, Enable: true }],
          TotalCount: 1,
        },
      },
    }));
    const provider = createHuoshanProvider({ AccessKeyId: 'AK', SecretAccessKey: 'SK' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ name: '@', type: 'MX', value: 'mail.example.com', mx: 10 });
    expect(String((calls[0]!.init.headers as Record<string, string>).Authorization))
      .toMatch(/^HMAC-SHA256 Credential=AK\/\d{8}\/cn-north-1\/DNS\/request/);
  });
});

describe('JD Cloud drive', () => {
  it('posts JSON wrapped in req and uses the JDCLOUD2 algorithm', async () => {
    const { calls, implementation } = fakeFetch(() => ({ body: { result: { dataList: { id: 'r1' } } } }));
    const provider = createJdcloudProvider({ AccessKeyId: 'AK', AccessKeySecret: 'SK' }, implementation);
    expect(await provider.addRecord(zone, input)).toBe('r1');
    expect(JSON.parse(calls[0]!.body)).toEqual({ req: expect.objectContaining({ hostRecord: 'www', hostValue: '1.1.1.1' }) });
    expect(String((calls[0]!.init.headers as Record<string, string>).authorization)).toMatch(/^JDCLOUD2-HMAC-SHA256 Credential=AK\//);
  });
});

describe('Baidu Cloud drive', () => {
  it('signs with bce-auth-v1 and keeps description as remark', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: { records: [{ id: 'r1', rr: 'www', type: 'A', value: '1.1.1.1', line: 'default', ttl: 600, status: 'running', description: 'note' }] },
    }));
    const provider = createBaiduProvider({ AccessKeyId: 'AK', SecretAccessKey: 'SK' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ name: 'www', remark: 'note', status: 1 });
    expect(String((calls[0]!.init.headers as Record<string, string>).Authorization)).toMatch(/^bce-auth-v1\/AK\//);
  });
});

describe('Technitium drive', () => {
  it('locates records by list index and sends old/new fields on update', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: {
        status: 'ok', response: {
          records: [
            { name: 'www.example.com', type: 'A', ttl: 300, disabled: false, rData: { ipAddress: '1.1.1.1' } },
            { name: 'example.com', type: 'MX', ttl: 300, disabled: true, rData: { exchange: 'mail.example.com', preference: 10 } },
          ],
        },
      },
    }));
    const provider = createTechnitiumProvider({ url: 'https://dns.local', token: 't' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items.map((item) => [item.id, item.type, item.status])).toEqual([['0', 'A', 1], ['1', 'MX', 0]]);

    calls.length = 0;
    await provider.updateRecord(zone, '0', { ...input, value: '2.2.2.2' });
    const form = new URLSearchParams(calls[1]!.body);
    expect(form.get('domain')).toBe('www.example.com');
    expect(form.get('ipAddress')).toBe('1.1.1.1');
    expect(form.get('newIpAddress')).toBe('2.2.2.2');
  });
});

describe('PowerDNS drive', () => {
  it('replaces a rrset instead of editing individual records', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: { rrsets: [{ name: 'www.example.com.', type: 'A', ttl: 600, records: [{ content: '1.1.1.1', disabled: false }] }] },
    }));
    const provider = createPowerDnsProvider({ ip: '10.0.0.1', port: '8081', apikey: 'k' }, implementation);
    const page = await provider.listRecords({ ...zone, id: 'example.com.' }, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ id: '1_1', name: 'www', value: '1.1.1.1' });

    calls.length = 0;
    await provider.addRecord({ ...zone, id: 'example.com.' }, { ...input, value: '2.2.2.2' });
    const patch = JSON.parse(calls[1]!.body) as { rrsets: { changetype: string; name: string; records: { content: string }[] }[] };
    expect(patch.rrsets[0]).toMatchObject({ changetype: 'REPLACE', name: 'www.example.com' });
    expect(patch.rrsets[0]!.records).toEqual([
      { content: '1.1.1.1', disabled: false },
      { content: '2.2.2.2', disabled: false },
    ]);
  });
});

describe('Spaceship drive', () => {
  it('encodes the record identity into the record id', async () => {
    const { implementation } = fakeFetch(() => ({
      body: {
        items: [{ type: 'MX', name: '@', ttl: 600, exchange: 'mail.example.com', preference: 10 }],
        total: 1,
      },
    }));
    const provider = createSpaceshipProvider({ apikey: 'k', apisecret: 's' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ id: 'MX|@|mail.example.com|10', name: '@', mx: 10 });
  });
});

describe('West drive', () => {
  it('signs with md5 token and maps pause state', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: { result: 200, data: { items: [{ id: 'r1', item: 'www', type: 'A', value: '1.1.1.1', line: '', ttl: 600, level: 0, pause: 1 }], total: 1 } },
    }));
    const provider = createWestProvider({ username: 'u', api_password: 'p' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ name: 'www', status: 0, line: 'default' });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('token')).toMatch(/^[0-9a-f]{32}$/);
    expect(form.get('username')).toBe('u');
  });
});

describe('DNSLA drive', () => {
  it('maps numeric types both ways and sends basic auth', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: { code: 200, data: { results: [{ id: 'r1', host: 'www', type: 28, data: '::1', lineId: '0', ttl: 600, disable: false }], total: 1 } },
    }));
    const provider = createDnslaProvider({ apiid: 'id', apisecret: 'secret' }, implementation);
    const page = await provider.listRecords({ ...zone, id: '42' }, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ type: 'AAAA', line: 'default' });
    expect(String((calls[0]!.init.headers as Record<string, string>).Authorization)).toBe(`Basic ${btoa('id:secret')}`);
  });
});

describe('EdgeOne drive', () => {
  it('sends the Tencent TC3 action headers', async () => {
    const { calls, implementation } = fakeFetch(() => ({
      body: { Response: { DnsRecords: [{ RecordId: 'r1', Name: 'www.example.com', Type: 'A', Content: '1.1.1.1', Location: 'Default', TTL: 600, Status: 'enable', Weight: -1 }], TotalCount: 1 } },
    }));
    const provider = createTencentEoProvider({ SecretId: 'id', SecretKey: 'key' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ name: 'www', line: 'Default', weight: null });
    expect((calls[0]!.init.headers as Record<string, string>)['X-TC-Action']).toBe('DescribeDnsRecords');
  });
});

describe('dynv6 drive', () => {
  it('normalizes single-record responses to an array', async () => {
    const { implementation } = fakeFetch((call) => {
      if (call.url.endsWith('/zones/by-name/example.com')) return { body: { id: 7 } };
      return { body: { id: 1, name: 'www.example.com', type: 'A', data: '1.1.1.1' } };
    });
    const provider = createDynv6Provider({ token: 't' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ name: 'www', type: 'A', value: '1.1.1.1' });
  });
});

describe('NameSilo drive', () => {
  it('accepts reply code 300 and pages records locally', async () => {
    const { implementation } = fakeFetch(() => ({
      body: {
        reply: {
          code: 300,
          resource_record: [
            { record_id: '1', host: 'www', type: 'A', value: '1.1.1.1', ttl: '600' },
            { record_id: '2', host: 'mail', type: 'A', value: '2.2.2.2', ttl: '600' },
          ],
        },
      },
    }));
    const provider = createNamesiloProvider({ apikey: 'k' }, implementation);
    const page = await provider.listRecords(zone, { page: 2, pageSize: 1 });
    expect(page).toMatchObject({ total: 2, items: [expect.objectContaining({ id: '2', name: 'mail' })] });
  });
});

describe('QingCloud drive', () => {
  it('signs requests with QC-HMAC-SHA256', async () => {
    const { calls, implementation } = fakeFetch(() => ({ body: { code: 0, zones: [{ zone_name: 'example.com.' }], total_count: 1 } }));
    const provider = createQingcloudProvider({ access_key_id: 'id', secret_access_key: 'secret' }, implementation);
    const page = await provider.listDomains({ page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ name: 'example.com' });
    expect(String((calls[0]!.init.headers as Record<string, string>).Authorization)).toMatch(/^QC-HMAC-SHA256 id:/);
  });
});

describe('BT panel drive', () => {
  it('splits the domain id and sends the HMAC signature header', async () => {
    const { calls, implementation } = fakeFetch(() => ({ body: { code: 0, data: { data: [], count: 0 } } }));
    const provider = createBtProvider({ AccountID: '1', AccessKey: 'ak', SecretKey: 'sk' }, implementation);
    await provider.listRecords({ ...zone, id: '9|2' }, { page: 1, pageSize: 20 });
    const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(sent).toMatchObject({ domain_id: 9, domain_type: 2 });
    expect(String((calls[0]!.init.headers as Record<string, string>)['X-Signature'])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GoEdge drive', () => {
  it('exchanges an access token before the first API call', async () => {
    const { calls, implementation } = fakeFetch((call) => {
      if (call.url.endsWith('/APIAccessTokenService/getAPIAccessToken')) {
        return { body: { code: 200, data: { token: 'tok' } } };
      }
      return { body: { code: 200, data: { nsCluster: { id: 3 } } } };
    });
    const provider = createGoEdgeProvider({
      base_url: 'https://goedge.local', accessKeyId: 'id', accessKey: 'key', nsClusterId: '3',
    }, implementation);
    await provider.check();
    expect(calls).toHaveLength(2);
    expect((calls[1]!.init.headers as Record<string, string>)['X-Edge-Access-Token']).toBe('tok');
  });
});

describe('DNSMGR drive', () => {
  it('signs panel requests with md5(uid+timestamp+key)', async () => {
    const { calls, implementation } = fakeFetch(() => ({ body: { rows: [], total: 0 } }));
    const provider = createDnsmgrProvider({ base_url: 'https://panel.local', uid: '7', key: 'secret' }, implementation);
    await provider.listRecords({ ...zone, id: '3' }, { page: 1, pageSize: 20 });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('uid')).toBe('7');
    expect(form.get('sign')).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[0]!.url).toContain('/api/record/data/3');
  });
});

describe('Aliyun ESA drive', () => {
  it('maps A/AAAA and proxied lines', async () => {
    const { implementation } = fakeFetch(() => ({
      body: {
        TotalCount: 2,
        Records: [
          { RecordId: 'r1', RecordName: 'www.example.com', RecordType: 'A/AAAA', Data: { Value: '1.1.1.1' }, Proxied: false, Ttl: 600 },
          { RecordId: 'r2', RecordName: 'example.com', RecordType: 'A/AAAA', Data: { Value: '::1' }, Proxied: true, Ttl: 600 },
        ],
      },
    }));
    const provider = createAliyunEsaProvider({ AccessKeyId: 'ak', AccessKeySecret: 'sk' }, implementation);
    const page = await provider.listRecords(zone, { page: 1, pageSize: 20 });
    expect(page.items.map((item) => [item.name, item.type, item.line])).toEqual([['www', 'A', '0'], ['@', 'AAAA', '1']]);
  });
});

describe('HE.net drive', () => {
  it('parses the zone HTML and exposes records without status control', async () => {
    const html = '<table><tr class="dns_tr" id="row1"><td>1</td><td>r-1</td><td>www.example.com</td><td>A</td>'
      + '<td>600</td><td></td><td>1.1.1.1</td></tr></table>';
    const { implementation } = fakeFetch((call) => (call.body.includes('email=')
      ? { body: '<a href="?hosted_dns_zoneid=55">example.com</a>', text: true }
      : { body: html, text: true }));
    const provider = createHenetProvider({ username: 'u', password: 'p' }, implementation);
    const page = await provider.listRecords({ ...zone, id: '55' }, { page: 1, pageSize: 20 });
    expect(page.items[0]).toMatchObject({ id: 'r-1', name: 'www', type: 'A', value: '1.1.1.1', ttl: 600 });
    await expect(provider.setRecordStatus(zone, 'r-1', false)).rejects.toBeInstanceOf(DnsError);
  });
});

describe('URL forwarding types', () => {
  it('maps explicit and implicit redirects for DNSPod', async () => {
    const { calls, implementation } = fakeFetch(() => ({ body: { Response: { RecordId: 9 } } }));
    const provider = createDnspodProvider({ SecretId: 'id', SecretKey: 'key' }, implementation);
    await provider.addRecord(zone, { ...input, type: 'REDIRECT_URL', value: 'https://example.com' });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ RecordType: '显性URL', Value: 'https://example.com' });
    await provider.addRecord(zone, { ...input, type: 'FORWARD_URL', value: 'https://example.com' });
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ RecordType: '隐性URL' });
  });

  it('reads DNSLA URL rows as explicit or implicit based on dominant', async () => {
    const { implementation } = fakeFetch((call) => call.url.includes('recordList')
      ? { body: { code: 200, data: { results: [
        { id: 'r1', host: 'a', type: 256, data: 'https://a.example', lineId: '0', ttl: 600, dominant: true },
        { id: 'r2', host: 'b', type: 256, data: 'https://b.example', lineId: '0', ttl: 600, dominant: false },
      ], total: 2 } } }
      : { body: { code: 200, data: [] } });
    const provider = createDnslaProvider({ apiid: 'id', apisecret: 'secret' }, implementation);
    const page = await provider.listRecords({ ...zone, id: '42' }, { page: 1, pageSize: 20 });
    expect(page.items.map((item) => item.type)).toEqual(['REDIRECT_URL', 'FORWARD_URL']);
  });
});
