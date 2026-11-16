export type LineGroup = 'DEF' | 'CT' | 'CU' | 'CM';

/**
 * 旧版 `DnsHelper::$line_name`：优选任务把数据源分组映射到各服务商的线路代码。
 * 空字符串表示该服务商的默认线路；未列出的分组表示服务商没有对应线路。
 */
export const GROUP_LINE_CODES: Record<string, Partial<Record<LineGroup, string>>> = {
  aliyun: { DEF: 'default', CT: 'telecom', CU: 'unicom', CM: 'mobile' },
  dnspod: { DEF: '0', CT: '10=0', CU: '10=1', CM: '10=3' },
  huawei: { DEF: 'default_view', CT: 'Dianxin', CU: 'Liantong', CM: 'Yidong' },
  west: { DEF: '', CT: 'LTEL', CU: 'LCNC', CM: 'LMOB' },
  dnsla: { DEF: '', CT: '84613316902921216', CU: '84613316923892736', CM: '84613316953252864' },
  huoshan: { DEF: 'default', CT: 'telecom', CU: 'unicom', CM: 'mobile' },
  baidu: { DEF: 'default', CT: 'ct', CU: 'cnc', CM: 'cmnet' },
  jdcloud: { DEF: '-1', CT: '1', CU: '2', CM: '3' },
  bt: { DEF: '0', CT: '285344768', CU: '285345792', CM: '285346816' },
  qingcloud: { DEF: '0', CT: '2', CU: '3', CM: '4' },
  cloudflare: { DEF: '0' },
  aws: { DEF: 'default' },
  namesilo: { DEF: 'default' },
  henet: { DEF: 'default' },
  powerdns: { DEF: 'default' },
  spaceship: { DEF: 'default' },
  aliyunesa: { DEF: '0' },
  tencenteo: { DEF: 'Default' },
  dnsmgr: { DEF: 'default' },
  goedge: { DEF: 'default' },
  dynv6: { DEF: 'default' },
};

/** 返回服务商某分组对应的线路代码；`null` 表示该服务商没有这条线路。 */
export function lineCodeFor(type: string, group: LineGroup): string | null {
  const code = GROUP_LINE_CODES[type]?.[group];
  if (code === undefined) return null;
  return code === '' ? 'default' : code;
}

export function supportsAutoLines(type: string): boolean {
  return Object.keys(GROUP_LINE_CODES[type] ?? {}).length > 1;
}
