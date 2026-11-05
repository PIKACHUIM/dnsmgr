import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Config { code: 0; vcode: '1' | '2'; enabled: boolean }
interface Props { session: Session; onExpired: (message: string) => void }

export function LoginCaptchaSettings({ session, onExpired }: Props) {
  const [enabled, setEnabled] = useState(true);
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
      const result = await request<Config>('/api/v1/system/login-captcha', { signal });
      if (result.code !== 0 || (result.vcode !== '1' && result.vcode !== '2') || typeof result.enabled !== 'boolean') {
        throw new ApiError('登录设置响应不完整，请重试。', 502);
      }
      if (!signal.aborted) {
        setEnabled(result.enabled);
        setLoaded(true);
      }
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

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<Config>(
        '/api/v1/system/login-captcha', 'PUT', { vcode: enabled ? '1' : '2' }, controller.signal,
        { 'X-CSRF-Token': session.csrfToken },
      );
      setEnabled(result.enabled);
      setNotice('登录设置已保存');
    } catch (failure) {
      const expired = failure instanceof ApiError && failure.status === 401;
      handle(failure);
      if (!expired) {
        setLoaded(false);
        const refresh = new AbortController();
        await load(refresh.signal);
      }
    } finally {
      setBusy(false);
    }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="login-captcha-title">
      <div className="panel-heading"><div><h2 id="login-captcha-title">登录安全设置</h2></div><span className="panel-meta">身份验证</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : !loaded ? <div className="panel-empty" role="status">设置读取失败，保存操作已禁用，请刷新页面重试。</div>
          : <form className="dns-form" onSubmit={save}>
            <fieldset className="login-captcha-setting" disabled={busy}>
              <label className="login-captcha-toggle">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                <span>启用图形验证码</span>
              </label>
              <p className="form-hint">开启后，登录需输入一次性 4 位图形验证码；每张图有效 30 分钟，最多可错 4 次。单 IP 每分钟最多签发 10 张、登录 30 次；全站保护上限为 120 张和 300 次（用户共享）。每个账户密码和动态口令均受 5 次/120 秒限额保护；并发验证也占用额度，成功后清除对应计数。TOTP 接口另受单 IP 30 次/分钟与全站 300 次/分钟限流。关闭后立即免验证码，并废弃尚未使用的挑战。</p>
            </fieldset>
            <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存登录设置'}</button></div>
          </form>}
    </section>
  </>;
}
