import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ApiError, errorMessage, request, send, type Bootstrap, type Session } from './api';
import { Brand, Icon } from './icons';
import { LanguageToggle, SKINS, ThemeMenu, ThemeToggle, usePreferences, type Skin } from './preferences';
import { Menu } from './Menu';
import { InfoTip } from './InfoTip';
import { navigation, canonicalPath, resolvePage, type Capability } from './navigation';
import { DnsAccounts } from './DnsAccounts';
import { DnsDomains } from './DnsDomains';
import { DnsLogs } from './DnsLogs';
import { DnsRecords, RecordExplorer } from './DnsRecords';
import { DnsRecordImport } from './DnsRecordImport';
import { DnsAliases } from './DnsAliases';
import { CfHostnames } from './CfHostnames';
import { CfTunnels } from './CfTunnels';
import { ScheduleTasks } from './ScheduleTasks';
import { DnsFailover } from './DnsFailover';
import { SetPassword } from './SetPassword';
import { CertificateOrders } from './CertificateOrders';
import { DeployAccounts, DeployTasks } from './CertificateDeploy';
import { OptimizeIpTasks } from './OptimizeIp';
import { SystemAccount, SystemMaintenance, SystemTasks } from './SystemPages';
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

const SIDEBAR_KEY = 'dnsmgr-sidebar';

function initialCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

