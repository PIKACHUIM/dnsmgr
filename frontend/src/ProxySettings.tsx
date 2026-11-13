import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { InfoTip } from './InfoTip';

interface ProxyConfig {
  code: 0;
  enabled: boolean;
  url: string;
  username: string;
  hasPassword: boolean;
  noProxy: string;
}

interface Props { session: Session; onExpired: (message: string) => void }

export function ProxySettings({ session, onExpired }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [noProxy, setNoProxy] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const apply = useCallback((result: ProxyConfig) => {
    setEnabled(result.enabled);
    setUrl(result.url);
    setUsername(result.username);
    setNoProxy(result.noProxy);
    setHasPassword(result.hasPassword);
  }, []);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const result = await request<ProxyConfig>('/api/v1/system/proxy', { signal });
      if (!signal.aborted) apply(result);
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [apply, handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function test() {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await send<{ code: 0; reachable: boolean | null; detail: string }>('/api/v1/system/proxy/test', 'POST', {
        url, username,
        ...(password ? { password } : {}),
      }, new AbortController().signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(result.detail);
    } catch (failure) {
      handle(failure);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await send<ProxyConfig>('/api/v1/system/proxy', 'PUT', {
        enabled, url, username, noProxy,
        ...(password ? { password } : {}),
        ...(clearPassword ? { clearPassword: true } : {}),
      }, new AbortController().signal, { 'X-CSRF-Token': session.csrfToken });
      apply(result);
      setPassword('');
      setClearPassword(false);
      setNotice('代理设置已保存');
    } catch (failure) {
      handle(failure);
    } finally {
      setBusy(false);
    }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="proxy-title">
      <div className="panel-heading"><div><h2 id="proxy-title">外部请求代理</h2><InfoTip label="代理说明" text="支持 HTTP、HTTPS、SOCKS5；凭据加密保存，不会回显明文密码。配置会随执行器领取任务时下发，仅用于部署与优选执行器。" /></div><span className="panel-meta">执行器下发</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取代理设置…</div>
        : <form className="dns-form" onSubmit={save}>
          <label className="notice-channel-option"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>启用代理</span></label>
          <label className="form-field"><span>代理地址</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:7890 或 socks5://host:1080" maxLength={2000} /></label>
          <label className="form-field"><span>用户名（可选）</span><input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={128} autoComplete="off" /></label>
          <label className="form-field"><span>密码（可选）</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={hasPassword ? '已保存，留空保持不变' : '与用户名同时填写'} maxLength={512} autoComplete="new-password" /></label>
          {hasPassword && <label className="notice-channel-option"><input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} /><span>清除已保存的代理密码</span></label>}
          <label className="form-field"><span>排除列表（可选）</span><input value={noProxy} onChange={(event) => setNoProxy(event.target.value)} placeholder="localhost,127.0.0.1,*.internal" maxLength={2048} /></label>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存代理设置'}</button><button className="button button-secondary" type="button" disabled={busy || !url} onClick={() => void test()}>测试连通性</button></div>
        </form>}
    </section>
  </>;
}
