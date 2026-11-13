import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { InfoTip } from './InfoTip';

interface Config { enabled: boolean; days: number; notifyEnabled: boolean }
interface Props { session: Session; onExpired: (message: string) => void; onSaved?: () => void }

export function CertificateSettings({ session, onExpired, onSaved }: Props) {
  const [enabled, setEnabled] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [days, setDays] = useState('7');
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
      const result = await request<{ code: 0 } & Config>('/api/v1/system/certificate-renew', { signal });
      if (!signal.aborted) {
        setEnabled(result.enabled);
        setNotifyEnabled(result.notifyEnabled);
        setDays(String(result.days));
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
      const result = await send<{ code: 0 } & Config>('/api/v1/system/certificate-renew', 'PUT', {
        enabled, days: Number(days), notifyEnabled,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setEnabled(result.enabled);
      setNotifyEnabled(result.notifyEnabled);
      setDays(String(result.days));
      setNotice('自动续签设置已保存');
      onSaved?.();
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function runOnce() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; processed: boolean; detail: string }>(
        '/api/v1/system/certificate-renew/run', 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(result.detail);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
      : !loaded ? <div className="panel-empty" role="status">设置读取失败，保存操作已禁用，请刷新页面重试。</div>
        : <form className="dns-form" onSubmit={save}>
          <div className="form-field"><div className="form-label"><label htmlFor="renew-days">到期前续签天数</label><InfoTip label="续签说明" text="只处理已开启“自动续签”的证书订单。cron 每次最多推进一步 CA/DNS 操作；结果未知或失败时停止，等待人工核对。TXT 创建后至少等待 60 秒再通知 CA 验证。吊销、失败或结果未知的订单不会自动重试。" /></div>
            <input id="renew-days" type="number" inputMode="numeric" min={1} max={60} value={days} onChange={(event) => setDays(event.target.value)} disabled={busy} required />
          </div>
          <label className="certificate-confirm"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />启用证书自动续签</label>
          <label className="certificate-confirm"><input type="checkbox" checked={notifyEnabled} disabled={busy} onChange={(event) => setNotifyEnabled(event.target.checked)} />签发、续签与续签失败时发送通知</label>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void runOnce()}>立即检查一次</button>
          </div>
        </form>}
  </>;
}
