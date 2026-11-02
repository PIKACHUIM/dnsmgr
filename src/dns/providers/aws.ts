import { sendText } from '../http';
import { hexOf, hmacSha256Raw, percentEncode, sha256Hex } from '../sign';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface AwsConfig {
  AccessKeyId: string;
  SecretAccessKey: string;
}

const HOST = 'route53.amazonaws.com';
const REGION = 'us-east-1';
const SERVICE = 'route53';
const VERSION = '2013-04-01';
const SEP = '\u001e';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function blocks(xml: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const result: string[] = [];
  let cursor = 0;
  while (true) {
    const start = xml.indexOf(open, cursor);
    if (start < 0) break;
    const end = xml.indexOf(close, start + open.length);
    if (end < 0) break;
    result.push(xml.slice(start + open.length, end));
    cursor = end + close.length;
  }
  return result;
}

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? unescapeXml(match[1] ?? '') : null;
}

interface RecordSet {
  name: string;
  type: string;
  ttl: number;
  values: string[];
  alias: boolean;
  identifier: string | null;
}

export function createAwsProvider(config: AwsConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  async function request(method: 'GET' | 'POST', path: string, query: Record<string, string> = {}, body = ''): Promise<string> {
    const canonicalQuery = Object.keys(query).sort()
      .map((key) => `${percentEncode(key)}=${percentEncode(query[key] ?? '')}`).join('&');
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const shortDate = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host: HOST,
      'x-amz-date': amzDate,
      ...(body ? { 'content-type': 'application/xml' } : {}),
    };
    const signedKeys = Object.keys(headers).sort();
    const canonicalHeaders = `${signedKeys.map((key) => `${key}:${headers[key]}`).join('\n')}\n`;
    const signedHeaders = signedKeys.join(';');
    const canonicalRequest = [
      method, path, canonicalQuery, canonicalHeaders, signedHeaders, await sha256Hex(body),
    ].join('\n');
    const scope = `${shortDate}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const kDate = await hmacSha256Raw(new TextEncoder().encode(`AWS4${config.SecretAccessKey}`), shortDate);
    const kRegion = await hmacSha256Raw(kDate, REGION);
    const kService = await hmacSha256Raw(kRegion, SERVICE);
    const kSigning = await hmacSha256Raw(kService, 'aws4_request');
    const signature = hexOf(await hmacSha256Raw(kSigning, stringToSign));
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${config.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await sendText(fetchImpl, `https://${HOST}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`, {
      method, headers, ...(body ? { body } : {}),
    }, 20000);
    if (!response.ok) {
      const code = tag(response.text, 'Code');
      const message = tag(response.text, 'Message') ?? `AWS Route53 请求失败（HTTP ${response.status}）`;
      throw new DnsError(code ? `${code}: ${message}` : message, response.status === 401 || response.status === 403 ? 401 : 502);
    }
    return response.text;
  }

  function parseSets(xml: string): RecordSet[] {
    return blocks(xml, 'ResourceRecordSet').map((block) => ({
      name: tag(block, 'Name') ?? '',
      type: (tag(block, 'Type') ?? '').toUpperCase(),
      ttl: Number(tag(block, 'TTL') ?? 300) || 300,
      values: blocks(block, 'ResourceRecord').map((record) => tag(record, 'Value') ?? '').filter(Boolean),
      alias: block.includes('<AliasTarget>'),
      identifier: tag(block, 'SetIdentifier'),
    }));
  }

  const zoneOf = (domain: DnsDomain) => (domain.id || domain.name).replace(/^\/hostedzone\//, '');
  const zonePath = (domain: DnsDomain) => `/${VERSION}/hostedzone/${encodeURIComponent(zoneOf(domain))}/rrset`;

  async function pagedSets(domain: DnsDomain): Promise<RecordSet[]> {
    const all: RecordSet[] = [];
    let params: Record<string, string> = { maxitems: '300' };
    for (let guard = 0; guard < 20; guard++) {
      const xml = await request('GET', zonePath(domain), params);
      all.push(...parseSets(xml));
      if (tag(xml, 'IsTruncated') !== 'true') break;
      const nextName = tag(xml, 'NextRecordName');
      const nextType = tag(xml, 'NextRecordType');
      const nextId = tag(xml, 'NextRecordIdentifier');
      if (!nextName) break;
      params = { maxitems: '300', name: nextName, ...(nextType ? { type: nextType } : {}), ...(nextId ? { identifier: nextId } : {}) };
    }
    return all;
  }

  const fqdn = (name: string, domain: string) => (name === '@' || name === '' ? `${domain}.` : name.endsWith('.') ? name : `${name}.${domain}.`);

  const relative = (full: string, domain: string) => {
    const trimmed = full.replace(/\.$/, '');
    if (trimmed.toLowerCase() === domain.toLowerCase()) return '@';
    return trimmed.toLowerCase().endsWith(`.${domain.toLowerCase()}`)
      ? trimmed.slice(0, -domain.length - 1) : trimmed;
  };

  function encodeId(name: string, type: string, value: string): string {
    const bytes = new TextEncoder().encode(`${name}${SEP}${type}${SEP}${value}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeId(recordId: string): { name: string; type: string; value: string } {
    const binary = atob(recordId.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parts = new TextDecoder().decode(bytes).split(SEP);
    if (parts.length !== 3) throw new DnsError('记录编号格式无效，请刷新列表后重试', 400, 'INVALID_RECORD_ID');
    return { name: parts[0]!, type: parts[1]!, value: parts[2]! };
  }

  function formatValue(type: string, value: string, mx: number | null): string {
    if (type === 'TXT') return value.startsWith('"') ? value : `"${value}"`;
    if (type === 'MX') return `${mx ?? 10} ${value.replace(/\.$/, '')}.`;
    if (['CNAME', 'NS', 'PTR'].includes(type)) return `${value.replace(/\.$/, '')}.`;
    if (type === 'SRV') {
      const parts = value.trim().split(/\s+/);
      if (parts.length >= 4) parts[3] = `${parts[3]!.replace(/\.$/, '')}.`;
      return parts.join(' ');
    }
    return value;
  }

  function displayValue(type: string, raw: string): { value: string; mx: number | null } {
    if (type === 'TXT') {
      const quoted = raw.match(/^"([\s\S]*)"$/);
      if (quoted && !(quoted[1] ?? '').includes('" "')) return { value: (quoted[1] ?? '').replace(/\\"/g, '"'), mx: null };
      return { value: raw, mx: null };
    }
    if (type === 'MX') {
      const [priority, ...rest] = raw.split(' ');
      return { value: rest.join(' ').replace(/\.$/, ''), mx: Number(priority) || 0 };
    }
    if (['CNAME', 'NS', 'PTR'].includes(type)) return { value: raw.replace(/\.$/, ''), mx: null };
    if (type === 'SRV') {
      const parts = raw.trim().split(/\s+/);
      if (parts.length >= 4) parts[3] = parts[3]!.replace(/\.$/, '');
      return { value: parts.join(' '), mx: null };
    }
    return { value: raw, mx: null };
  }

  async function currentSet(domain: DnsDomain, name: string, type: string): Promise<RecordSet | null> {
    const xml = await request('GET', zonePath(domain), { name, type, maxitems: '1' });
    const set = parseSets(xml)[0];
    if (!set || set.name.replace(/\.$/, '').toLowerCase() !== name.replace(/\.$/, '').toLowerCase()) return null;
    if (set.type !== type || set.alias || set.identifier) return null;
    return set;
  }

  async function change(domain: DnsDomain, action: 'UPSERT' | 'DELETE', name: string, type: string, ttl: number, values: string[]): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>`
      + `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/${VERSION}/"><ChangeBatch><Changes>`
      + `<Change><Action>${action}</Action><ResourceRecordSet>`
      + `<Name>${escapeXml(name)}</Name><Type>${escapeXml(type)}</Type><TTL>${Math.trunc(ttl)}</TTL>`
      + `<ResourceRecords>${values.map((value) => `<ResourceRecord><Value>${escapeXml(value)}</Value></ResourceRecord>`).join('')}</ResourceRecords>`
      + `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
    await request('POST', zonePath(domain), {}, body);
  }

  async function addRecordImpl(domain: DnsDomain, input: DnsRecordInput): Promise<string> {
    const type = input.type === 'SPF' ? 'TXT' : input.type;
    const name = fqdn(input.name, domain.name);
    const raw = formatValue(type, input.value, input.mx);
    const set = await currentSet(domain, name, type);
    const values = set ? [...set.values] : [];
    if (values.includes(raw)) throw new DnsError('已存在相同记录', 409, 'DNS_RECORD_EXISTS');
    values.push(raw);
    await change(domain, 'UPSERT', name, type, input.ttl, values);
    return encodeId(relative(name, domain.name), type, raw);
  }

  async function deleteRecordImpl(domain: DnsDomain, recordId: string): Promise<void> {
    const old = decodeId(recordId);
    const name = fqdn(old.name, domain.name);
    const set = await currentSet(domain, name, old.type);
    if (!set) throw new DnsError('记录不存在', 404, 'DNS_RECORD_NOT_FOUND');
    const remaining = set.values.filter((value) => value !== old.value);
    if (remaining.length === set.values.length) throw new DnsError('记录不存在', 404, 'DNS_RECORD_NOT_FOUND');
    if (remaining.length === 0) await change(domain, 'DELETE', name, old.type, set.ttl, [old.value]);
    else await change(domain, 'UPSERT', name, old.type, set.ttl, remaining);
  }

  return {
    type: 'aws',

    async check() {
      await request('GET', `/${VERSION}/hostedzone`, { maxitems: '1' });
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const all: DnsDomain[] = [];
      let marker: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const xml = await request('GET', `/${VERSION}/hostedzone`, {
          maxitems: '100', ...(marker ? { marker } : {}),
        });
        for (const block of blocks(xml, 'HostedZone')) {
          const id = tag(block, 'Id')?.replace(/^\/hostedzone\//, '') ?? '';
          all.push({ id, name: (tag(block, 'Name') ?? '').replace(/\.$/, ''), recordCount: Number(tag(block, 'ResourceRecordSetCount') ?? 0) || 0 });
        }
        if (tag(xml, 'IsTruncated') !== 'true') break;
        marker = tag(xml, 'NextMarker') ?? undefined;
        if (!marker) break;
      }
      let items = all;
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      const start = (page.page - 1) * page.pageSize;
      return { total: items.length, items: items.slice(start, start + page.pageSize) };
    },

    async addDomain(name) {
      const body = `<?xml version="1.0" encoding="UTF-8"?><CreateHostedZoneRequest xmlns="https://route53.amazonaws.com/doc/${VERSION}/">`
        + `<Name>${escapeXml(name)}</Name><CallerReference>${escapeXml(`dnsmgr-${name}-${crypto.randomUUID()}`)}</CallerReference>`
        + `</CreateHostedZoneRequest>`;
      const xml = await request('POST', `/${VERSION}/hostedzone`, {}, body);
      const zone = blocks(xml, 'HostedZone')[0] ?? '';
      return {
        id: (tag(zone, 'Id') ?? '').replace(/^\/hostedzone\//, ''),
        name: (tag(zone, 'Name') ?? name).replace(/\.$/, ''),
        recordCount: 0,
      };
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const sets = (await pagedSets(domain))
        .filter((set) => !set.alias && !set.identifier && set.type !== 'SOA');
      const items: DnsRecord[] = [];
      for (const set of sets) {
        const name = relative(set.name, domain.name);
        for (const raw of set.values) {
          const { value, mx } = displayValue(set.type, raw);
          items.push({
            id: encodeId(name, set.type, raw),
            name,
            type: set.type,
            value,
            line: 'default',
            ttl: set.ttl,
            mx,
            weight: null,
            remark: null,
            status: 1,
            updatedAt: null,
          });
        }
      }
      const filtered = items.filter((record) => {
        if (query.name && record.name.toLowerCase() !== query.name.toLowerCase()) return false;
        if (query.type && record.type !== query.type) return false;
        if (query.value && record.value !== query.value) return false;
        if (query.keyword) {
          const needle = query.keyword.toLowerCase();
          if (!record.name.toLowerCase().includes(needle) && !record.value.toLowerCase().includes(needle)) return false;
        }
        return true;
      });
      const start = (query.page - 1) * query.pageSize;
      return { total: filtered.length, items: filtered.slice(start, start + query.pageSize) };
    },

    async addRecord(domain, input: DnsRecordInput) {
      return addRecordImpl(domain, input);
    },

    async updateRecord(domain, recordId, input) {
      const old = decodeId(recordId);
      const type = input.type === 'SPF' ? 'TXT' : input.type;
      const name = fqdn(input.name, domain.name);
      const raw = formatValue(type, input.value, input.mx);
      if (old.type === type && old.name.toLowerCase() === input.name.toLowerCase()) {
        const set = await currentSet(domain, name, type);
        const values = set ? [...set.values] : [];
        const index = values.indexOf(old.value);
        if (index >= 0) values[index] = raw;
        else values.push(raw);
        await change(domain, 'UPSERT', name, type, input.ttl, [...new Set(values)]);
        return;
      }
      await deleteRecordImpl(domain, recordId);
      await addRecordImpl(domain, input);
    },

    async deleteRecord(domain, recordId) {
      await deleteRecordImpl(domain, recordId);
    },

    async setRecordStatus() {
      unsupported('启用或停用解析记录');
    },

    async setRecordRemark() {
      unsupported('设置解析记录备注');
    },

    async recordLines(): Promise<DnsLine[] | null> {
      return [{ id: 'default', name: '默认', parent: null }];
    },

    async minTtl(): Promise<number | null> {
      return 60;
    },
  };
}
