export type Capability = 'dns' | 'cert' | 'tasks' | 'executor';

export interface NavigationItem {
  path: string;
  label: string;
  scope: string;
  capability?: Capability;
  implemented?: boolean;
  adminOnly?: boolean;
}

export interface NavigationGroup {
  label: string;
  adminOnly?: boolean;
  items: NavigationItem[];
}

export const navigation: NavigationGroup[] = [
  { label: '工作空间', items: [
    { path: '/', label: '后台首页', scope: '运行环境、会话与迁移状态', implemented: true },
    { path: '/domain', label: '域名管理', scope: '域名、解析记录与平台同步', capability: 'dns', implemented: true },
  ] },
  { label: '域名配置', adminOnly: true, items: [
    { path: '/account', label: '域名账户', scope: 'DNS 服务商账户与访问凭证', capability: 'dns', implemented: true },
    { path: '/domain/category', label: '域名分类', scope: '域名分类与分组管理', capability: 'dns', implemented: true },
  ] },
  { label: '容灾调度', adminOnly: true, items: [
    { path: '/dmonitor/overview', label: '运行概览', scope: '容灾探测与切换运行情况', capability: 'tasks', implemented: true },
    { path: '/dmonitor/task', label: '切换策略', scope: 'HTTP 探测与主备 DNS 故障切换', capability: 'tasks', implemented: true },
    { path: '/schedule/stask', label: '定时切换', scope: '定时 DNS 切换任务', capability: 'tasks', implemented: true },
    { path: '/optimizeip/opiplist', label: '优选任务', scope: 'IP 优选任务与执行情况', capability: 'executor', implemented: true },
  ] },
  { label: '证书管理', adminOnly: true, items: [
    { path: '/cert/certaccount', label: '证书账户', scope: 'ACME 账户注册、Directory 与一次性 nonce', capability: 'cert', implemented: true },
    { path: '/cert/certorder', label: '证书订单', scope: 'ACME DNS-01 签发、手动导入与 PFX 导出', capability: 'cert', implemented: true },
    { path: '/cert/deployaccount', label: '部署账户', scope: '证书部署目标与访问凭证', capability: 'executor', implemented: true },
    { path: '/cert/deploytask', label: '部署任务', scope: '证书自动部署与执行记录', capability: 'executor', implemented: true },
    { path: '/cert/cname', label: '证书代理', scope: 'DNS 验证的 CNAME 代理配置', capability: 'cert', implemented: true },
    { path: '/cert/certset', label: '续签设置', scope: '证书续签开关、天数与手动执行', capability: 'cert', implemented: true },
  ] },
  { label: '系统设置', items: [
    { path: '/system/account', label: '登录账户', scope: '图形验证码登录策略与用户、权限维护', adminOnly: true, implemented: true },
    { path: '/system/tasks', label: '任务通知', scope: '计划任务、通知渠道与到期提醒策略', capability: 'tasks', adminOnly: true, implemented: true },
    { path: '/system/maintenance', label: '系统维护', scope: '外部请求代理与版本更新检查', adminOnly: true, implemented: true },
    { path: '/log', label: '操作日志', scope: '用户操作与变更审计', implemented: true },
  ] },
];

const mergedPaths: Record<string, string> = {
  '/system/loginset': '/system/account',
  '/user': '/system/account',
  '/system/cronset': '/system/tasks',
  '/system/noticeset': '/system/tasks',
  '/domain/expirenotice': '/system/tasks',
  '/system/proxyset': '/system/maintenance',
  '/system/update': '/system/maintenance',
  '/optimizeip/opipset': '/optimizeip/opiplist',
};

export function canonicalPath(path: string): string {
  return mergedPaths[path] ?? path;
}

