import { RECORD_TYPES } from '../../src/dns/types';
import type { DnsLine, DnsRecordInput } from '../../src/dns/types';

export interface ParsedDnsImportRecord extends DnsRecordInput {
  lineDescription: string;
  lineName: string;
  lineFallback: boolean;
  errors: string[];
}

const LINE_ALIASES = new Map<string, string>([
  ['全网默认', '默认'], ['默认线路', '默认'], ['Default', '默认'], ['default', '默认'],
  ['中国地区', '境内'], ['中国大陆', '境内'], ['中国内地', '境内'],
  ['海外', '境外'], ['海外线路', '境外'], ['Worldwide', '境外'],
  ['全球(不含中国内地)', '境外'], ['港澳台及海外', '境外'], ['搜索引擎线路', '搜索引擎'],
  ['电信通/长宽', '长城宽带'], ['方正', '方正宽带'], ['华数', '华数宽带'],
  ['中国港澳台', '港澳台地区'], ['东非洲地区', '东非地区'], ['南非洲地区', '南非地区'],
  ['西非洲地区', '西非地区'], ['北非洲地区', '北非地区'], ['中非洲地区', '中非地区'],
  ['亚太地区', '亚洲'], ['North America', '北美洲'], ['South America', '南美洲'],
  ['Europe', '欧洲'], ['Asia', '亚洲'], ['Oceania', '大洋洲'], ['Africa', '非洲'],
]);

const LINE_PREFIXES = [
  '中国地区_', '中国大陆_', '中国_', '东北_', '华东_', '华中_', '华南_', '西北_', '西南_',
  '非洲_', '亚洲_', '欧洲_', '北美洲_', '南美洲_', '大洋洲_', '全球_',
];
const CARRIERS = ['移动', '联通', '电信', '教育网', '广电', '铁通', '鹏博士', '科技网'];

function normalizeText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeLineText(value: unknown): string {
  return normalizeText(value)
    .replace(/\s+/g, '')
    .replace(/[＿－—–-]/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function canonicalLineName(value: unknown): string {
  let name = normalizeLineText(value);
  const directAlias = LINE_ALIASES.get(name);
  if (directAlias) return directAlias;
  name = name.replace(/(东北|华东|华中|华南|西北|西南)地区/g, '$1');
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of LINE_PREFIXES) {
      if (!name.startsWith(prefix)) continue;
      name = name.slice(prefix.length);
      changed = true;
      break;
    }
  }
  name = name.replace(/中国(移动|联通|电信|教育网|广电|铁通|鹏博士|科技网)/g, '$1');
  for (const carrier of CARRIERS) {
    if (name !== carrier && name.endsWith(carrier)) {
      name = `${carrier}_${name.slice(0, -carrier.length).replace(/_+$/g, '')}`;
      break;
    }
  }
  name = normalizeLineText(name);
  return LINE_ALIASES.get(name) ?? name;
}

function column(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return normalizeText(row[name]);
  }
  return '';
}

function createLineMatcher(lines: DnsLine[] | null) {
  const available = lines ?? [];
  let fallback: DnsLine = available.find((line) => line.id === 'default')
    ?? available[0]
    ?? { id: 'default', name: '默认', parent: null };
  const byName = new Map<string, DnsLine>();
  for (const line of available) {
    const key = canonicalLineName(line.name);
    if (key && !byName.has(key)) byName.set(key, line);
    if (key === '默认') fallback = line;
  }
  return (description: string) => {
    const requested = canonicalLineName(description);
    const matched = byName.get(requested) ?? fallback;
    return {
      id: matched.id,
      name: normalizeText(matched.name),
      fallback: Boolean(requested && matched === fallback && requested !== canonicalLineName(matched.name)),
    };
  };
}

export function parseDnsImportRows(
  sourceRows: unknown[],
  lines: DnsLine[] | null,
  minTtl: number | null,
): ParsedDnsImportRecord[] {
  const minimumTtl = Number.isSafeInteger(minTtl) && minTtl! > 0 ? minTtl! : 1;
  const matchLine = createLineMatcher(lines);
  const records: ParsedDnsImportRecord[] = [];
  for (const source of sourceRows) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const row = source as Record<string, unknown>;
    const name = column(row, ['主机记录', '主机名', 'Name', 'name']);
    let type = column(row, ['记录类型', '类型', 'Type', 'type']).toUpperCase();
    const lineDescription = column(row, ['线路类型', '线路', 'LineName', 'line']);
    let value = column(row, ['记录值', 'Value', 'value']);
    const ttlText = column(row, ['TTL', 'ttl']);
    const weightText = column(row, ['权重', 'Weight', 'weight']);
    const remark = column(row, ['备注', 'Remark', 'remark']);
    if (!name && !type && !lineDescription && !value && !ttlText && !weightText) continue;
    if ((type === 'NS' || type === 'SOA') && name === '@') continue;
    if (type === '显性URL') type = 'REDIRECT_URL';
    if (type === '隐性URL') type = 'FORWARD_URL';

    let mx = 1;
    if (type === 'MX') {
      const mxMatch = /^(.*)\s+\|\s+(\d+)$/.exec(value);
      if (mxMatch) {
        value = mxMatch[1]!.trim();
        mx = Number.parseInt(mxMatch[2]!, 10);
      }
    }
    let ttl = ttlText === '' ? Math.max(600, minimumTtl) : Number.parseInt(ttlText, 10);
    if (Number.isFinite(ttl) && ttl < minimumTtl) ttl = minimumTtl;
    const parsedWeight = weightText === '' ? 0 : Number.parseInt(weightText, 10);
    const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0;
    const matchedLine = matchLine(lineDescription);
    const errors: string[] = [];
    if (!name) errors.push('主机记录为空');
    else if (name.length > 128) errors.push('主机记录最多 128 字');
    if (!type) errors.push('记录类型为空');
    else if (!(RECORD_TYPES as readonly string[]).includes(type)) errors.push('不支持的记录类型');
    if (!value) errors.push('记录值为空');
    else if (value.length > 2048) errors.push('记录值最多 2048 字');
    if (!Number.isInteger(ttl)) errors.push('TTL格式错误');
    else if (ttl < 1 || ttl > 86400) errors.push('TTL 必须在 1–86400 之间');
    if (!Number.isSafeInteger(mx) || mx < 0 || mx > 65535) errors.push('MX 优先级无效');
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > 65535) errors.push('权重无效');
    if (remark.length > 100) errors.push('备注最多 100 字');
    records.push({
      name, type, value, line: matchedLine.id, ttl, mx, weight, remark: remark || null,
      lineDescription: lineDescription || '默认', lineName: matchedLine.name,
      lineFallback: matchedLine.fallback, errors,
    });
  }
  return records;
}
