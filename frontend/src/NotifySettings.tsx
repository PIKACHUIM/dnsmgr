import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Config { url: string; method: string; headers: string; contentType: string; body: string; configured: boolean }
interface Props { session: Session; onExpired: (message: string) => void }

export function NotifySettings({ session, onExpired }: Props) {
  const [config, setConfig] = useState<Config | null>(null);
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
      const result = await request<{ code: 0 } & Config>('/api/v1/system/notify', { signal });
      if (!signal.aborted) setConfig(result);
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function update(key: keyof Config, value: string) {
    setConfig((current) => current ? { ...current, [key]: value } : current);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!config || busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/system/notify', 'PUT', {
        url: config.url, method: config.method, headers: config.headers,
        contentType: config.contentType, body: config.body,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('通知设置已保存');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function test() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/system/notify/test', 'POST', { title: 'DNSMGR 测试通知', content: '如果你收到这条消息，说明自定义 Webhook 配置有效。' }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('测试通知已发送');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="notify-title">
      <div className="panel-heading"><div><h2 id="notify-title">自定义 Webhook</h2></div><span className="panel-meta">零第三方依赖的通知通道</span></div>
      {loading || !config ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : <form className="dns-form" onSubmit={save}>
          <label className="form-field"><span>Webhook URL</span><input value={config.url} onChange={(event) => update('url', event.target.value)} maxLength={1024} placeholder="https://example.com/hook" /></label>
          <label className="form-field"><span>方法</span><select value={config.method} onChange={(event) => update('method', event.target.value)}>
            <option value="POST">POST</option><option value="PUT">PUT</option><option value="GET">GET</option>
          </select></label>
          <label className="form-field"><span>Content-Type</span><input value={config.contentType} onChange={(event) => update('contentType', event.target.value)} maxLength={128} /></label>
          <label className="form-field"><span>请求头 JSON</span><input value={config.headers} onChange={(event) => update('headers', event.target.value)} maxLength={4096} placeholder='{"Authorization":"Bearer ..."}' /></label>
          <label className="form-field" style={{ gridColumn: '1 / -1' }}><span>请求体模板</span>
            <textarea value={config.body} onChange={(event) => update('body', event.target.value)} rows={5} maxLength={8192}
              placeholder='{"title":"{title}","content":"{content}"}' />
          </label>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={busy}>保存</button>
            <button className="button button-secondary" type="button" disabled={busy || !config.url} onClick={() => void test()}>发送测试</button>
            <span>模板支持 <code>{'{title}'}</code> 与 <code>{'{content}'}</code>；GET 会以查询参数发送。</span>
          </div>
        </form>}
    </section>
    <section className="panel" aria-labelledby="notify-help-title">
      <div className="panel-heading"><div><h2 id="notify-help-title">说明</h2></div><span className="panel-meta">当前范围</span></div>
      <p>当前只实现自定义 Webhook，不含 SMTP、Telegram、企业微信、钉钉、飞书或 QQ 机器人。请求走平台预算化 fetch，超时 15 秒；失败会返回上游状态码与响应片段。定时切换任务失败时也会尝试发送该 Webhook（未配置时静默跳过）。</p>
    </section>
  </>;
}
