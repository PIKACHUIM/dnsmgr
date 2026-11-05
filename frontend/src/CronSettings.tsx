import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Config { enabled: boolean; key: string; offset: number; url: string }
interface Props { session: Session; onExpired: (message: string) => void }

export function CronSettings({ session, onExpired }: Props) {
  const [config, setConfig] = useState<Config | null>(null);
  const [offset, setOffset] = useState('480');
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
      const result = await request<{ code: 0 } & Config>('/api/v1/system/cron', { signal });
      if (signal.aborted) return;
      setConfig(result);
      setOffset(String(result.offset));
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function update(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0 } & Config>('/api/v1/system/cron', 'PUT', body, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setConfig(result);
      setOffset(String(result.offset));
      setNotice('定时设置已保存');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function runNow() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; ran: number; failed: number }>('/api/v1/schedule/run', 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`执行完成：成功 ${result.ran}，失败 ${result.failed}`);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="cron-title">
      <div className="panel-heading"><div><h2 id="cron-title">HTTP 定时入口</h2></div><span className="panel-meta">每分钟调用一次</span></div>
      {loading || !config ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : <div className="dns-form">
          <label className="form-field"><span>状态</span><select value={config.enabled ? '1' : '0'} disabled={busy} onChange={(event) => void update({ enabled: event.target.value === '1' })}>
            <option value="0">关闭</option><option value="1">开启</option>
          </select></label>
          <label className="form-field"><span>访问密钥</span><input readOnly value={config.key} className="mono" /></label>
          <label className="form-field"><span>时区偏移（分钟）</span><input type="number" min={-840} max={840} value={offset} onChange={(event) => setOffset(event.target.value)} onBlur={() => void update({ offset: Number(offset) })} /></label>
          <div className="form-actions">
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void update({ regenerate: true })}>重新生成密钥</button>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void runNow()}>立即执行</button>
            <span>调用地址 <code>{config.url}</code></span>
          </div>
        </div>}
    </section>
    <section className="panel" aria-labelledby="cron-note-title">
      <div className="panel-heading"><div><h2 id="cron-note-title">部署说明</h2></div><span className="panel-meta">外部调度器</span></div>
      <p>在服务器 crontab 或平台定时器中每分钟请求上面的 URL。除 DNS 定时任务和容灾检查外，每次最多查询一个域名到期信息：优先处理首次/手动排队查询，再复查过去 5 天至未来 30 天内、至少 24 小时未检查的记录。密钥以明文比较但使用常量时间实现；不要把它放进前端代码或公开日志。任务按「时区偏移」计算下一次执行时间，默认 +480 分钟（UTC+8）。</p>
      <pre className="mono">* * * * * curl -fsS "https://你的域名{config?.url ?? '/cron?key=...'}" &gt;/dev/null 2&gt;&amp;1</pre>
    </section>
  </>;
}
