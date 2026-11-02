import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Tunnel { id: string; name: string; status: string; connections: number; createdAt: string | null }
interface PublicHostname { hostname: string; service: string; path: string; zoneName: string | null }
interface Route { id: string; network?: string; hostname?: string; comment: string | null }

interface Props {
  session: Session;
  accountId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

export function CfTunnels({ session, accountId, navigate, onExpired }: Props) {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [cfAccountId, setCfAccountId] = useState('');
  const [name, setName] = useState('');
  const [current, setCurrent] = useState<Tunnel | null>(null);
  const [hostnames, setHostnames] = useState<PublicHostname[]>([]);
  const [cidrs, setCidrs] = useState<Route[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [publicForm, setPublicForm] = useState({ hostname: '', service: '', path: '' });
  const [cidrForm, setCidrForm] = useState('');
  const [routeForm, setRouteForm] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const result = await request<{ code: 0; accountId: string; items: Tunnel[] }>(`/api/v1/cloudflare/accounts/${accountId}/tunnels`, { signal });
      if (signal.aborted) return;
      setTunnels(result.items);
      setCfAccountId(result.accountId);
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [accountId, handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const loadDetails = useCallback(async (signal: AbortSignal, tunnel: Tunnel) => {
    const base = `/api/v1/cloudflare/accounts/${accountId}/tunnels/${tunnel.id}`;
    try {
      const [publicList, cidrList, routeList] = await Promise.all([
        request<{ code: 0; items: PublicHostname[] }>(`${base}/public-hostnames`, { signal }),
        request<{ code: 0; items: Route[] }>(`${base}/cidr-routes`, { signal }),
        request<{ code: 0; items: Route[] }>(`${base}/hostname-routes`, { signal }),
      ]);
      if (signal.aborted) return;
      setHostnames(publicList.items);
      setCidrs(cidrList.items);
      setRoutes(routeList.items);
    } catch (failure) { if (!signal.aborted) handle(failure); }
  }, [accountId, handle]);

  async function open(tunnel: Tunnel) {
    setCurrent(tunnel);
    setError('');
    const controller = new AbortController();
    await loadDetails(controller.signal, tunnel);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/accounts/${accountId}/tunnels`, 'POST', { name: name.trim() }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setName('');
      setNotice('Tunnel 已创建');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(tunnel: Tunnel) {
    if (busy || !window.confirm(`确认删除 Tunnel「${tunnel.name}」？`)) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/accounts/${accountId}/tunnels/${tunnel.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      if (current?.id === tunnel.id) setCurrent(null);
      setNotice('Tunnel 已删除');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function token(tunnel: Tunnel) {
    if (busy) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      const result = await request<{ code: 0; token: string }>(`/api/v1/cloudflare/accounts/${accountId}/tunnels/${tunnel.id}/token`, { signal: controller.signal });
      await navigator.clipboard?.writeText(`cloudflared tunnel run --token ${result.token}`);
      setNotice('启动命令已复制到剪贴板');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function addPublic(event: React.FormEvent) {
    event.preventDefault();
    if (!current || busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; dns: string }>(
        `/api/v1/cloudflare/accounts/${accountId}/tunnels/${current.id}/public-hostnames`, 'PUT', publicForm,
        controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(`公网主机名已保存，DNS 记录 ${result.dns}`);
      setPublicForm({ hostname: '', service: '', path: '' });
      await loadDetails(controller.signal, current);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function removePublic(item: PublicHostname) {
    if (!current || busy || !window.confirm(`确认删除 ${item.hostname}${item.path}？`)) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/accounts/${accountId}/tunnels/${current.id}/public-hostnames?hostname=${encodeURIComponent(item.hostname)}&path=${encodeURIComponent(item.path)}`,
        'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await loadDetails(controller.signal, current);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function addCidr(event: React.FormEvent) {
    event.preventDefault();
    if (!current || busy) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/accounts/${accountId}/tunnels/${current.id}/cidr-routes`, 'POST', { network: cidrForm.trim() }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setCidrForm('');
      await loadDetails(controller.signal, current);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function removeCidr(route: Route) {
    if (!current || busy) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/accounts/${accountId}/tunnels/${current.id}/cidr-routes/${route.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await loadDetails(controller.signal, current);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function addRoute(event: React.FormEvent) {
    event.preventDefault();
    if (!current || busy) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/accounts/${accountId}/tunnels/${current.id}/hostname-routes`, 'POST', { hostname: routeForm.trim() }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setRouteForm('');
      await loadDetails(controller.signal, current);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function removeRoute(route: Route) {
    if (!current || busy) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/accounts/${accountId}/tunnels/${current.id}/hostname-routes/${route.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await loadDetails(controller.signal, current);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-tools">
      <a className="button button-secondary" href="/account" onClick={(event) => { event.preventDefault(); navigate('/account'); }}>返回域名账户</a>
      <span className="mono">Cloudflare Account ID · {cfAccountId || '读取中…'} · 仅支持 API 令牌</span>
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="tunnel-create-title">
      <div className="panel-heading"><div><h2 id="tunnel-create-title">创建 Tunnel</h2></div><span className="panel-meta">cloudflared</span></div>
      <form className="dns-form" onSubmit={create}>
        <label className="form-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>创建</button></div>
      </form>
    </section>
    <section className="panel" aria-labelledby="tunnel-list-title">
      <div className="panel-heading"><div><h2 id="tunnel-list-title">Tunnel 列表</h2></div><span className="panel-meta">共 {tunnels.length} 个</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取 Tunnel…</div>
        : tunnels.length === 0 ? <div className="panel-empty">还没有 Tunnel。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>名称</th><th>状态</th><th>连接</th><th>ID</th><th>操作</th></tr></thead>
            <tbody>{tunnels.map((tunnel) => <tr key={tunnel.id}>
              <td>{tunnel.name}</td>
              <td>{tunnel.status || '—'}</td>
              <td>{tunnel.connections}</td>
              <td className="mono">{tunnel.id}</td>
              <td className="row-actions">
                <button className="button button-secondary" disabled={busy} onClick={() => void open(tunnel)}>管理</button>
                <button className="button button-secondary" disabled={busy} onClick={() => void token(tunnel)}>Token</button>
                <button className="button button-quiet" disabled={busy} onClick={() => void remove(tunnel)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    {current && <>
      <section className="panel" aria-labelledby="public-title">
        <div className="panel-heading"><div><h2 id="public-title">公网主机名 · {current.name}</h2></div><span className="panel-meta">自动同步 CNAME</span></div>
        <form className="dns-form" onSubmit={addPublic}>
          <label className="form-field"><span>主机名</span><input value={publicForm.hostname} onChange={(event) => setPublicForm({ ...publicForm, hostname: event.target.value })} required maxLength={253} /></label>
          <label className="form-field"><span>服务</span><input value={publicForm.service} onChange={(event) => setPublicForm({ ...publicForm, service: event.target.value })} required placeholder="http://localhost:8080" maxLength={255} /></label>
          <label className="form-field"><span>路径</span><input value={publicForm.path} onChange={(event) => setPublicForm({ ...publicForm, path: event.target.value })} maxLength={255} /></label>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>保存</button></div>
        </form>
        {hostnames.length === 0 ? <div className="panel-empty">没有公网主机名。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>主机名</th><th>路径</th><th>服务</th><th>域名</th><th>操作</th></tr></thead>
            <tbody>{hostnames.map((item) => <tr key={`${item.hostname}${item.path}`}>
              <td className="mono">{item.hostname}</td><td>{item.path || '/'}</td><td className="mono">{item.service}</td>
              <td>{item.zoneName || '未匹配'}</td>
              <td><button className="button button-quiet" disabled={busy} onClick={() => void removePublic(item)}>删除</button></td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      <section className="panel" aria-labelledby="cidr-title">
        <div className="panel-heading"><div><h2 id="cidr-title">CIDR 路由</h2></div><span className="panel-meta">Zero Trust</span></div>
        <form className="dns-search" onSubmit={addCidr}>
          <input value={cidrForm} onChange={(event) => setCidrForm(event.target.value)} placeholder="10.0.0.0/24" maxLength={64} aria-label="CIDR" />
          <button className="button button-secondary" type="submit" disabled={busy}>添加</button>
        </form>
        {cidrs.length === 0 ? <div className="panel-empty">没有 CIDR 路由。</div>
          : <ul className="route-list">{cidrs.map((route) => <li key={route.id}><span className="mono">{route.network}</span><button className="button button-quiet" disabled={busy} onClick={() => void removeCidr(route)}>删除</button></li>)}</ul>}
      </section>
      <section className="panel" aria-labelledby="route-title">
        <div className="panel-heading"><div><h2 id="route-title">主机名路由</h2></div><span className="panel-meta">Zero Trust</span></div>
        <form className="dns-search" onSubmit={addRoute}>
          <input value={routeForm} onChange={(event) => setRouteForm(event.target.value)} placeholder="app.example.com" maxLength={253} aria-label="主机名路由" />
          <button className="button button-secondary" type="submit" disabled={busy}>添加</button>
        </form>
        {routes.length === 0 ? <div className="panel-empty">没有主机名路由。</div>
          : <ul className="route-list">{routes.map((route) => <li key={route.id}><span className="mono">{route.hostname}</span><button className="button button-quiet" disabled={busy} onClick={() => void removeRoute(route)}>删除</button></li>)}</ul>}
      </section>
    </>}
  </>;
}
