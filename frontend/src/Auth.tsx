import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, post, readSession, type Session } from './api';
import { Brand, Icon } from './icons';

interface AuthProps {
  mode: 'install' | 'login';
  notice?: string;
  onInstalled: (message: string) => void;
  onSignedIn: (session: Session) => void;
}

export function Auth({ mode, notice, onInstalled, onSignedIn }: AuthProps) {
  const installing = mode === 'install';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [code, setCode] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaEnabled, setCaptchaEnabled] = useState(true);
  const [captchaImage, setCaptchaImage] = useState('');
  const [captchaLoading, setCaptchaLoading] = useState(true);
  const [captchaError, setCaptchaError] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const loadCaptcha = useCallback(async (signal: AbortSignal) => {
    setCaptchaLoading(true);
    setCaptchaError('');
    setCaptchaCode('');
    try {
      const response = await fetch('/verifycode', {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { Accept: 'image/svg+xml' },
      });
      if (signal.aborted) return;
      if (response.status === 204 && response.headers.get('x-captcha-enabled') === '0') {
        setCaptchaEnabled(false);
        setCaptchaImage('');
        return;
      }
      const svg = await response.text();
      if (!response.ok || response.headers.get('x-captcha-enabled') !== '1' || svg.length > 8192 || !svg.trimStart().startsWith('<svg')) {
        throw new ApiError('验证码服务暂不可用。', response.status);
      }
      setCaptchaEnabled(true);
      setCaptchaImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    } catch {
      if (!signal.aborted) {
        setCaptchaEnabled(true);
        setCaptchaImage('');
        setCaptchaError('验证码加载失败，请点击“刷新验证码”重试。');
      }
    } finally {
      if (!signal.aborted) setCaptchaLoading(false);
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (challenge) codeInput.current?.focus();
  }, [challenge]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (installing || challenge) return;
    const abort = new AbortController();
    void loadCaptcha(abort.signal);
    return () => abort.abort();
  }, [challenge, installing, loadCaptcha]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (installing && password !== confirmation) {
      setError('两次输入的密码不一致，请重新确认。');
      return;
    }
    if (!username.trim()) {
      setError('请输入用户名。');
      return;
    }
    if (installing && !/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username.trim())) {
      setError('用户名需为 3–64 位字母、数字或 _.@-，不能包含空格。');
      return;
    }
    if (!challenge) {
      const passwordBytes = new TextEncoder().encode(password).length;
      if (passwordBytes > 72 || (installing && passwordBytes < 12)) {
        setError(installing ? '密码需要 12–72 个 UTF-8 字节，中文等字符会占用多个字节。' : '密码不能超过 72 个 UTF-8 字节。');
        return;
      }
      if (!installing && captchaEnabled && (!captchaImage || captchaLoading)) {
        setCaptchaError('请等待验证码加载完成，或点击刷新验证码重试。');
        return;
      }
      if (!installing && captchaEnabled && !/^\d{4}$/.test(captchaCode)) {
        setError('请输入图中 4 位数字验证码。');
        return;
      }
    }
    const signal = controller.current!.signal;
    setPending(true);
    try {
      if (installing) {
        const result = await post<{ code: 0; msg: string }>('/install', { username: username.trim(), password }, signal, { 'X-Setup-Token': setupToken.trim() });
        if (!signal.aborted) onInstalled(result.msg || '初始化完成，请使用新账户登录。');
      } else {
        const result = challenge
          ? await post<Session>('/auth/totp', { challenge, code }, signal)
          : await post<Session>('/login', {
            username: username.trim(), password, ...(captchaEnabled ? { code: captchaCode } : {}),
          }, signal);
        if (!signal.aborted) onSignedIn(readSession(result));
      }
    } catch (failure) {
      if (signal.aborted) return;
      const totpChallenge = !installing && failure instanceof ApiError
        && failure.body.vcode === 2 && typeof failure.body.challenge === 'string';
      const captchaRejected = failure instanceof ApiError && failure.body.reason === 'INVALID_CAPTCHA';
      if (!installing && !challenge && (captchaEnabled || captchaRejected) && !totpChallenge) {
        setCaptchaCode('');
        void loadCaptcha(signal);
      }
      if (totpChallenge) {
        setChallenge((failure as ApiError).body.challenge as string);
        setCode('');
        setPassword('');
      } else if (challenge && failure instanceof ApiError && failure.status === 401) {
        setChallenge(null);
        setCode('');
        setError(`${errorMessage(failure)}。本次验证请求已失效，请重新输入密码登录。`);
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      if (!signal.aborted) setPending(false);
    }
  }

  function restartLogin() {
    setChallenge(null);
    setCode('');
    setCaptchaCode('');
    setError('');
    requestAnimationFrame(() => usernameInput.current?.focus());
  }

  const title = installing ? '初始化管理系统' : challenge ? '验证动态口令' : '登录控制台';
  return <main className="auth-page">
    <section className="auth-context" aria-label="系统信息">
      <Brand />
      <div className="auth-context-body">
        <div className="section-kicker">系统接入 / ACCESS</div>
        <h2>从安全会话开始。</h2>
        <p>聚合 DNS 管理系统正在迁移至新的运行平台。安装与身份验证已开放，业务功能将按模块移植。</p>
        <ol className="access-steps" aria-label="接入步骤">
          <li className={installing ? 'current' : 'complete'}><span>01</span><div><strong>初始化系统</strong><small>创建首个管理员账户</small></div><b>{installing ? '当前步骤' : '已初始化'}</b></li>
          <li className={!installing ? 'current' : ''}><span>02</span><div><strong>验证身份</strong><small>登录并建立安全会话</small></div><b>{!installing ? '当前步骤' : '下一步'}</b></li>
          <li><span>03</span><div><strong>进入控制台</strong><small>查看真实环境与迁移状态</small></div><b>待登录</b></li>
        </ol>
      </div>
      <div className="auth-security"><Icon name="shield" /><span>Cookie 会话 · CSRF 保护 · 不在本地保存凭证</span></div>
    </section>
    <section className="auth-form-area" aria-labelledby="auth-title">
      <div className="auth-form-wrap">
        <div className="auth-eyebrow"><span className="status-dot" />{installing ? '首次安装' : '身份验证'}</div>
        <h1 id="auth-title">{title}</h1>
        <p className="auth-description">{installing ? '使用部署时配置的安装令牌授权初始化。此步骤只能执行一次。' : challenge ? '请输入验证器应用中的 6 位动态口令。若验证已过期，请返回重新登录。' : '输入系统账户和图形验证码。已启用动态口令的账户会进入第二步验证。'}</p>
        {notice && <div className="notice" role="status">{notice}</div>}
        {error && <div className="notice notice-error" role="alert" tabIndex={-1} ref={errorRef}><strong>操作未完成</strong><span>{error}</span></div>}
        {captchaError && <div className="notice notice-error" role="alert">{captchaError}</div>}
        <form onSubmit={submit} aria-busy={pending}>
          <fieldset disabled={pending}>
            {challenge ? <div className="form-field">
              <label htmlFor="totp">动态口令</label>
              <input ref={codeInput} id="totp" name="code" className="code-input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-describedby="totp-help" />
              <small id="totp-help">6 位数字，请使用当前有效的口令。</small>
            </div> : <>
              {installing && <div className="form-field">
                <label htmlFor="setup-token">安装令牌</label>
                <input id="setup-token" name="setupToken" type="password" autoComplete="off" minLength={32} maxLength={512} required value={setupToken} onChange={(event) => setSetupToken(event.target.value)} aria-describedby="setup-help" />
                <small id="setup-help">对应后端配置的 SETUP_TOKEN，至少 32 字符，仅用于首次初始化。</small>
              </div>}
              <div className="form-field">
                <label htmlFor="username">{installing ? '管理员用户名' : '用户名'}</label>
                <input ref={usernameInput} id="username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={installing ? 3 : 1} maxLength={64} required value={username} onChange={(event) => setUsername(event.target.value)} aria-describedby={installing ? 'username-help' : undefined} />
                {installing && <small id="username-help">3–64 位字母、数字或 _.@-，不含空格。</small>}
              </div>
              <div className="form-field">
                <label htmlFor="password">密码</label>
                <div className="password-field">
                  <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={installing ? 'new-password' : 'current-password'} minLength={1} maxLength={72} required value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={installing ? 'password-help' : undefined} />
                  <button type="button" className="password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? '隐藏' : '显示'}</button>
                </div>
                {installing && <small id="password-help">12–72 个 UTF-8 字节；中文通常占 3 字节。建议使用唯一的长密码。</small>}
              </div>
              {!installing && !challenge && captchaEnabled && <div className="form-field captcha-field">
                <label htmlFor="captcha">图形验证码</label>
                <div className="captcha-control">
                  <div className="captcha-image-frame">
                    {captchaImage ? <img src={captchaImage} alt="登录验证码" /> : <span role="status">{captchaLoading ? '正在加载验证码…' : '验证码不可用'}</span>}
                  </div>
                  <input id="captcha" name="captcha" className="code-input captcha-code-input" type="text" inputMode="numeric" autoComplete="off" pattern="[0-9]{4}" minLength={4} maxLength={4} required value={captchaCode} onChange={(event) => setCaptchaCode(event.target.value.replace(/\D/g, '').slice(0, 4))} aria-describedby="captcha-help" />
                  <button className="button button-secondary captcha-refresh" type="button" disabled={pending || captchaLoading} onClick={() => void loadCaptcha(controller.current!.signal)}>刷新验证码</button>
                </div>
                <small id="captcha-help">输入图中 4 位数字；每次登录尝试后验证码会刷新。</small>
              </div>}
              {installing && <div className="form-field">
                <label htmlFor="confirmation">确认密码</label>
                <input id="confirmation" name="confirmation" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={1} maxLength={72} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
              </div>}
            </>}
            <button type="submit" className="button button-primary auth-submit" disabled={pending || (!installing && !challenge && captchaEnabled && (captchaLoading || !captchaImage))}>{pending ? <><span className="spinner" />{installing ? '正在初始化…' : '正在验证…'}</> : <>{installing ? '初始化并创建账户' : challenge ? '验证并登录' : '登录控制台'}<Icon name="arrow" /></>}</button>
            {challenge && <button type="button" className="button button-quiet restart-login" onClick={restartLogin}>返回重新登录</button>}
          </fieldset>
        </form>
        <p className="auth-footnote"><Icon name="lock" />凭证仅发送至当前站点，登录后由服务端维护会话。</p>
      </div>
      <footer className="auth-footer"><span>聚合 DNS 管理系统</span><span className="mono">FOUNDATION</span></footer>
    </section>
  </main>;
}
