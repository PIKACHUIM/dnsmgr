import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Config { enabled: boolean; days: number; notifyEnabled: boolean }
interface Props { session: Session; onExpired: (message: string) => void }

export function CertificateSettings({ session, onExpired }: Props) {
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
    <section className="panel" aria-labelledby="certificate-renew-title">
      <div className="panel-heading"><div><h2 id="certificate-renew-title">自动续签设置</h2></div><span className="panel-meta">ACME DNS-01</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : !loaded ? <div className="panel-empty" role="status">设置读取失败，保存操作已禁用，请刷新页面重试。</div>
          : <form className="dns-form" onSubmit={save}>
            <label className="form-field"><span>到期前续签天数</span>
              <input type="number" inputMode="numeric" min={1} max={60} value={days} onChange={(event) => setDays(event.target.value)} disabled={busy} required />
            </label>
            <label className="certificate-confirm"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />启用证书自动续签</label>
            <label className="certificate-confirm"><input type="checkbox" checked={notifyEnabled} disabled={busy} onChange={(event) => setNotifyEnabled(event.target.checked)} />签发、续签与续签失败时发送通知</label>
            <p className="form-hint">只处理已开启“自动续签”的证书订单。cron 每次最多推进一步 CA/DNS 操作；结果未知或失败时停止，等待人工核对。通知复用“通知设置”中已启用的渠道。</p>
            <div className="form-actions">
              <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => void runOnce()}>立即检查一次</button>
            </div>
          </form>}
    </section>
    <section className="panel" aria-labelledby="certificate-renew-scope-title">
      <div className="panel-heading"><div><h2 id="certificate-renew-scope-title">执行边界</h2></div><span className="panel-meta">由 /cron 触发</span></div>
      <p>续签会复用原证书的 ACME 账户与 DNS Zone，为到期订单创建新的签发任务，并在新证书写入订单时记录续签来源。cron 每次只推进一个 CA 或 DNS 操作；TXT 创建后至少等待 60 秒再通知 CA 验证。吊销、失败或结果未知的订单不会自动重试，也不会被删除。签发、续签成功与续签失败会按通知设置发送消息；自动部署在“自动部署任务”中配置。</p>
    </section>
  </>;
}