export function Console({ session, path, navigate, onExpired, onLoggedOut }: ConsoleProps) {
  const { t } = usePreferences();
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [retry, setRetry] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [skinNotice, setSkinNotice] = useState('');
  const [skinError, setSkinError] = useState('');
  const navRef = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const contentTitle = useRef<HTMLHeadingElement>(null);
  const logoutController = useRef<AbortController | null>(null);
  const previousPath = useRef(path);
  const wasMobileOpen = useRef(false);
  const level = session.user.level;
  const groups = navigation
    .filter((group) => !group.adminOnly || level === 2)
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.adminOnly || level === 2) }))
    .filter((group) => group.items.length > 0);
  const page = resolvePage(path, level);
  const route = canonicalPath(path);
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
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch { /* storage may be blocked */ }
  }, [collapsed]);

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

  async function saveDefaultSkin(skin: Skin) {
    setSkinNotice('');
    setSkinError('');
    try {
      await send('/api/v1/system/skin', 'PUT', { skin }, new AbortController().signal, { 'X-CSRF-Token': session.csrfToken });
      const label = SKINS.find((item) => item.id === skin)?.label ?? skin;
      setSkinNotice(t('已将「{name}」设为站点默认皮肤', { name: t(label) }));
    } catch (failure) {
      setSkinError(errorMessage(failure));
    }
  }

  return <div className={`console-layout ${mobileOpen ? 'navigation-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <a className="skip-link" href="#main-content" inert={mobileOpen}>{t('跳到主要内容')}</a>
    {mobileOpen && <button className="navigation-backdrop" aria-label={t('关闭导航菜单')} tabIndex={-1} onClick={closeNavigation} />}
    <aside id="workspace-navigation" className="sidebar" ref={navRef} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label={t('功能导航')} inert={!mobileOpen && collapsed}>
      <div className="sidebar-brand"><Brand compact /><button ref={closeButton} className="icon-button sidebar-close" aria-label={t('关闭导航菜单')} onClick={closeNavigation}><Icon name="close" /></button></div>
      <div className="workspace-label"><span className="status-dot" />{t('迁移进行中')}<span className="mono">W4</span></div>
      <nav aria-label={t('功能分组')} className="sidebar-nav">
        {groups.map((group) => <section className="nav-group" key={group.label}>
          <h2>{t(group.label)}</h2>
          <ul>{group.items.map((item) => <li key={item.path}><a href={item.path} className={page.item.path === item.path ? 'active' : ''} aria-current={page.item.path === item.path ? 'page' : undefined} onClick={(event) => followLink(event, item.path)}><span>{t(item.label)}</span>{item.path !== '/' && !item.implemented && <span className="nav-pending" aria-label={t('待移植')}>{t('待移植')}</span>}</a></li>)}</ul>
        </section>)}
      </nav>
      <div className="sidebar-footer"><span className="sidebar-avatar" aria-hidden="true">{session.user.username.slice(0, 1).toUpperCase()}</span><div><strong>{session.user.username}</strong><small>{level === 2 ? t('管理员') : t('用户')} · {t('已登录')}</small></div></div>
    </aside>
    <div className="workspace" inert={mobileOpen}>
      <header className="topbar">
        <div className="topbar-location"><button ref={menuButton} className="icon-button menu-button" aria-label={t('打开导航菜单')} aria-expanded={mobileOpen} aria-controls="workspace-navigation" onClick={() => setMobileOpen(true)}><Icon name="menu" /></button><button className="icon-button sidebar-toggle" aria-label={t(collapsed ? '展开侧边栏' : '收起侧边栏')} title={t(collapsed ? '展开侧边栏' : '收起侧边栏')} aria-expanded={!collapsed} aria-controls="workspace-navigation" onClick={() => setCollapsed((value) => !value)}><Icon name={collapsed ? 'panel-expand' : 'panel'} /></button><span>{t('控制台')}</span><span className="breadcrumb-divider">/</span><strong>{t(page.group)}</strong></div>
        <div className="topbar-actions"><ThemeToggle /><ThemeMenu onSetDefault={level === 2 ? (skin) => void saveDefaultSkin(skin) : undefined} /><LanguageToggle /><Menu label={t('账户菜单')} className="user-menu" trigger={<span className="menu-avatar" aria-hidden="true">{session.user.username.slice(0, 1).toUpperCase()}</span>}>
          {(close) => <>
            <div className="menu-heading"><strong>{session.user.username}</strong><span>{level === 2 ? t('管理员') : t('用户')}</span></div>
            <a className="menu-item" role="menuitem" href="/setpwd" onClick={(event) => { close(); followLink(event, '/setpwd'); }}><Icon name="key" />{t('修改密码')}</a>
            <div className="menu-separator" />
            <button className="menu-item" role="menuitem" type="button" disabled={loggingOut} onClick={() => { close(); void logout(); }}><Icon name="logout" />{loggingOut ? t('正在退出…') : t('退出登录')}</button>
          </>}
        </Menu></div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="page-heading"><div><div className="section-kicker">{t(home ? '系统概览 / OVERVIEW' : '功能模块 / MODULE')}</div><div className="page-title"><h1 ref={contentTitle} tabIndex={-1}>{t(page.item.label)}</h1>{!home && <InfoTip label={t('页面说明')} text={t(page.item.scope)} />}</div></div><span className="phase-badge">{t(home ? 'DNS 已接入' : implemented ? '运行中' : '待移植')}</span></div>
        {logoutError && <div className="notice notice-error" role="alert"><strong>{t('退出未完成')}</strong><span>{logoutError} {t('可再次点击退出登录重试。')}</span></div>}
        {skinNotice && <div className="notice" role="status">{skinNotice}</div>}
        {skinError && <div className="notice notice-error" role="alert">{skinError}</div>}
        {loadError && <div className="notice notice-error with-action" role="alert"><div><strong>{t('运行环境加载失败')}</strong><span>{loadError}</span></div><button className="button button-secondary" onClick={() => setRetry((value) => value + 1)}>{t('重新加载')}</button></div>}
        {home ? <>
          <div className="overview-grid">
            <section className="panel environment-panel" aria-labelledby="environment-title"><div className="panel-heading"><div><Icon name="server" /><h2 id="environment-title">{t('运行环境')}</h2></div><span className="panel-meta">{t('来自服务端')}</span></div>{loading ? <div className="panel-loading" role="status"><span className="spinner" />{t('正在读取运行环境…')}</div> : bootstrap ? <dl className="data-list"><div><dt>{t('运行平台')}</dt><dd className="mono">{bootstrap.runtime.platform}</dd></div><div><dt>{t('存储驱动')}</dt><dd className="mono">{bootstrap.runtime.storage.driver}</dd></div><div><dt>{t('存储格式')}</dt><dd className="mono">{bootstrap.runtime.storage.format}</dd></div><div><dt>{t('迁移阶段')}</dt><dd><span className="data-badge mono">{bootstrap.migration.stage}</span></dd></div></dl> : <div className="panel-empty">{t('环境数据不可用，请重新加载。')}</div>}<div className="panel-footnote">{t('数据来源')} <code>/api/v1/bootstrap</code></div></section>
            <section className="panel session-panel" aria-labelledby="session-title"><div className="panel-heading"><div><Icon name="lock" /><h2 id="session-title">{t('当前会话')}</h2></div><span className="data-badge">{t('已验证')}</span></div><dl className="data-list"><div><dt>{t('用户名')}</dt><dd>{session.user.username}</dd></div><div><dt>{t('账户角色')}</dt><dd>{level === 2 ? t('管理员') : t('用户')}<span className="value-detail mono">LEVEL {level}</span></dd></div><div><dt>{t('会话存储')}</dt><dd>{t('服务端 Cookie')}</dd></div><div><dt>{t('请求保护')}</dt><dd>{t('CSRF 令牌')}<span className="value-detail">{t('仅保存在内存中')}</span></dd></div></dl></section>
          </div>
        </> : route === '/account' && level === 2 ? <DnsAccounts session={session} onExpired={onExpired} />
          : route === '/domain' ? <DnsDomains session={session} navigate={navigate} onExpired={onExpired} />
            : route === '/record' ? <RecordExplorer session={session} navigate={navigate} onExpired={onExpired} />
              : path === '/log' ? <DnsLogs session={session} onExpired={onExpired} />
                : path === '/dmonitor/overview' && level === 2 ? <DnsFailover session={session} navigate={navigate} onExpired={onExpired} overview />
                  : path === '/dmonitor/task' && level === 2 ? <DnsFailover session={session} navigate={navigate} onExpired={onExpired} />
                    : path === '/schedule/stask' && level === 2 ? <ScheduleTasks session={session} onExpired={onExpired} />
                    : route === '/system/account' && level === 2 ? <SystemAccount session={session} onExpired={onExpired} />
                    : route === '/system/tasks' && level === 2 ? <SystemTasks session={session} onExpired={onExpired} />
                    : route === '/system/maintenance' && level === 2 ? <SystemMaintenance session={session} onExpired={onExpired} />
                    : route === '/cert/certaccount' && level === 2 ? <CertificateOrders session={session} onExpired={onExpired} section="accounts" />
                    : route === '/cert/certorder' && level === 2 ? <CertificateOrders session={session} onExpired={onExpired} />
                    : path === '/cert/deployaccount' && level === 2 ? <DeployAccounts session={session} onExpired={onExpired} />
                    : path === '/cert/deploytask' && level === 2 ? <DeployTasks session={session} onExpired={onExpired} />
                    : route === '/optimizeip/opiplist' && level === 2 ? <OptimizeIpTasks session={session} onExpired={onExpired} />
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
              : <section className="panel migration-panel" aria-labelledby="module-state-title"><div className="module-state-icon"><Icon name="dns" /></div><span className="section-kicker">{t('模块状态 / NOT MIGRATED')}</span><h2 id="module-state-title">{t('此模块尚未移植')}</h2><dl className="module-details"><div><dt>{t('当前路径')}</dt><dd><code>{path}</code></dd></div></dl><div className="module-actions"><a className="button button-primary" href="/" onClick={(event) => followLink(event, '/')}>{t('返回后台首页')}<Icon name="arrow" /></a></div></section>}
        <footer className="workspace-footer"><span>{t('聚合 DNS 管理系统')}</span><span>{t('安装 · 认证 · 会话基础')} <span className="mono">/ FOUNDATION</span></span></footer>
      </main>
    </div>
  </div>;
}
