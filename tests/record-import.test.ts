import { describe, expect, it } from 'vitest';
import { parseDnsImportRows } from '../frontend/src/record-import';
import type { DnsLine } from '../src/dns/types';

const lines: DnsLine[] = [
  { id: 'default', name: '默认', parent: null },
  { id: 'telecom', name: '电信', parent: null },
];

describe('DNS record spreadsheet import', () => {
  it('maps legacy column aliases, MX priority, minimum TTL and line names', () => {
    const [record] = parseDnsImportRows([{
      主机记录: ' mail ',
      记录类型: 'mx',
      线路类型: '中国电信',
      记录值: 'mx.mail.example.com | 10',
      TTL: '300',
      权重: '2',
      备注: ' mail server ',
    }], lines, 600);

    expect(record).toMatchObject({
      name: 'mail', type: 'MX', value: 'mx.mail.example.com', line: 'telecom', ttl: 600,
      mx: 10, weight: 2, remark: 'mail server', lineDescription: '中国电信', lineName: '电信',
      lineFallback: false, errors: [],
    });
  });

  it('maps URL aliases and falls back unknown lines to the default', () => {
    const [record] = parseDnsImportRows([{
      Name: 'www', Type: '显性URL', line: 'Unlisted Line', Value: 'https://example.com',
    }], lines, null);

    expect(record).toMatchObject({
      name: 'www', type: 'REDIRECT_URL', line: 'default', ttl: 600, mx: 1, weight: 0,
      lineName: '默认', lineFallback: true, errors: [],
    });
  });

  it('skips blank and apex NS/SOA rows, while exposing row validation failures', () => {
    const records = parseDnsImportRows([
      { '主机记录': '', '记录类型': '', '记录值': '' },
      { '主机记录': '@', '记录类型': 'NS', '记录值': 'ns.example.com' },
      { '主机记录': 'bad', '记录类型': 'NOT_A_TYPE', '记录值': 'x', TTL: 'NaN' },
    ], lines, null);

    expect(records).toHaveLength(1);
    expect(records[0]!.errors).toEqual(['不支持的记录类型', 'TTL格式错误']);
  });
});
