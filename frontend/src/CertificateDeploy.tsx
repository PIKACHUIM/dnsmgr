import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface DeployAccount {
  id: number; name: string; type: 'webhook' | 'executor'; remark: string | null;
  url: string; headersConfigured: boolean; tokenConfigured: boolean;
  label: string; path: string; command: string; createdAt: number; updatedAt: number;
}
interface DeployTask {
  id: number; name: string; accountId: number; accountName: string; accountType: 'webhook' | 'executor';
  certificateOrderId: number; domains: string[]; enabled: boolean; autoDeploy: boolean; target: string | null;
  lastRunAt: number | null; lastStatus: string | null; lastError: string | null;
}
interface DeployRun {
  id: number; taskId: number; status: 'pending' | 'running' | 'succeeded' | 'failed';
  detail: string | null; claimedBy: string | null; startedAt: number; finishedAt: number | null;
}
interface CertificateOrder { id: number; domains: string[]; expiresAt: number; revokedAt: number | null }
interface Props { session: Session; onExpired: (message: string) => void }

function date(value: number | null): string {
  return value === null ? '—' : new Date(value * 1000).toLocaleString();
}

function useSessionError(onExpired: (message: string) => void) {
  return useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else return errorMessage(failure);
    return '';
  }, [onExpired]);
}

