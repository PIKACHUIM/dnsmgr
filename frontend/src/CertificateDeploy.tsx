import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { InfoTip } from './InfoTip';
import { Modal } from './Modal';

type DeployFieldType = 'input' | 'password' | 'textarea' | 'select' | 'radio' | 'checkbox';

interface DeployFieldOption { value: string; label: string }
interface DeployShow { key: string; in?: string[]; notIn?: string[] }
type DeployShowWhen = DeployShow | { all: DeployShowWhen[] } | { any: DeployShowWhen[] };
interface DeployField {
  key: string; label: string; type?: DeployFieldType; required?: boolean; secret?: boolean;
  placeholder?: string; note?: string; options?: DeployFieldOption[]; defaultValue?: string;
  maxLength?: number; showWhen?: DeployShowWhen;
}
interface DeployProvider {
  type: string; name: string; category: 'panel' | 'cloud' | 'storage'; description?: string;
  note?: string; taskNote?: string; fields: DeployField[]; taskFields: DeployField[];
}
interface DeployAccount {
  id: number; name: string; type: string; remark: string | null;
  fields: Record<string, string>; secrets: string[]; createdAt: number; updatedAt: number;
}
interface DeployTask {
  id: number; name: string; accountId: number; accountName: string; accountType: string;
  certificateOrderId: number; domains: string[]; enabled: boolean; autoDeploy: boolean;
  target: string | null; config: Record<string, string>;
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

function showVisible(values: Record<string, string>, show?: DeployShowWhen): boolean {
  if (!show) return true;
  if ('all' in show) return show.all.every((item) => showVisible(values, item));
  if ('any' in show) return show.any.some((item) => showVisible(values, item));
  const value = values[show.key] ?? '';
  if (show.in) return show.in.includes(value);
  if (show.notIn) return !show.notIn.includes(value);
  return true;
}

function visible(field: DeployField, values: Record<string, string>): boolean {
  return showVisible(values, field.showWhen);
}

function defaults(fields: DeployField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) values[field.key] = field.defaultValue;
    else if (field.type === 'checkbox') values[field.key] = '0';
  }
  return values;
}

function DeployFieldInput({ field, value, secretConfigured, onChange }: {
  field: DeployField; value: string; secretConfigured?: boolean;
  onChange: (value: string) => void;
}) {
  const label = <span>{field.label}{field.required ? '' : '（选填）'}</span>;
  const required = field.required && !(field.secret && secretConfigured);
  if (field.type === 'checkbox') {
    return <label className="certificate-confirm">
      <input type="checkbox" checked={value === '1'} onChange={(event) => onChange(event.target.checked ? '1' : '0')} />
      {field.label}
    </label>;
  }
  if (field.type === 'select' || field.type === 'radio') {
    const options = field.options ?? [];
    return <label className="form-field">{label}
      <select value={value || field.defaultValue || ''} onChange={(event) => onChange(event.target.value)} required={field.required}>
        {field.type === 'radio' && <option value="">请选择</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {field.note && <span className="form-hint">{field.note}</span>}
    </label>;
  }
  const placeholder = field.secret && secretConfigured ? '已配置，留空保持不变' : field.placeholder;
  if (field.type === 'textarea') {
    return <label className="form-field">{label}
      <textarea value={value} onChange={(event) => onChange(event.target.value)} required={required}
        maxLength={field.maxLength ?? 2000} placeholder={placeholder} spellCheck={false} />
      {field.note && <span className="form-hint">{field.note}</span>}
    </label>;
  }
  return <label className="form-field">{label}
    <input type={field.secret ? 'password' : 'text'} value={value} onChange={(event) => onChange(event.target.value)}
      required={required} maxLength={field.maxLength ?? 500} placeholder={placeholder}
      autoComplete={field.secret ? 'new-password' : 'off'} />
    {field.note && <span className="form-hint">{field.note}</span>}
  </label>;
}

function configSummary(fields: DeployField[], config: Record<string, string>): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (!visible(field, config)) continue;
    const value = config[field.key];
    if (!value) continue;
    if (field.type === 'select' || field.type === 'radio') {
      parts.push(field.options?.find((option) => option.value === value)?.label ?? value);
    } else if (field.type === 'textarea') {
      parts.push(value.split('\n').map((item) => item.trim()).filter(Boolean).join('、'));
    } else if (field.type !== 'checkbox') {
      parts.push(value);
    }
  }
  return parts.join(' · ');
}

