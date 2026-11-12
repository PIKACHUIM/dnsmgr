import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ApiError, errorMessage, request, type Bootstrap, type Session } from './api';
import { Brand, Icon } from './icons';
import { navigation, resolvePage, type Capability } from './navigation';
import { DnsAccounts } from './DnsAccounts';
import { DnsCategories } from './DnsCategories';
import { DnsDomains } from './DnsDomains';
import { DnsLogs } from './DnsLogs';
import { DnsRecords } from './DnsRecords';
import { DnsRecordImport } from './DnsRecordImport';
import { DnsAliases } from './DnsAliases';
import { CfHostnames } from './CfHostnames';
import { CfTunnels } from './CfTunnels';
import { ScheduleTasks } from './ScheduleTasks';
import { CronSettings } from './CronSettings';
import { NotifySettings } from './NotifySettings';
import { ExpirationNoticeSettings } from './ExpirationNoticeSettings';
import { LoginCaptchaSettings } from './LoginCaptchaSettings';
import { DnsFailover } from './DnsFailover';
import { SetPassword } from './SetPassword';
import { CertificateOrders } from './CertificateOrders';
import { CertificateSettings } from './CertificateSettings';
import { CertificateCname } from './CertificateCname';
import { DeployAccounts, DeployTasks } from './CertificateDeploy';
import { OptimizeIpSettings, OptimizeIpTasks } from './OptimizeIp';
import { Users } from './Users';
import { ProxySettings } from './ProxySettings';
import { SystemUpdate } from './SystemUpdate';
import { RecordTools } from './RecordTools';
import { RecordBatchAdd } from './RecordBatchAdd';
import { RecordBatchEdit } from './RecordBatchEdit';
import { RecordGroup } from './RecordGroup';
import { RecordWeight } from './RecordWeight';
import { RecordSearch } from './RecordSearch';
import { SmartParse } from './SmartParse';
import { DnsRecordLog } from './DnsRecordLog';

interface ConsoleProps {
  session: Session;
  path: string;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
  onLoggedOut: (notice?: string) => void;
}

const capabilityNames: Record<Capability, string> = { dns: 'DNS 管理', cert: 'SSL 证书', tasks: '任务调度', executor: '执行器' };