export function resolvePage(path: string, level: number): { item: NavigationItem; group: string } {
  const visibleGroups = navigation
    .filter((group) => !group.adminOnly || level === 2)
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.adminOnly || level === 2) }))
    .filter((group) => group.items.length > 0);
  const visibleItems = visibleGroups.flatMap((group) => group.items);
  if (path === '/setpwd') {
    return { item: { path, label: '修改密码', scope: '当前登录用户修改自己的密码', implemented: true } as NavigationItem, group: '账户' };
  }
  const exact = visibleItems.find((item) => item.path === canonicalPath(path));
  if (exact) return { item: exact, group: visibleGroups.find((group) => group.items.includes(exact))!.label };
  if (/^\/cloudflare\/hostnames\/\d+$/.test(path) && level === 2) {
    return {
      item: { path, label: '自定义域', scope: 'SaaS 主机名、证书验证与 Fallback Origin', capability: 'dns', implemented: true },
      group: '域名配置',
    };
  }
  if (/^\/cloudflare\/tunnels\/\d+$/.test(path) && level === 2) {
    return {
      item: { path, label: '隧道管理', scope: 'Tunnel、公网主机名与 Zero Trust 路由', capability: 'dns', implemented: true },
      group: '域名配置',
    };
  }
  if (/^\/record\/\d+\/alias$/.test(path)) {
    const domainItem = visibleItems.find((item) => item.path === '/domain')!;
    const item: NavigationItem = { path, label: '域名别名', scope: 'DNSPod 域名别名与解析共用', capability: 'dns', implemented: true };
    return { item, group: visibleGroups.find((group) => group.items.includes(domainItem))!.label };
  }
  const fixedRecordPages: Record<string, { label: string; scope: string }> = {
    '/record/batchadd': { label: '批量添加', scope: '选择域名后按行批量添加解析记录' },
    '/record/batchedit': { label: '批量修改', scope: '选择域名后批量修改记录类型、记录值与线路' },
    '/record/search': { label: '记录搜索', scope: '跨域名搜索记录值并批量修改或删除' },
    '/record/smartparse': { label: '智能添加', scope: '解析多域名输入并按域名批量添加记录' },
  };
  if (fixedRecordPages[path]) {
    return { item: { path, ...fixedRecordPages[path]!, capability: 'dns', implemented: true }, group: '工作空间' };
  }
  const recordPage = /^\/record\/(batchadd|batchedit|log|weight|groups)\/\d+$/.exec(path);
  if (recordPage) {
    const labels: Record<string, { label: string; scope: string }> = {
      batchadd: { label: '批量添加', scope: '按行批量添加解析记录' },
      batchedit: { label: '批量修改', scope: '勾选记录批量修改类型、记录值与线路' },
      log: { label: '服务日志', scope: '读取服务商侧的解析操作日志' },
      weight: { label: '权重配置', scope: '阿里云 DNS 线路权重开关与权重值' },
      groups: { label: '记录分组', scope: '阿里云与 DNSPod 的解析记录分组' },
    };
    return { item: { path, ...labels[recordPage[1]!]!, capability: 'dns', implemented: true }, group: '工作空间' };
  }
  if (/^\/record\/import\/\d+$/.test(path)) {
    const domainItem = visibleItems.find((item) => item.path === '/domain')!;
    const item: NavigationItem = { path, label: '导入记录', scope: '单域名 Excel 解析记录预览与逐行导入', capability: 'dns', implemented: true };
    return { item, group: visibleGroups.find((group) => group.items.includes(domainItem))!.label };
  }
  if (/^\/record\/\d+$/.test(path)) {
    const domainItem = visibleItems.find((item) => item.path === '/domain')!;
    const item: NavigationItem = { path, label: '解析记录', scope: '域名解析记录的查询与变更', capability: 'dns', implemented: true };
    return { item, group: visibleGroups.find((group) => group.items.includes(domainItem))!.label };
  }
  const parent = visibleItems
    .filter((item) => item.path !== '/' && path.startsWith(`${item.path}/`))
    .sort((first, second) => second.path.length - first.path.length)[0];
  if (parent) return { item: parent, group: visibleGroups.find((group) => group.items.includes(parent))!.label };
  return { item: { path, label: '未知页面', scope: '此路径尚未提供可用的前端功能' } as NavigationItem, group: '页面状态' };
}