export function DeployAccounts({ session, onExpired }: Props) {
  const [providers, setProviders] = useState<DeployProvider[]>([]);
  const [items, setItems] = useState<DeployAccount[]>([]);
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [remark, setRemark] = useState('');
  const [editing, setEditing] = useState<DeployAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const handleFailure = useSessionError(onExpired);

  const handle = useCallback((failure: unknown) => {
    const message = handleFailure(failure);
    if (message) setError(message);
  }, [handleFailure]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const [catalog, list] = await Promise.all([
        request<{ code: 0; providers: DeployProvider[] }>('/api/v1/cert/deploy/providers', { signal }),
        request<{ code: 0; items: DeployAccount[] }>('/api/v1/cert/deploy/accounts', { signal }),
      ]);
      if (signal.aborted) return;
      setProviders(catalog.providers);
      setItems(list.items);
      setType((current) => current || catalog.providers[0]?.type || '');
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const selected = providers.find((provider) => provider.type === type);

  function openForm(account: DeployAccount | null = null) {
    const nextType = account?.type ?? providers[0]?.type ?? '';
    const meta = providers.find((provider) => provider.type === nextType);
    setEditing(account);
    setName(account?.name ?? '');
    setType(nextType);
    setValues({ ...defaults(meta?.fields ?? []), ...(account?.fields ?? {}) });
    setRemark(account?.remark ?? '');
    setError('');
    setNotice('');
    setFormOpen(true);
  }

  function changeType(next: string) {
    setType(next);
    const meta = providers.find((provider) => provider.type === next);
    setValues(defaults(meta?.fields ?? []));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !selected) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    const payload: Record<string, unknown> = { name: name.trim(), type, remark: remark.trim() };
    for (const field of selected.fields) {
      const value = values[field.key] ?? '';
      if (field.secret && editing && !value) continue;
      payload[field.key] = field.type === 'checkbox' ? value === '1' : value;
    }
    try {
      if (!editing) await send('/api/v1/cert/deploy/accounts', 'POST', payload, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      else await send(`/api/v1/cert/deploy/accounts/${editing.id}`, 'PATCH', payload, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(editing ? '部署账户已更新。' : '部署账户已创建。');
      setEditing(null);
      setFormOpen(false);
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

  const providerName = (value: string) => providers.find((provider) => provider.type === value)?.name ?? value;

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="deploy-account-list-title">
      <div className="panel-heading"><div><h2 id="deploy-account-list-title">部署账户</h2><InfoTip label="部署账户说明" text="按驱动保存面板地址或云厂商密钥，可直接把证书部署到宝塔站点、腾讯云 CDN/CLB 等资源；Webhook 与执行器账户保留原有行为。凭据使用 AES-GCM 加密，保存后不回显。" /></div><div className="panel-heading-actions"><span className="panel-meta">共 {items.length} 条</span><button className="button button-primary" type="button" disabled={loading} onClick={() => { setError(''); setNotice(''); openForm(); }}><Icon name="plus" />添加账户</button></div></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取部署账户…</div>
        : items.length === 0 ? <div className="panel-empty">还没有部署账户。</div>
          : <div className="table-wrap"><table className="data-table certificate-table">
            <thead><tr><th>账户</th><th>类型</th><th>配置</th><th>凭据</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>{items.map((account) => <tr key={account.id}>
              <td><strong>{account.name}</strong><span className="value-detail">{account.remark ?? '—'}</span></td>
              <td>{providerName(account.type)}</td>
              <td className="mono">{Object.entries(account.fields).map(([key, value]) => `${key}=${value}`).join(' · ') || '—'}</td>
              <td>{account.secrets.length > 0 ? `已配置 ${account.secrets.length} 项密钥` : '无密钥'}</td>
              <td>{date(account.updatedAt)}</td>
              <td className="certificate-order-actions">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => openForm(account)}>编辑</button>
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void remove(account)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    {formOpen && <Modal title={editing ? '编辑部署账户' : '添加部署账户'} wide onClose={() => { if (!busy) setFormOpen(false); }}>
      <form className="dns-form certificate-setup-form" onSubmit={save}>
        <label className="form-field"><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} /></label>
        <label className="form-field"><span>类型</span><select value={type} onChange={(event) => changeType(event.target.value)} disabled={Boolean(editing)} required>
          {providers.map((provider) => <option key={provider.type} value={provider.type}>{provider.name}</option>)}
        </select>{selected?.description && <span className="form-hint">{selected.description}</span>}{selected?.note && <span className="form-hint">{selected.note}</span>}</label>
        {selected?.fields.filter((field) => visible(field, values)).map((field) => <DeployFieldInput key={`${selected.type}-${field.key}`} field={field}
          value={values[field.key] ?? field.defaultValue ?? ''}
          secretConfigured={editing ? editing.secrets.includes(field.key) : false}
          onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />)}
        <label className="form-field"><span>备注（选填）</span><input value={remark} onChange={(event) => setRemark(event.target.value)} maxLength={200} /></label>
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy || !name.trim() || !type}>{busy ? '正在验证…' : editing ? '保存修改' : '创建部署账户'}</button>
          <button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>取消</button>
        </div>
      </form>
    </Modal>}
  </>;
}

export function DeployTasks({ session, onExpired }: Props) {
  const [providers, setProviders] = useState<DeployProvider[]>([]);
  const [accounts, setAccounts] = useState<DeployAccount[]>([]);
  const [orders, setOrders] = useState<CertificateOrder[]>([]);
  const [tasks, setTasks] = useState<DeployTask[]>([]);
  const [runs, setRuns] = useState<DeployRun[]>([]);
  const [executorToken, setExecutorToken] = useState('');
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [target, setTarget] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<DeployTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [taskOpen, setTaskOpen] = useState(false);
  const handleFailure = useSessionError(onExpired);

  const handle = useCallback((failure: unknown) => {
    const message = handleFailure(failure);
    if (message) setError(message);
  }, [handleFailure]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const [catalog, accountResult, orderResult, taskResult, runResult] = await Promise.all([
        request<{ code: 0; providers: DeployProvider[] }>('/api/v1/cert/deploy/providers', { signal }),
        request<{ code: 0; items: DeployAccount[] }>('/api/v1/cert/deploy/accounts', { signal }),
        request<{ code: 0; items: CertificateOrder[] }>('/api/v1/cert/orders?limit=100&offset=0', { signal }),
        request<{ code: 0; items: DeployTask[] }>('/api/v1/cert/deploy/tasks', { signal }),
        request<{ code: 0; items: DeployRun[] }>('/api/v1/cert/deploy/runs', { signal }),
      ]);
      if (signal.aborted) return;
      setProviders(catalog.providers);
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

  const account = accounts.find((item) => String(item.id) === accountId);
  const provider = providers.find((item) => item.type === account?.type);
  const taskFields = provider?.taskFields ?? [];

  function openTask(task: DeployTask | null = null) {
    const nextAccountId = task ? String(task.accountId) : (accountId || String(accounts[0]?.id ?? ''));
    const nextAccount = accounts.find((item) => String(item.id) === nextAccountId);
    const nextProvider = providers.find((item) => item.type === nextAccount?.type);
    setEditing(task);
    setName(task?.name ?? '');
    setAccountId(nextAccountId);
    setOrderId(task ? String(task.certificateOrderId) : (orderId || String(orders[0]?.id ?? '')));
    setTarget(task?.target ?? '');
    setConfig({ ...defaults(nextProvider?.taskFields ?? []), ...(task?.config ?? {}) });
    setError('');
    setNotice('');
    setTaskOpen(true);
  }

  function changeAccount(next: string) {
    setAccountId(next);
    const nextAccount = accounts.find((item) => String(item.id) === next);
    const nextProvider = providers.find((item) => item.type === nextAccount?.type);
    setConfig(defaults(nextProvider?.taskFields ?? []));
  }

  async function saveTask(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    const payload: Record<string, unknown> = {
      name: name.trim(), accountId, certificateOrderId: orderId, target: target.trim() || undefined,
      config: Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)),
    };
    try {
      if (!editing) await send('/api/v1/cert/deploy/tasks', 'POST', payload, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      else await send(`/api/v1/cert/deploy/tasks/${editing.id}`, 'PATCH', payload, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setTaskOpen(false);
      setEditing(null);
      setNotice(editing ? '部署任务已更新。' : '部署任务已创建；证书更新后由 cron 自动部署。');
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
  const providerName = (value: string) => providers.find((item) => item.type === value)?.name ?? value;
  const summaryOf = (task: DeployTask) => {
    const meta = providers.find((item) => item.type === task.accountType);
    const summary = configSummary(meta?.taskFields ?? [], task.config ?? {});
    return summary || task.target || '未设置目标';
  };

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="deploy-task-list-title">
      <div className="panel-heading"><div><h2 id="deploy-task-list-title">部署任务</h2><InfoTip label="部署任务说明" text="证书签发或续签后 updated_at 变化，cron 会按任务自动部署一次；手动“立即部署”不受证书更新时间限制。任务配置由所选驱动决定，例如宝塔的部署类型与站点列表、腾讯云的产品与实例。" /></div><div className="panel-heading-actions"><span className="panel-meta">共 {tasks.length} 条</span><button className="button button-primary" type="button" disabled={loading || accounts.length === 0 || orders.length === 0} onClick={() => { setError(''); setNotice(''); openTask(); }}><Icon name="plus" />新建任务</button></div></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取部署任务…</div>
        : tasks.length === 0 ? <div className="panel-empty">还没有部署任务。</div>
          : <div className="table-wrap"><table className="data-table certificate-table">
            <thead><tr><th>任务</th><th>证书</th><th>账户</th><th>自动</th><th>最近运行</th><th>操作</th></tr></thead>
            <tbody>{tasks.map((task) => <tr key={task.id}>
              <td><strong>{task.name}</strong><span className="value-detail">{summaryOf(task)}</span></td>
              <td className="mono">#{task.certificateOrderId}<span className="value-detail">{task.domains.join(', ')}</span></td>
              <td>{task.accountName}<span className="value-detail">{providerName(task.accountType)}</span></td>
              <td>
                <label className="certificate-confirm"><input type="checkbox" checked={task.enabled} disabled={busy} onChange={(event) => void patch(task, { enabled: event.target.checked })} />启用</label>
                <label className="certificate-confirm"><input type="checkbox" checked={task.autoDeploy} disabled={busy} onChange={(event) => void patch(task, { autoDeploy: event.target.checked })} />自动</label>
              </td>
              <td><span>{task.lastStatus ?? '未运行'}</span><span className="value-detail">{date(task.lastRunAt)}</span>{task.lastError && <span className="value-detail certificate-order-error">{task.lastError}</span>}</td>
              <td className="certificate-order-actions">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => openTask(task)}>编辑</button>
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
      <div className="panel-heading"><div><h2 id="executor-token-title">执行器接入</h2><InfoTip label="执行器接入说明" text="执行器定期调用 POST /api/v1/executor/claim 领取任务，完成后调用 POST /api/v1/executor/report 回报结果。请求头使用 Authorization: Bearer <token>。轮换后旧令牌立即失效。" /></div><span className="panel-meta">Bearer Token</span></div>
      <div className="executor-token-row">
        <input readOnly value={executorToken} aria-label="执行器令牌" className="mono" />
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => void rotate()}>轮换令牌</button>
      </div>
    </section>
    {taskOpen && <Modal title={editing ? '编辑部署任务' : '新建部署任务'} wide onClose={() => { if (!busy) { setTaskOpen(false); setEditing(null); } }}>
      <form className="dns-form certificate-setup-form" onSubmit={saveTask}>
        <label className="form-field"><span>任务名称</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={64} /></label>
        <label className="form-field"><span>部署账户</span><select value={accountId} onChange={(event) => changeAccount(event.target.value)} required disabled={Boolean(editing)}>
          {accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {providerName(item.type)}</option>)}
        </select></label>
        <label className="form-field"><span>证书订单</span><select value={orderId} onChange={(event) => setOrderId(event.target.value)} required disabled={Boolean(editing)}>
          <option value="">选择未吊销的证书</option>{orders.map((order) => <option key={order.id} value={order.id}>{orderLabel(order)}</option>)}
        </select></label>
        <label className="form-field"><span>目标标记（选填）</span><input value={target} onChange={(event) => setTarget(event.target.value)} maxLength={500} placeholder="web-1 / 站点名称" /></label>
        {provider?.taskNote && <span className="form-hint">{provider.taskNote}</span>}
        {taskFields.filter((field) => visible(field, config)).map((field) => <DeployFieldInput key={`${account?.type}-${field.key}`} field={field}
          value={config[field.key] ?? field.defaultValue ?? ''}
          onChange={(value) => setConfig((current) => ({ ...current, [field.key]: value }))} />)}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !name.trim() || !accountId || !orderId}>{busy ? '正在保存…' : editing ? '保存修改' : '创建部署任务'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => { setTaskOpen(false); setEditing(null); }}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
