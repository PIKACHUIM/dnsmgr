import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { InfoTip } from './InfoTip';

interface UpdateState {
  code: 0;
  version: string;
  checkedAt: number;
  runtime: string;
  storage: { driver: string; format: string };
  schemaVersion: number;
  latestSchemaVersion: number;
  pendingMigrations: string[];
  pendingCount: number;
  upToDate: boolean;
  compatible: boolean;
  readOnly: boolean;
  applyHint: string;
}

interface Props { session: Session; onExpired: (message: string) => void }

export function SystemUpdate({ session, onExpired }: Props) {
  const [state, setState] = useState<UpdateState | null>(null);
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
      const result = await request<UpdateState>('/api/v1/system/update', { signal });
      if (!signal.aborted) setState(result);
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

  async function check() {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await send<UpdateState>('/api/v1/system/update/check', 'POST', undefined,
        new AbortController().signal, { 'X-CSRF-Token': session.csrfToken });
      setState(result);
      setNotice(result.upToDate ? '检查完成：数据库结构已是最新' : `检查完成：有 ${result.pendingCount} 个待执行迁移`);
    } catch (failure) {
      handle(failure);
    } finally {
      setBusy(false);
    }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="update-title">
      <div className="panel-heading"><div><h2 id="update-title">版本与迁移检查</h2><InfoTip label="迁移说明" text={`${state?.applyHint ?? '迁移命令需在部署环境执行，执行前请先备份 D1。'}`} /></div><span className="panel-meta">只读检查</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取版本信息…</div>
        : !state ? <div className="panel-empty" role="status">版本信息读取失败，请刷新重试。</div>
          : <>
            <dl className="data-list">
              <div><dt>应用版本</dt><dd className="mono">{state.version}</dd></div>
              <div><dt>运行平台</dt><dd>{state.runtime}<span className="value-detail mono">{state.storage.driver} / {state.storage.format}</span></dd></div>
              <div><dt>数据库结构</dt><dd>{state.schemaVersion} / {state.latestSchemaVersion}<span className="value-detail">{state.upToDate ? '已是最新' : `待执行 ${state.pendingCount} 个迁移`}</span></dd></div>
              <div><dt>兼容状态</dt><dd>{state.compatible ? '兼容' : '数据库结构高于当前应用版本'}<span className="value-detail">检查于 {new Date(state.checkedAt * 1000).toLocaleString('zh-CN')}</span></dd></div>
            </dl>
            {state.pendingMigrations.length > 0 && <div className="table-wrap"><table className="data-table">
              <thead><tr><th>#</th><th>待执行迁移</th></tr></thead>
              <tbody>{state.pendingMigrations.map((migration, index) => <tr key={migration}>
                <td>{index + 1}</td><td className="mono">{migration}</td>
              </tr>)}</tbody>
            </table></div>}
            <div className="form-actions">
              <button className="button button-primary" type="button" disabled={busy} onClick={() => void check()}>{busy ? '正在检查…' : '重新检查'}</button>
            </div>
            <div className="panel-footnote"><code className="mono">npx wrangler d1 migrations apply &lt;数据库绑定&gt; --remote</code></div>
          </>}
    </section>
  </>;
}
