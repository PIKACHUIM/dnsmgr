import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface UserItem {
  id: number;
  username: string;
  level: number;
  status: number;
  isApi: boolean;
  hasApiKey: boolean;
  hasTotp: boolean;
  expiresAt: number | null;
  createdAt: number;
  permissionCount: number;
  sessionCount: number;
}

interface PermissionItem { id: number; name: string; allowed: boolean }

interface Props { session: Session; onExpired: (message: string) => void }

const levels = [
  { value: 0, label: '只读用户' },
  { value: 1, label: '普通用户' },
  { value: 2, label: '管理员' },
];

function levelLabel(level: number): string {
  return levels.find((entry) => entry.value === level)?.label ?? `LEVEL ${level}`;
}

function dateValue(seconds: number | null): string {
  return seconds === null ? '' : new Date(seconds * 1000).toISOString().slice(0, 10);
}

function secondsValue(value: string): number | null {
  if (!value) return null;
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

export function Users({ session, onExpired }: Props) {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [level, setLevel] = useState(1);
  const [expires, setExpires] = useState('');
  const [isApi, setIsApi] = useState(false);

  const [editing, setEditing] = useState<UserItem | null>(null);
  const [editLevel, setEditLevel] = useState(1);
  const [editStatus, setEditStatus] = useState(1);
  const [editExpires, setEditExpires] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editApi, setEditApi] = useState(false);
  const [rotateApiKey, setRotateApiKey] = useState(false);
  const [resetTotp, setResetTotp] = useState(false);

  const [permissionsFor, setPermissionsFor] = useState<UserItem | null>(null);
  const [domains, setDomains] = useState<PermissionItem[]>([]);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const result = await request<{ code: 0; items: UserItem[] }>('/api/v1/users', { signal });
      if (!signal.aborted) setUsers(result.items);
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function refresh() {
    const controller = new AbortController();
    await load(controller.signal);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await send<{ code: 0; apikey?: string }>(
        '/api/v1/users', 'POST',
        { username, password, level, expiresAt: secondsValue(expires), isApi },
        new AbortController().signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setUsername(''); setPassword(''); setLevel(1); setExpires(''); setIsApi(false);
      setNotice(result.apikey ? `用户已创建。API Key（仅显示一次）：${result.apikey}` : '用户已创建');
      await refresh();
    } catch (failure) {
      handle(failure);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(user: UserItem) {
    setEditing(user);
    setEditLevel(user.level);
    setEditStatus(user.status);
    setEditExpires(dateValue(user.expiresAt));
    setEditPassword('');
    setEditApi(user.isApi);
    setRotateApiKey(false);
    setResetTotp(false);
    setNotice('');
    setError('');
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await send<{ code: 0; apikey?: string }>(
        `/api/v1/users/${editing.id}`, 'PATCH',
        {
          level: editLevel, status: editStatus, expiresAt: secondsValue(editExpires),
          ...(editPassword ? { password: editPassword } : {}),
          isApi: editApi, ...(rotateApiKey ? { rotateApiKey: true } : {}),
          ...(resetTotp ? { resetTotp: true } : {}),
        },
        new AbortController().signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setEditing(null);
      setNotice(result.apikey ? `用户已更新。新的 API Key（仅显示一次）：${result.apikey}` : '用户已更新');
      await refresh();
    } catch (failure) {
      handle(failure);
    } finally {
      setBusy(false);
    }
  }

  async function remove(user: UserItem) {
    if (!window.confirm(`确定删除用户 ${user.username} 吗？其会话与域名权限会一并移除。`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await send(`/api/v1/users/${user.id}`, 'DELETE', undefined, new AbortController().signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('用户已删除');
      if (editing?.id === user.id) setEditing(null);
      if (permissionsFor?.id === user.id) setPermissionsFor(null);
      await refresh();
    } catch (failure) {
      handle(failure);
    } finally {
      setBusy(false);
    }
  }

  async function openPermissions(user: UserItem) {
    setPermissionsFor(user);
    setDomains([]);
    setError('');
    setNotice('');
    try {
      const result = await request<{ code: 0; domains: PermissionItem[] }>(`/api/v1/users/${user.id}/permissions`);
      setDomains(result.domains);
    } catch (failure) {
      handle(failure);
    }
  }

  async function savePermissions(event: FormEvent) {
    event.preventDefault();
    if (!permissionsFor || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await send(`/api/v1/users/${permissionsFor.id}/permissions`, 'PUT', {
        domainIds: domains.filter((domain) => domain.allowed).map((domain) => domain.id),
      }, new AbortController().signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`已更新 ${permissionsFor.username} 的域名权限，相关会话已失效`);
      setPermissionsFor(null);
      await refresh();
    } catch (failure) {
      handle(failure);
    } finally {
      setBusy(false);
    }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="user-create-title">
      <div className="panel-heading"><div><h2 id="user-create-title">新增用户</h2></div><span className="panel-meta">最多 200 个账户</span></div>
      <form className="dns-form" onSubmit={create}>
        <label className="form-field"><span>用户名</span><input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={64} required placeholder="3–64 位字母、数字或 _.@-" autoComplete="off" /></label>
        <label className="form-field"><span>初始密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="12–72 字节" autoComplete="new-password" /></label>
        <label className="form-field"><span>角色</span>
          <select value={level} onChange={(event) => setLevel(Number(event.target.value))}>
            {levels.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label className="form-field"><span>到期日期（可选）</span><input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} /></label>
        <label className="notice-channel-option"><input type="checkbox" checked={isApi} onChange={(event) => setIsApi(event.target.checked)} /><span>启用旧版签名 API</span></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '创建用户'}</button><span>API 用户的密钥只在创建或轮换时显示一次。</span></div>
      </form>
    </section>

    <section className="panel" aria-labelledby="user-list-title">
      <div className="panel-heading"><div><h2 id="user-list-title">用户列表</h2></div><span className="panel-meta">{users.length} 个</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取用户…</div>
        : users.length === 0 ? <div className="panel-empty">还没有用户。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>API</th><th>动态口令</th><th>域名权限</th><th>到期</th><th>操作</th></tr></thead>
            <tbody>{users.map((user) => <tr key={user.id}>
              <td>{user.username}<span className="value-detail mono">ID {user.id}</span></td>
              <td>{levelLabel(user.level)}</td>
              <td>{user.status === 1 ? '启用' : '禁用'}<span className="value-detail">{user.sessionCount} 个会话</span></td>
              <td>{user.isApi ? (user.hasApiKey ? '已启用' : '缺少密钥') : '未启用'}</td>
              <td>{user.hasTotp ? '已绑定' : '未绑定'}</td>
              <td>{user.level === 2 ? '全部（管理员）' : user.permissionCount}</td>
              <td>{user.expiresAt ? new Date(user.expiresAt * 1000).toLocaleDateString('zh-CN') : '长期'}</td>
              <td className="row-actions">
                <button className="button button-secondary" disabled={busy} onClick={() => startEdit(user)}>编辑</button>
                <button className="button button-secondary" disabled={busy || user.level === 2} onClick={() => void openPermissions(user)}>权限</button>
                <button className="button button-quiet" disabled={busy || user.id === session.user.id} onClick={() => void remove(user)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>

    {editing && <section className="panel" aria-labelledby="user-edit-title">
      <div className="panel-heading"><div><h2 id="user-edit-title">编辑用户：{editing.username}</h2></div><span className="panel-meta">修改安全设置会使会话失效</span></div>
      <form className="dns-form" onSubmit={saveEdit}>
        <label className="form-field"><span>角色</span>
          <select value={editLevel} onChange={(event) => setEditLevel(Number(event.target.value))}>
            {levels.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        </label>
        <label className="form-field"><span>状态</span>
          <select value={editStatus} onChange={(event) => setEditStatus(Number(event.target.value))}>
            <option value={1}>启用</option><option value={0}>禁用</option>
          </select>
        </label>
        <label className="form-field"><span>到期日期</span><input type="date" value={editExpires} onChange={(event) => setEditExpires(event.target.value)} /></label>
        <label className="form-field"><span>重置密码（留空不修改）</span><input type="password" value={editPassword} onChange={(event) => setEditPassword(event.target.value)} placeholder="12–72 字节" autoComplete="new-password" /></label>
        <label className="notice-channel-option"><input type="checkbox" checked={editApi} onChange={(event) => setEditApi(event.target.checked)} /><span>启用旧版签名 API</span></label>
        {editApi && <label className="notice-channel-option"><input type="checkbox" checked={rotateApiKey} onChange={(event) => setRotateApiKey(event.target.checked)} /><span>轮换 API Key</span></label>}
        <label className="notice-channel-option"><input type="checkbox" checked={resetTotp} onChange={(event) => setResetTotp(event.target.checked)} /><span>解绑动态口令</span></label>
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存修改'}</button>
          <button className="button button-quiet" type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
        </div>
      </form>
    </section>}

    {permissionsFor && <section className="panel" aria-labelledby="user-permission-title">
      <div className="panel-heading"><div><h2 id="user-permission-title">域名权限：{permissionsFor.username}</h2></div><span className="panel-meta">{domains.filter((domain) => domain.allowed).length} 个域名</span></div>
      {domains.length === 0 ? <div className="panel-empty">当前还没有可分配的域名。</div>
        : <form className="dns-form" onSubmit={savePermissions}>
          <fieldset className="notice-channel-grid"><legend>允许访问的域名</legend>
            <div className="notice-channel-options">{domains.map((domain) => <label className="notice-channel-option" key={domain.id}>
              <input type="checkbox" checked={domain.allowed} onChange={(event) => setDomains((current) => current.map((item) => item.id === domain.id ? { ...item, allowed: event.target.checked } : item))} />
              <span>{domain.name}</span>
            </label>)}</div>
          </fieldset>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存权限'}</button>
            <button className="button button-quiet" type="button" disabled={busy} onClick={() => setPermissionsFor(null)}>取消</button>
          </div>
        </form>}
    </section>}
  </>;
}