export function Console({ session, path, navigate, onExpired, onLoggedOut }: ConsoleProps) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [retry, setRetry] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const contentTitle = useRef<HTMLHeadingElement>(null);
  const logoutController = useRef<AbortController | null>(null);
  const previousPath = useRef(path);
  const wasMobileOpen = useRef(false);
  const level = session.user.level;
  const groups = navigation.filter((group) => !group.adminOnly || level === 2);
  const page = resolvePage(path, level);
  const home = path === '/';
  const recordMatch = /^\/record\/(\d+)$/.exec(path);
  const batchAddMatch = /^\/record\/batchadd\/(\d+)$/.exec(path);
  const batchEditMatch = /^\/record\/batchedit\/(\d+)$/.exec(path);
  const recordLogMatch = /^\/record\/log\/(\d+)$/.exec(path);
  const weightMatch = /^\/record\/weight\/(\d+)$/.exec(path);
  const groupMatch = /^\/record\/groups\/(\d+)$/.exec(path);
  const recordToolMatch = /^\/record\/(batchadd|batchedit)$/.exec(path);
  const importMatch = /^\/record\/import\/(\d+)$/.exec(path);
  const aliasMatch = /^\/record\/(\d+)\/alias$/.exec(path);
  const hostnameMatch = /^\/cloudflare\/hostnames\/(\d+)$/.exec(path);
  const tunnelMatch = /^\/cloudflare\/tunnels\/(\d+)$/.exec(path);
  const implemented = page.item.implemented === true;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    request<Bootstrap>('/api/v1/bootstrap', { signal: controller.signal })
      .then((result) => {
        if (!result.runtime || typeof result.runtime.platform !== 'string'
          || !result.runtime.storage || typeof result.runtime.storage.driver !== 'string'
          || typeof result.runtime.storage.format !== 'string' || !result.capabilities
          || !result.migration || typeof result.migration.stage !== 'string'
          || Object.keys(capabilityNames).some((key) => typeof result.capabilities[key as Capability] !== 'boolean')) {
          throw new ApiError('运行环境响应不完整，请检查后端服务后重试。', 502);
        }
        if (!controller.signal.aborted) setBootstrap(result);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
        else setLoadError(errorMessage(failure));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry, onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    logoutController.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (previousPath.current !== path) {
      previousPath.current = path;
      contentTitle.current?.focus();
    }
  }, [path]);

  function closeNavigation() {
    setMobileOpen(false);
  }

  useEffect(() => {
    if (!mobileOpen && wasMobileOpen.current) menuButton.current?.focus();
    wasMobileOpen.current = mobileOpen;
  }, [mobileOpen]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 901px)');
    const changed = () => { if (media.matches) setMobileOpen(false); };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    closeButton.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNavigation();
      }
      if (event.key === 'Tab') {
        const targets = Array.from(navRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? []);
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = originalOverflow;
      document.removeEventListener('keydown', handleKey);
    };
  }, [mobileOpen]);

  function followLink(event: MouseEvent<HTMLAnchorElement>, destination: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (mobileOpen) closeNavigation();
    navigate(destination);
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError('');
    const signal = logoutController.current!.signal;
    try {
      await request('/logout', { method: 'POST', signal, headers: { 'X-CSRF-Token': session.csrfToken } });
      if (!signal.aborted) onLoggedOut();
    } catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onLoggedOut();
      else setLogoutError(errorMessage(failure));
    } finally {
      if (!signal.aborted) setLoggingOut(false);
    }
  }

  return <div className={`console-layout ${mobileOpen ? 'navigation-open' : ''}`}>
    <a className="skip-link" href="#main-content" inert={mobileOpen}>跳到主要内容</a>
    {mobileOpen && <button className="navigation-backdrop" aria-label="关闭导航菜单" tabIndex={-1} onClick={closeNavigation} />}
    <aside id="workspace-navigation" className="sidebar" ref={navRef} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label="功能导航">
      <div className="sidebar-brand"><Brand compact /><button ref={closeButton} className="icon-button sidebar-close" aria-label="关闭导航菜单" onClick={closeNavigation}><Icon name="close" /></button></div>
      <div className="workspace-label"><span className="status-dot" />迁移进行中<span className="mono">W4</span></div>
      <nav aria-label="功能分组" className="sidebar-nav">
        {groups.map((group) => <section className="nav-group" key={group.label}>
          <h2>{group.label}</h2>
          <ul>{group.items.map((item) => <li key={item.path}><a href={item.path} className={page.item.path === item.path ? 'active' : ''} aria-current={page.item.path === item.path ? 'page' : undefined} onClick={(event) => followLink(event, item.path)}><span>{item.label}</span>{item.path !== '/' && !item.implemented && <span className="nav-pending" aria-label="待移植">待移植</span>}</a></li>)}</ul>
        </section>)}
      </nav>
      <div className="sidebar-footer"><span className="sidebar-avatar" aria-hidden="true">{session.user.username.slice(0, 1).toUpperCase()}</span><div><strong>{session.user.username}</strong><small>{level === 2 ? '管理员' : '用户'} · 已登录</small></div></div>
    </aside>
    <div className="workspace" inert={mobileOpen}>
      <header className="topbar">
        <div className="topbar-location"><button ref={menuButton} className="icon-button menu-button" aria-label="打开导航菜单" aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button><span>控制台</span><span className="breadcrumb-divider">/</span><strong>{page.group}</strong></div>
        <div className="topbar-actions"><span className="session-label"><Icon name="shield" />安全会话</span><button className="button button-quiet logout-button" disabled={loggingOut} onClick={logout}><Icon name="logout" />{loggingOut ? '正在退出…' : '退出登录'}</button></div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading"><div><div className="section-kicker">{home ? '工作空间 / WORKSPACE' : '功能模块 / MODULE'}</div><h1 ref={contentTitle} tabIndex={-1}>{page.item.label}</h1><p>{home ? '查看当前运行环境、会话与功能迁移状态。' : page.item.scope}</p></div><span className="phase-badge">{home ? 'DNS 已接入' : implemented ? '运行中' : '待移植'}</span></div>
        {logoutError && <div className="notice notice-error" role="alert"><strong>退出未完成</strong><span>{logoutError} 可再次点击退出登录重试。</span></div>}
        {loadError && <div className="notice notice-error with-action" role="alert"><div><strong>运行环境加载失败</strong><span>{loadError}</span></div><button className="button button-secondary" onClick={() => setRetry((value) => value + 1)}>重新加载</button></div>}
        {home ? <>
          <section className="foundation-banner" aria-labelledby="foundation-title"><div className="foundation-index mono">03</div><div><h2 id="foundation-title">DNS 管理与证书订单已接入</h2><p>DNS 解析、容灾切换、定时任务与证书安全存储/手动导入已接入；CA 自动申请、续签和部署仍在迁移。</p></div><Icon name="shield" /></section>
          <div className="overview-grid">
            <section className="panel environment-panel" aria-labelledby="environment-title"><div className="panel-heading"><div><Icon name="server" /><h2 id="environment-title">运行环境</h2></div><span className="panel-meta">来自服务端</span></div>{loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取运行环境…</div> : bootstrap ? <dl className="data-list"><div><dt>运行平台</dt><dd className="mono">{bootstrap.runtime.platform}</dd></div><div><dt>存储驱动</dt><dd className="mono">{bootstrap.runtime.storage.driver}</dd></div><div><dt>存储格式</dt><dd className="mono">{bootstrap.runtime.storage.format}</dd></div><div><dt>迁移阶段</dt><dd><span className="data-badge mono">{bootstrap.migration.stage}</span></dd></div></dl> : <div className="panel-empty">环境数据不可用，请重新加载。</div>}<div className="panel-footnote">数据来源 <code>/api/v1/bootstrap</code></div></section>
            <section className="panel session-panel" aria-labelledby="session-title"><div className="panel-heading"><div><Icon name="lock" /><h2 id="session-title">当前会话</h2></div><span className="data-badge">已验证</span></div><dl className="data-list"><div><dt>用户名</dt><dd>{session.user.username}</dd></div><div><dt>账户角色</dt><dd>{level === 2 ? '管理员' : '用户'}<span className="value-detail mono">LEVEL {level}</span></dd></div><div><dt>会话存储</dt><dd>服务端 Cookie</dd></div><div><dt>请求保护</dt><dd>CSRF 令牌<span className="value-detail">仅保存在内存中</span></dd></div></dl><div className="panel-footnote">不会在浏览器本地存储用户名、密码或会话令牌。</div></section>
          </div>
          <section className="panel capability-panel" aria-labelledby="capability-title"><div className="panel-heading"><div><Icon name="grid" /><h2 id="capability-title">功能迁移状态</h2></div><span className="panel-meta">不是业务统计</span></div><div className="capability-table" role="table" aria-label="后端能力状态"><div className="capability-row capability-header" role="row"><span role="columnheader">模块</span><span role="columnheader">后端能力</span><span role="columnheader">当前前端</span></div>{(Object.keys(capabilityNames) as Capability[]).map((key) => <div className="capability-row" role="row" key={key}><strong role="cell">{capabilityNames[key]}</strong><span role="cell">{loading ? '读取中…' : bootstrap ? bootstrap.capabilities[key] ? '已声明可用' : '未开放' : '未知'}</span><span role="cell"><span className="status-label"><span className="status-dot" />{bootstrap?.capabilities[key] ? '已上线' : '待移植'}</span></span></div>)}</div><div className="panel-footnote">后端能力不等于页面已完成。左侧保留旧路径，仅提供对应模块的移植说明。</div></section>
        </> : path === '/account' && level === 2 ? <DnsAccounts session={session} onExpired={onExpired} />
          : path === '/domain' ? <DnsDomains session={session} navigate={navigate} onExpired={onExpired} />
            : path === '/domain/category' && level === 2 ? <DnsCategories session={session} onExpired={onExpired} />
              : path === '/log' ? <DnsLogs session={session} onExpired={onExpired} />
                : path === '/dmonitor/overview' && level === 2 ? <DnsFailover session={session} navigate={navigate} onExpired={onExpired} overview />
                  : path === '/dmonitor/task' && level === 2 ? <DnsFailover session={session} navigate={navigate} onExpired={onExpired} />
                    : path === '/schedule/stask' && level === 2 ? <ScheduleTasks session={session} onExpired={onExpired} />
                    : path === '/system/loginset' && level === 2 ? <LoginCaptchaSettings session={session} onExpired={onExpired} />
                    : path === '/system/cronset' && level === 2 ? <CronSettings session={session} onExpired={onExpired} />
                  : path === '/system/noticeset' && level === 2 ? <NotifySettings session={session} onExpired={onExpired} />
                      : path === '/domain/expirenotice' && level === 2 ? <ExpirationNoticeSettings session={session} onExpired={onExpired} />
                    : path === '/cert/certaccount' && level === 2 ? <CertificateOrders session={session} onExpired={onExpired} section="accounts" />
                    : path === '/cert/certorder' && level === 2 ? <CertificateOrders session={session} onExpired={onExpired} />
                    : path === '/cert/certset' && level === 2 ? <CertificateSettings session={session} onExpired={onExpired} />
                    : path === '/cert/cname' && level === 2 ? <CertificateCname session={session} onExpired={onExpired} />
                    : path === '/cert/deployaccount' && level === 2 ? <DeployAccounts session={session} onExpired={onExpired} />
                    : path === '/cert/deploytask' && level === 2 ? <DeployTasks session={session} onExpired={onExpired} />
                    : path === '/optimizeip/opipset' && level === 2 ? <OptimizeIpSettings session={session} onExpired={onExpired} />
                    : path === '/optimizeip/opiplist' && level === 2 ? <OptimizeIpTasks session={session} onExpired={onExpired} />
                    : path === '/system/proxyset' && level === 2 ? <ProxySettings session={session} onExpired={onExpired} />
                    : path === '/system/update' && level === 2 ? <SystemUpdate session={session} onExpired={onExpired} />
                    : path === '/user' && level === 2 ? <Users session={session} onExpired={onExpired} />
                    : path === '/setpwd' ? <SetPassword session={session} onExpired={onExpired} onLoggedOut={onLoggedOut} />
                    : hostnameMatch && level === 2 ? <CfHostnames session={session} domainId={Number(hostnameMatch[1])} navigate={navigate} onExpired={onExpired} />
                  : tunnelMatch && level === 2 ? <CfTunnels session={session} accountId={Number(tunnelMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : aliasMatch ? <DnsAliases session={session} domainId={Number(aliasMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : importMatch ? <DnsRecordImport session={session} domainId={Number(importMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : batchAddMatch ? <RecordBatchAdd session={session} domainId={Number(batchAddMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : batchEditMatch ? <RecordBatchEdit session={session} domainId={Number(batchEditMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : recordLogMatch ? <DnsRecordLog session={session} domainId={Number(recordLogMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : weightMatch ? <RecordWeight session={session} domainId={Number(weightMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : groupMatch ? <RecordGroup session={session} domainId={Number(groupMatch[1])} navigate={navigate} onExpired={onExpired} />
                    : path === '/record/search' ? <RecordSearch session={session} navigate={navigate} onExpired={onExpired} />
                    : path === '/record/smartparse' ? <SmartParse session={session} navigate={navigate} onExpired={onExpired} />
                    : recordToolMatch ? <RecordTools session={session} mode={recordToolMatch[1] as 'batchadd' | 'batchedit'} navigate={navigate} onExpired={onExpired} />
                    : recordMatch ? <DnsRecords session={session} domainId={Number(recordMatch[1])} navigate={navigate} onExpired={onExpired} />
              : <section className="panel migration-panel" aria-labelledby="module-state-title"><div className="module-state-icon"><Icon name="dns" /></div><span className="section-kicker">模块状态 / NOT MIGRATED</span><h2 id="module-state-title">此模块尚未移植</h2><p>已保留「{page.item.label}」的导航入口与访问路径。当前页面只说明迁移边界，不提供业务查询、配置或执行操作。</p><dl className="module-details"><div><dt>当前路径</dt><dd><code>{path}</code></dd></div><div><dt>功能范围</dt><dd>{page.item.scope}</dd></div><div><dt>后端能力</dt><dd>{loading ? '正在读取…' : !bootstrap ? '读取失败，状态未知' : page.item.capability ? `${capabilityNames[page.item.capability]}：${bootstrap.capabilities[page.item.capability] ? '已声明可用，页面仍待移植' : '未开放'}` : '基础阶段未提供此功能的业务接口'}</dd></div></dl><div className="module-actions"><a className="button button-primary" href="/" onClick={(event) => followLink(event, '/')}>返回后台首页<Icon name="arrow" /></a><span>不会调用旧接口或产生业务变更。</span></div></section>}
        <footer className="workspace-footer"><span>聚合 DNS 管理系统</span><span>安装 · 认证 · 会话基础 <span className="mono">/ FOUNDATION</span></span></footer>
      </main>
    </div>
  </div>;
}
