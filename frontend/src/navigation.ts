export type Capability = 'dns' | 'cert' | 'tasks' | 'executor';

export interface NavigationItem {
  path: string;
  label: string;
  scope: string;
  capability?: Capability;
  implemented?: boolean;
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
  { label: '容灾与调度', adminOnly: true, items: [
    { path: '/dmonitor/overview', label: '运行概览', scope: '容灾探测与切换运行情况', capability: 'tasks', implemented: true },
    { path: '/dmonitor/task', label: '切换策略', scope: 'HTTP 探测与主备 DNS 故障切换', capability: 'tasks', implemented: true },
    { path: '/schedule/stask', label: '定时切换', scope: '定时 DNS 切换任务', capability: 'tasks', implemented: true },
  ] },
  { label: 'SSL 证书', adminOnly: true, items: [
    { path: '/cert/certaccount', label: '证书账户', scope: 'ACME 账户与签发配置', capability: 'cert' },
    { path: '/cert/certorder', label: '证书订单', scope: '已签发证书导入、订单管理与 PFX 导出', capability: 'cert', implemented: true },
    { path: '/cert/deployaccount', label: '自动部署账户', scope: '证书部署目标与访问凭证', capability: 'executor' },
    { path: '/cert/deploytask', label: '自动部署任务', scope: '证书自动部署与执行记录', capability: 'executor' },
    { path: '/cert/cname', label: 'CNAME 代理', scope: 'DNS 验证的 CNAME 代理配置', capability: 'cert' },
    { path: '/cert/certset', label: '自动续签设置', scope: '证书续签策略与调度设置', capability: 'cert' },
  ] },
  { label: 'CF 优选 IP', adminOnly: true, items: [
    { path: '/optimizeip/opipset', label: '优选设置', scope: 'Cloudflare IP 优选参数', capability: 'executor' },
    { path: '/optimizeip/opiplist', label: '任务管理', scope: 'IP 优选任务与执行情况', capability: 'executor' },
  ] },
  { label: '系统设置', adminOnly: true, items: [
    { path: '/system/cronset', label: '计划任务', scope: '计划任务与运行器设置', capability: 'tasks', implemented: true },
    { path: '/system/loginset', label: '登录设置', scope: '图形验证码登录策略', implemented: true },
    { path: '/system/noticeset', label: '通知设置', scope: '通知渠道与消息模板', implemented: true },
    { path: '/domain/expirenotice', label: '到期提醒设置', scope: '域名到期通知提前天数策略', implemented: true },
    { path: '/system/proxyset', label: '代理设置', scope: '外部请求代理配置' },
    { path: '/system/update', label: '在线更新', scope: '版本更新与兼容性检查' },
    { path: '/user', label: '用户管理', scope: '用户、权限与账户维护' },
  ] },
  { label: '审计与账户', items: [
    { path: '/log', label: '操作日志', scope: '用户操作与变更审计', implemented: true },
    { path: '/setpwd', label: '修改密码', scope: '当前登录用户修改自己的密码', implemented: true },
  ] },
];

export function resolvePage(path: string, level: number): { item: NavigationItem; group: string } {
  const visibleGroups = navigation.filter((group) => !group.adminOnly || level === 2);
  const visibleItems = visibleGroups.flatMap((group) => group.items);
  const exact = visibleItems.find((item) => item.path === path);
  if (exact) return { item: exact, group: visibleGroups.find((group) => group.items.includes(exact))!.label };
  if (/^\/cloudflare\/hostnames\/\d+$/.test(path) && level === 2) {
    return {
      item: { path, label: 'Cloudflare 自定义主机名', scope: 'SaaS 主机名、证书验证与 Fallback Origin', capability: 'dns', implemented: true },
      group: '域名配置',
    };
  }
  if (/^\/cloudflare\/tunnels\/\d+$/.test(path) && level === 2) {
    return {
      item: { path, label: 'Cloudflare Tunnels', scope: 'Tunnel、公网主机名与 Zero Trust 路由', capability: 'dns', implemented: true },
      group: '域名配置',
    };
  }
  if (/^\/record\/\d+\/alias$/.test(path)) {
    const domainItem = visibleItems.find((item) => item.path === '/domain')!;
    const item: NavigationItem = { path, label: '域名别名', scope: 'DNSPod 域名别名与解析共用', capability: 'dns', implemented: true };
    return { item, group: visibleGroups.find((group) => group.items.includes(domainItem))!.label };
  }
  if (/^\/record\/import\/\d+$/.test(path)) {
    const domainItem = visibleItems.find((item) => item.path === '/domain')!;
    const item: NavigationItem = { path, label: '导入解析记录', scope: '单域名 Excel 解析记录预览与逐行导入', capability: 'dns', implemented: true };
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
  return { item: { path, label: '未移植页面', scope: '此路径尚未提供可用的前端功能' } as NavigationItem, group: '页面状态' };
}