export function DeployAccounts({ session, onExpired }: Props) {
  const [items, setItems] = useState<DeployAccount[]>([]);
  const [name, setName] = useState('');
  const [type, setType] = useState<'webhook' | 'executor'>('webhook');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [headers, setHeaders] = useState('');
  const [label, setLabel] = useState('');
  const [path, setPath] = useState('');
  const [command, setCommand] = useState('');
  const [remark, setRemark] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const handleFailure = useSessionError(onExpired);

  const handle = useCallback((failure: unknown) => {
    const message = handleFailure(failure);
    if (message) setError(message);
  }, [handleFailure]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const result = await request<{ code: 0; items: DeployAccount[] }>('/api/v1/cert/deploy/accounts', { signal });
      if (!signal.aborted) setItems(result.items);
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function reset() {
    setName(''); setUrl(''); setToken(''); setHeaders(''); setLabel(''); setPath(''); setCommand(''); setRemark(''); setEditing(null);
  }

  function edit(account: DeployAccount) {
    setEditing(account.id);
    setName(account.name); setType(account.type); setUrl(account.url); setToken(''); setHeaders('');
    setLabel(account.label); setPath(account.path); setCommand(account.command); setRemark(account.remark ?? '');
    setError(''); setNotice('');
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    const payload: Record<string, unknown> = { name: name.trim(), type, remark: remark.trim() };
    if (type === 'webhook') {
      payload.url = url.trim();
      if (token.trim()) payload.token = token.trim();
      if (headers.trim()) payload.headers = headers.trim();
    } else {
      payload.label = label.trim(); payload.path = path.trim(); payload.command = command.trim();
    }
    try {
      if (editing === null) await send('/api/v1/cert/deploy/accounts', 'POST', payload, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      else await send(`/api/v1/cert/deploy/accounts/${editing}`, 'PATCH', payload, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(editing === null ? '部署账户已创建。' : '部署账户已更新。');
      reset();
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(account: DeployAccount) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/deploy/accounts/${account.id}`, 'DELETE', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`部署账户 ${account.name} 已删除。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="deploy-account-title">
      <div className="panel-heading"><div><h2 id="deploy-account-title">自动部署账户</h2></div><span className="panel-meta">Webhook / 执行器</span></div>
      <p className="form-hint certificate-security-note">Webhook 账户把完整证书链与私钥以 JSON POST 到 HTTPS 地址；执行器账户把证书交给轮询式执行器，由执行器负责落盘与重载服务。凭据使用 AES-GCM 加密，保存后不回显。</p>
      <form className="dns-form certificate-setup-form" onSubmit={save}>
        <label className="form-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} /></label>
        <label className="form-field"><span>类型</span><select value={type} onChange={(event) => setType(event.target.value as 'webhook' | 'executor')} disabled={editing !== null}>
          <option value="webhook">Webhook（推送证书）</option><option value="executor">执行器（轮询领取）</option>
        </select></label>
        {type === 'webhook' ? <>
          <label className="form-field"><span>Webhook 地址</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required maxLength={2000} placeholder="https://deploy.example/hook" /></label>
          <label className="form-field"><span>Bearer Token（选填）</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} maxLength={500} autoComplete="new-password" placeholder={editing === null ? '用于 Authorization 头' : '留空保留原值'} /></label>
          <label className="form-field"><span>附加请求头 JSON（选填）</span><input value={headers} onChange={(event) => setHeaders(event.target.value)} maxLength={2000} placeholder='{"X-Source":"dnsmgr"}' /></label>
        </> : <>
          <label className="form-field"><span>执行器标签（选填）</span><input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={100} placeholder="node-1" /></label>
          <label className="form-field"><span>证书路径（选填）</span><input value={path} onChange={(event) => setPath(event.target.value)} maxLength={500} placeholder="/etc/ssl/dnsmgr" /></label>
          <label className="form-field"><span>部署后命令（选填）</span><input value={command} onChange={(event) => setCommand(event.target.value)} maxLength={500} placeholder="systemctl reload nginx" /></label>
        </>}
        <label className="form-field"><span>备注（选填）</span><input value={remark} onChange={(event) => setRemark(event.target.value)} maxLength={200} /></label>
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy || !name.trim() || (type === 'webhook' && !url.trim())}>{busy ? '正在保存…' : editing === null ? '创建部署账户' : '保存修改'}</button>
          {editing !== null && <button className="button button-quiet" type="button" onClick={reset}>取消编辑</button>}
        </div>
      </form>
    </section>
    <section className="panel" aria-labelledby="deploy-account-list-title">
      <div className="panel-heading"><div><h2 id="deploy-account-list-title">账户列表</h2></div><span className="panel-meta">共 {items.length} 条</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取部署账户…</div>
        : items.length === 0 ? <div className="panel-empty">还没有部署账户。</div>
          : <div className="table-wrap"><table className="data-table certificate-table">
            <thead><tr><th>账户</th><th>类型</th><th>目标</th><th>凭据</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>{items.map((account) => <tr key={account.id}>
              <td><strong>{account.name}</strong><span className="value-detail">{account.remark ?? '—'}</span></td>
              <td>{account.type === 'webhook' ? 'Webhook' : '执行器'}</td>
              <td className="mono">{account.type === 'webhook' ? account.url : [account.label, account.path, account.command].filter(Boolean).join(' · ') || '—'}</td>
              <td>{account.type === 'webhook' ? <>{account.tokenConfigured ? 'Bearer 已配置' : '无 Token'} {account.headersConfigured && <span className="value-detail">附加请求头已配置</span>}</> : '由执行器令牌保护'}</td>
              <td>{date(account.updatedAt)}</td>
              <td className="certificate-order-actions">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => edit(account)}>编辑</button>
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void remove(account)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
  </>;
}

export function DeployTasks({ session, onExpired }: Props) {
  const [accounts, setAccounts] = useState<DeployAccount[]>([]);
  const [orders, setOrders] = useState<CertificateOrder[]>([]);
  const [tasks, setTasks] = useState<DeployTask[]>([]);
  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [executorToken, setExecutorToken] = useState('');
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const handleFailure = useSessionError(onExpired);

  const handle = useCallback((failure: unknown) => {
    const message = handleFailure(failure);
    if (message) setError(message);
  }, [handleFailure]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const [accountResult, orderResult, taskResult, runResult] = await Promise.all([
        request<{ code: 0; items: DeployAccount[] }>('/api/v1/cert/deploy/accounts', { signal }),
        request<{ code: 0; items: CertificateOrder[] }>('/api/v1/cert/orders?limit=100&offset=0', { signal }),
        request<{ code: 0; items: DeployTask[] }>('/api/v1/cert/deploy/tasks', { signal }),
        request<{ code: 0; items: DeployRun[] }>('/api/v1/cert/deploy/runs', { signal }),
      ]);
      if (signal.aborted) return;
      setAccounts(accountResult.items);
      setOrders(orderResult.items.filter((order) => order.revokedAt === null));
      setTasks(taskResult.items);
      setRuns(runResult.items);
      setAccountId((current) => current || String(accountResult.items[0]?.id ?? ''));
      setOrderId((current) => current || String(orderResult.items.find((order) => order.revokedAt === null)?.id ?? ''));
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const loadExecutor = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await request<{ code: 0; token: string }>('/api/v1/system/executor', { signal });
      if (!signal.aborted) setExecutorToken(result.token);
    } catch (failure) { if (!signal.aborted) handle(failure); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void loadExecutor(controller.signal);
    return () => controller.abort();
  }, [loadExecutor]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/cert/deploy/tasks', 'POST', {
        name: name.trim(), accountId, certificateOrderId: orderId, target: target.trim() || undefined,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setName(''); setTarget('');
      setNotice('部署任务已创建；证书更新后由 cron 自动部署。');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function patch(task: DeployTask, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/deploy/tasks/${task.id}`, 'PATCH', body, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function run(task: DeployTask) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; ok: boolean; detail: string }>(`/api/v1/cert/deploy/tasks/${task.id}/run`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`部署任务 ${task.name}：${result.detail}`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(task: DeployTask) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/deploy/tasks/${task.id}`, 'DELETE', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`部署任务 ${task.name} 已删除。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function rotate() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; token: string }>('/api/v1/system/executor', 'PUT', { rotate: true }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setExecutorToken(result.token);
      setNotice('执行器令牌已轮换；旧令牌立即失效。');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  const orderLabel = (order: CertificateOrder) => `#${order.id} · ${order.domains.join(', ')}`;

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="deploy-task-title">
      <div className="panel-heading"><div><h2 id="deploy-task-title">自动部署任务</h2></div><span className="panel-meta">证书订单 → 部署账户</span></div>
      <p className="form-hint certificate-security-note">证书签发或续签后 <code>updated_at</code> 变化，cron 会按任务自动部署一次；手动“立即部署”不受证书更新时间限制。</p>
      {accounts.length === 0 ? <div className="panel-empty">请先在“自动部署账户”创建账户。</div>
        : <form className="dns-form certificate-setup-form" onSubmit={create}>
          <label className="form-field"><span>任务名称</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} /></label>
          <label className="form-field"><span>部署账户</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.type === 'webhook' ? 'Webhook' : '执行器'}</option>)}
          </select></label>
          <label className="form-field"><span>证书订单</span><select value={orderId} onChange={(event) => setOrderId(event.target.value)} required>
            <option value="">选择未吊销的证书</option>{orders.map((order) => <option key={order.id} value={order.id}>{orderLabel(order)}</option>)}
          </select></label>
          <label className="form-field"><span>目标标记（选填）</span><input value={target} onChange={(event) => setTarget(event.target.value)} maxLength={500} placeholder="web-1 / 站点名称" /></label>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !name.trim() || !accountId || !orderId}>{busy ? '正在保存…' : '创建部署任务'}</button></div>
        </form>}
    </section>
    <section className="panel" aria-labelledby="deploy-task-list-title">
      <div className="panel-heading"><div><h2 id="deploy-task-list-title">任务列表</h2></div><span className="panel-meta">共 {tasks.length} 条</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取部署任务…</div>
        : tasks.length === 0 ? <div className="panel-empty">还没有部署任务。</div>
          : <div className="table-wrap"><table className="data-table certificate-table">
            <thead><tr><th>任务</th><th>证书</th><th>账户</th><th>自动</th><th>最近运行</th><th>操作</th></tr></thead>
            <tbody>{tasks.map((task) => <tr key={task.id}>
              <td><strong>{task.name}</strong><span className="value-detail">{task.target ?? '未设置目标'}</span></td>
              <td className="mono">#{task.certificateOrderId}<span className="value-detail">{task.domains.join(', ')}</span></td>
              <td>{task.accountName}<span className="value-detail">{task.accountType === 'webhook' ? 'Webhook' : '执行器'}</span></td>
              <td>
                <label className="certificate-confirm"><input type="checkbox" checked={task.enabled} disabled={busy} onChange={(event) => void patch(task, { enabled: event.target.checked })} />启用</label>
                <label className="certificate-confirm"><input type="checkbox" checked={task.autoDeploy} disabled={busy} onChange={(event) => void patch(task, { autoDeploy: event.target.checked })} />自动</label>
              </td>
              <td><span>{task.lastStatus ?? '未运行'}</span><span className="value-detail">{date(task.lastRunAt)}</span>{task.lastError && <span className="value-detail certificate-order-error">{task.lastError}</span>}</td>
              <td className="certificate-order-actions">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => void run(task)}>立即部署</button>
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void remove(task)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    <section className="panel" aria-labelledby="deploy-run-title">
      <div className="panel-heading"><div><h2 id="deploy-run-title">运行记录</h2></div><span className="panel-meta">最近 50 条</span></div>
      {runs.length === 0 ? <div className="panel-empty">还没有部署运行记录。</div>
        : <div className="table-wrap"><table className="data-table certificate-table">
          <thead><tr><th>运行</th><th>任务</th><th>状态</th><th>执行者</th><th>时间</th><th>说明</th></tr></thead>
          <tbody>{runs.map((run) => <tr key={run.id}>
            <td className="mono">#{run.id}</td>
            <td className="mono">#{run.taskId}</td>
            <td>{run.status}</td>
            <td>{run.claimedBy ?? '—'}</td>
            <td>{date(run.startedAt)}<span className="value-detail">结束 {date(run.finishedAt)}</span></td>
            <td>{run.detail ?? '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <section className="panel" aria-labelledby="executor-token-title">
      <div className="panel-heading"><div><h2 id="executor-token-title">执行器接入</h2></div><span className="panel-meta">Bearer Token</span></div>
      <p className="form-hint certificate-security-note">执行器定期调用 <code>POST /api/v1/executor/claim</code> 领取任务，完成后调用 <code>POST /api/v1/executor/report</code> 回报结果。请求头使用 <code>Authorization: Bearer &lt;token&gt;</code>。</p>
      <div className="executor-token-row">
        <input readOnly value={executorToken} aria-label="执行器令牌" className="mono" />
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => void rotate()}>轮换令牌</button>
      </div>
      <div className="panel-footnote">令牌保存在服务端加密存储中，轮换后旧令牌立即失效；请只交给可信执行器。</div>
    </section>
  </>;
}
