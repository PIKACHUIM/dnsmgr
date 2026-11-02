import { num } from '../http';
import {
  DnsError, type DnsDomain, type DnsLine, type DnsProvider, type DnsRecord,
  type DnsRecordInput, type PageResult, type RecordQuery,
} from '../types';
import { unsupported } from '../unsupported';

export interface HenetConfig {
  username: string;
  password: string;
}

const BASE = 'https://dns.he.net/';
const MIN_TTL = 300;

/** HE.net 只提供网页表单，这里按旧实现抓取并解析 HTML；不含官方 API。 */
export function createHenetProvider(config: HenetConfig, fetchImpl: typeof fetch = fetch): DnsProvider {
  let cookie = '';
  let loggedIn = false;

  function storeCookie(headers: Headers): void {
    const jar = new Map<string, string>();
    for (const pair of cookie.split('; ')) {
      const [name, value] = pair.split('=');
      if (name && value !== undefined) jar.set(name, value);
    }
    const header = headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof header.getSetCookie === 'function'
      ? header.getSetCookie()
      : (headers.get('set-cookie') ?? '').split(/,(?=[^;,\s]+=)/).filter(Boolean);
    for (const header of setCookies) {
      const [pair] = header.split(';');
      const [name, value] = (pair ?? '').split('=');
      if (name && value !== undefined) jar.set(name, value);
    }
    cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async function send(method: 'GET' | 'POST', path: string, params?: Record<string, string>): Promise<string> {
    const url = path.startsWith('http') ? path : `${BASE}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(params ? { body: new URLSearchParams(params).toString() } : {}),
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      throw new DnsError(`无法连接 HE.net（${error instanceof Error ? error.message : 'network'}）`, 502, 'DNS_UNREACHABLE');
    }
    storeCookie(response.headers);
    const html = await response.text();
    if (response.status >= 400) throw new DnsError(`HE.net 请求失败（HTTP ${response.status}）`, 502);
    return html;
  }

  function decodeEntities(value: string): string {
    return value
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/gi, '&');
  }

  function textOnly(html: string): string {
    return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  }

  function parseDomains(html: string): DnsDomain[] {
    const found = new Map<string, DnsDomain>();
    const patterns = [
      /onclick="delete_dom\(this\);"[^>]*name="([^"]+)"[^>]*value="(\d+)"/gi,
      /name="([^"]+)"[^>]*value="(\d+)"[^>]*onclick="delete_dom\(this\);"/gi,
    ];
    for (const pattern of patterns) {
      for (const match of html.matchAll(pattern)) {
        found.set(match[2]!, { id: match[2]!, name: decodeEntities(match[1]!), recordCount: 0 });
      }
    }
    for (const match of html.matchAll(/hosted_dns_zoneid=(\d+)[^"']*["'][^>]*>\s*([^<]+)\s*</gi)) {
      const id = match[1]!;
      const name = decodeEntities(match[2]!).trim();
      if (name && !found.has(id)) found.set(id, { id, name, recordCount: 0 });
    }
    return [...found.values()];
  }

  function parseRecords(html: string, domain: DnsDomain): DnsRecord[] {
    const records: DnsRecord[] = [];
    for (const row of html.matchAll(/<tr class="dns_tr" [^>]*>[\s\S]*?<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cell of (row[0] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
        cells.push(textOnly((cell[1] ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')));
      }
      if (cells.length < 4) continue;
      const type = (cells[3] ?? '').toUpperCase();
      const rawValue = cells[6] ?? '';
      records.push({
        id: cells[1] ?? '',
        name: fromFullName(cells[2] ?? '', domain.name),
        type,
        value: type === 'TXT' ? rawValue.replace(/^"|"$/g, '') : rawValue,
        line: 'default',
        ttl: num(cells[4], 0),
        mx: cells[5] !== undefined && /^\d+$/.test(cells[5]) ? num(cells[5]) : null,
        weight: null,
        remark: null,
        status: (row[0] ?? '').toLowerCase().includes('disabled') ? 0 : 1,
        updatedAt: null,
      });
    }
    return records;
  }

  function toFullName(name: string, domain: string): string {
    if (name === '@' || name === '') return domain;
    if (name.toLowerCase().endsWith(`.${domain.toLowerCase()}`)) return name;
    return `${name}.${domain}`;
  }

  function fromFullName(name: string, domain: string): string {
    const trimmed = name.replace(/\.$/, '');
    if (trimmed.toLowerCase() === domain.toLowerCase()) return '@';
    return trimmed.toLowerCase().endsWith(`.${domain.toLowerCase()}`)
      ? trimmed.slice(0, -domain.length - 1) : trimmed;
  }

  async function login(): Promise<void> {
    if (loggedIn) return;
    await send('GET', '');
    const html = await send('POST', '', { email: config.username, pass: config.password });
    if (/incorrect|invalid/i.test(html)) throw new DnsError('HE.net 登录失败，请检查用户名和密码', 401, 'DNS_AUTH_FAILED');
    if (parseDomains(html).length === 0 && !html.includes('hosted_dns_zoneid')) {
      throw new DnsError('HE.net 登录失败，未找到域名列表', 401, 'DNS_AUTH_FAILED');
    }
    loggedIn = true;
  }

  async function authorized(method: 'GET' | 'POST', path: string, params?: Record<string, string>): Promise<string> {
    await login();
    const html = await send(method, path, params);
    if (html.includes('name="email"') && html.includes('name="pass"') && !html.includes('hosted_dns_zoneid')) {
      loggedIn = false;
      cookie = '';
      await login();
      return send(method, path, params);
    }
    return html;
  }

  async function zoneId(domain: DnsDomain): Promise<string> {
    if (domain.id) return domain.id;
    const html = await authorized('GET', '');
    const found = parseDomains(html).find((item) => item.name.toLowerCase() === domain.name.toLowerCase());
    if (!found) throw new DnsError('域名不存在或无权限访问', 404, 'DNS_DOMAIN_NOT_FOUND');
    return found.id;
  }

  function messageOf(html: string): string | null {
    const block = html.match(/<(?:div|span)[^>]*class="[^"]*(?:error|warn|success|message)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
    if (block) return textOnly(block[1] ?? '');
    const inline = html.match(/(Successfully [^<]+|Error:[^<]+|Invalid [^<]+)/i);
    return inline ? textOnly(inline[1] ?? '') : null;
  }

  function recordParams(zone: string, recordId: string, domain: DnsDomain, input: DnsRecordInput, action: string): Record<string, string> {
    return {
      account: '',
      menu: 'edit_zone',
      Type: input.type.toUpperCase(),
      hosted_dns_zoneid: zone,
      hosted_dns_recordid: recordId,
      hosted_dns_editzone: '1',
      Priority: input.type === 'MX' ? String(input.mx ?? 10) : '',
      Name: toFullName(input.name, domain.name),
      Content: input.type === 'TXT' ? input.value.replace(/^"|"$/g, '') : input.value,
      TTL: String(input.ttl),
      hosted_dns_editrecord: action,
    };
  }

  return {
    type: 'henet',

    async check() {
      await login();
    },

    async listDomains(page): Promise<PageResult<DnsDomain>> {
      const html = await authorized('GET', '');
      let items = parseDomains(html);
      if (page.keyword) {
        const needle = page.keyword.toLowerCase();
        items = items.filter((item) => item.name.toLowerCase().includes(needle));
      }
      const start = (page.page - 1) * page.pageSize;
      return { total: items.length, items: items.slice(start, start + page.pageSize) };
    },

    async addDomain() {
      unsupported('在 HE.net 中添加域名');
    },

    async listRecords(domain, query: RecordQuery): Promise<PageResult<DnsRecord>> {
      const zone = await zoneId(domain);
      const html = await authorized('GET', `index.cgi?hosted_dns_zoneid=${zone}&menu=edit_zone&hosted_dns_editzone=`);
      let items = parseRecords(html, domain).filter((record) => {
        if (query.name && record.name.toLowerCase() !== query.name.toLowerCase()) return false;
        if (query.type && record.type !== query.type) return false;
        if (query.value && record.value !== query.value) return false;
        if (query.status && String(record.status) !== query.status) return false;
        if (query.keyword) {
          const needle = query.keyword.toLowerCase();
          if (!record.name.toLowerCase().includes(needle) && !record.value.toLowerCase().includes(needle)) return false;
        }
        return true;
      });
      const start = (query.page - 1) * query.pageSize;
      items = items.slice(start, start + query.pageSize);
      return { total: items.length, items };
    },

    async addRecord(domain, input: DnsRecordInput) {
      const zone = await zoneId(domain);
      const html = await authorized('POST', 'index.cgi', recordParams(zone, '', domain, input, 'Submit'));
      if (!html.includes('Successfully added new record')) {
        throw new DnsError(messageOf(html) ?? '添加解析记录失败', 502);
      }
      const created = parseRecords(html, domain).find((record) =>
        record.name === fromFullName(toFullName(input.name, domain.name), domain.name) &&
        record.type === input.type &&
        record.value === (input.type === 'TXT' ? input.value.replace(/^"|"$/g, '') : input.value));
      if (!created) throw new DnsError('记录已提交但未能重新定位，请刷新列表确认', 502, 'DNS_RECORD_ID_UNKNOWN');
      return created.id;
    },

    async updateRecord(domain, recordId, input) {
      const zone = await zoneId(domain);
      const html = await authorized('POST', 'index.cgi', recordParams(zone, recordId, domain, input, 'Update'));
      if (!html.includes('Successfully updated record')) throw new DnsError(messageOf(html) ?? '修改解析记录失败', 502);
    },

    async deleteRecord(domain, recordId) {
      const zone = await zoneId(domain);
      const html = await authorized('POST', 'index.cgi', {
        menu: 'edit_zone',
        hosted_dns_zoneid: zone,
        hosted_dns_recordid: recordId,
        hosted_dns_editzone: '1',
        hosted_dns_delrecord: '1',
        hosted_dns_delconfirm: 'delete',
      });
      if (!html.includes('Successfully removed record')) throw new DnsError(messageOf(html) ?? '删除解析记录失败', 502);
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
      return MIN_TTL;
    },
  };
}
