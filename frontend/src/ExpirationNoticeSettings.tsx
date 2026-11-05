import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Config { days: string }
interface Props { session: Session; onExpired: (message: string) => void }

export function ExpirationNoticeSettings({ session, onExpired }: Props) {
  const [days, setDays] = useState('');
  const [loaded, setLoaded] = useState(false);
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
      const result = await request<{ code: 0 } & Config>('/api/v1/system/expiration-notice', { signal });
      if (!signal.aborted) {
        setDays(result.days);
        setLoaded(true);
      }
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0 } & Config>('/api/v1/system/expiration-notice', 'PUT', { days }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setDays(result.days);
      setNotice('到期提醒策略已保存');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="expiration-notice-title">
      <div className="panel-heading"><div><h2 id="expiration-notice-title">域名到期提醒设置</h2></div><span className="panel-meta">策略配置</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : !loaded ? <div className="panel-empty" role="status">设置读取失败，保存操作已禁用，请刷新页面重试。</div>
          : <form className="dns-form" onSubmit={save}>
          <label className="form-field"><span>到期提前提醒天数</span>
            <input type="text" inputMode="numeric" autoComplete="off" value={days} onChange={(event) => setDays(event.target.value)} maxLength={256} placeholder="例如：7,14" disabled={busy} />
          </label>
          <p className="form-hint">使用英文逗号分隔多个 0–3650 之间的天数，最多 32 项；填写 7,14 表示到期前 7 天和 14 天分别提醒。留空表示关闭提醒。</p>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button></div>
        </form>}
    </section>
    <section className="panel" aria-labelledby="expiration-notice-scope-title">
      <div className="panel-heading"><div><h2 id="expiration-notice-scope-title">迁移范围</h2></div><span className="panel-meta">尚未发送通知</span></div>
      <p>当前只保存提醒天数策略；cron 提醒触发、20 小时去重、09:00 发送门槛与通知渠道分发仍待迁移。保存设置不会立即发送通知。</p>
    </section>
  </>;
}
