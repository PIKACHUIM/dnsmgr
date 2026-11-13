import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, send, type Session } from './api';
import { InfoTip } from './InfoTip';

interface Props {
  session: Session;
  onExpired: (message: string) => void;
  onLoggedOut: (notice?: string) => void;
}

interface Enrollment {
  secret: string;
  challenge: string;
  uri: string;
}

interface QrOptions {
  text: string;
  width: number;
  height: number;
  foreground: string;
  background: string;
  typeNumber: number;
}

interface JQueryQr {
  (element: HTMLElement): { qrcode(options: QrOptions): void };
  fn: { qrcode?: unknown };
}

interface WindowWithJQuery extends Window {
  jQuery?: JQueryQr;
}

const JQUERY_URL = new URL('../../public/static/js/jquery-3.7.1.min.js', import.meta.url).href;
const QRCODE_URL = new URL('../../public/static/js/jquery-qrcode-1.0.min.js', import.meta.url).href;
let qrLibraryPromise: Promise<JQueryQr> | null = null;

function loadScript(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('二维码组件加载失败'));
    document.head.append(script);
  });
}

function loadQrLibrary(): Promise<JQueryQr> {
  const existing = (window as WindowWithJQuery).jQuery;
  if (existing?.fn.qrcode) return Promise.resolve(existing);
  if (qrLibraryPromise) return qrLibraryPromise;
  qrLibraryPromise = (async () => {
    if (!existing) await loadScript(JQUERY_URL);
    await loadScript(QRCODE_URL);
    const library = (window as WindowWithJQuery).jQuery;
    if (!library?.fn.qrcode) throw new Error('二维码组件未能初始化');
    return library;
  })().catch((failure: unknown) => {
    qrLibraryPromise = null;
    throw failure;
  });
  return qrLibraryPromise;
}

function isExpiredSession(failure: unknown): failure is ApiError {
  return failure instanceof ApiError && failure.status === 401
    && ['NOT_AUTHENTICATED', 'SESSION_REVOKED'].includes(String(failure.body.reason));
}

function isUnknownOutcome(failure: unknown): boolean {
  return failure instanceof ApiError
    && (failure.status === 0 || (failure.status >= 200 && failure.status < 300) || failure.status >= 500);
}

function isConcurrentChange(failure: unknown): boolean {
  return failure instanceof ApiError && failure.body.reason === 'CONCURRENT_CHANGE';
}

export function TotpSettings({ session, onExpired, onLoggedOut }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [closePassword, setClosePassword] = useState('');
  const [code, setCode] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [qrError, setQrError] = useState('');
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const qrHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = qrHost.current;
    if (!enrollment || !target) return;
    let active = true;
    target.replaceChildren();
    setQrError('');
    void loadQrLibrary().then((library) => {
      if (!active) return;
      const styles = getComputedStyle(target);
      library(target).qrcode({
        text: enrollment.uri,
        width: 180,
        height: 180,
        foreground: styles.getPropertyValue('--color-qr-foreground').trim(),
        background: styles.getPropertyValue('--color-qr-background').trim(),
        typeNumber: -1,
      });
    }).catch(() => {
      if (active) setQrError('二维码暂时无法显示，可手动输入下方密钥。');
    });
    return () => {
      active = false;
      target.replaceChildren();
    };
  }, [enrollment]);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; secret: string; challenge: string; uri: string }>(
        '/totp/generate', 'POST', { password: currentPassword }, controller.signal,
        { 'X-CSRF-Token': session.csrfToken },
      );
      if (!result.secret || !result.challenge || !result.uri) throw new ApiError('绑定信息不完整，请重试。', 502);
      setCurrentPassword('');
      setEnrollment(result);
      setCode('');
    } catch (failure) {
      if (isExpiredSession(failure)) onExpired('会话已失效，请重新登录。');
      else setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function bind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !enrollment) return;
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位动态口令');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; msg?: string }>(
        '/totp/bind', 'POST', { challenge: enrollment.challenge, code }, controller.signal,
        { 'X-CSRF-Token': session.csrfToken },
      );
      onLoggedOut(result.msg || '动态口令已启用，请重新登录');
    } catch (failure) {
      if (isExpiredSession(failure) || isConcurrentChange(failure)) {
        onExpired('账户状态已变更，请重新登录。');
      } else if (isUnknownOutcome(failure)) {
        setEnrollment(null);
        setCode('');
        setCurrentPassword('');
        setOutcomeUnknown(true);
        setError('绑定结果未确认。请勿重复提交，刷新页面后重新检查动态口令状态。');
      } else {
        const reason = failure instanceof ApiError ? String(failure.body.reason) : '';
        if (['CHALLENGE_EXPIRED', 'INVALID_CHALLENGE', 'INVALID_TOTP', 'TOTP_REPLAY'].includes(reason)) {
          setEnrollment(null);
          setCode('');
          setError(`${errorMessage(failure)} 请重新生成二维码后再试。`);
        } else {
          setError(errorMessage(failure));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function close(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !window.confirm('关闭后，登录时将不再要求动态口令。确定继续吗？')) return;
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位动态口令');
      return;
    }
    setBusy(true);
    setError('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; msg?: string }>(
        '/totp/close', 'POST', { password: closePassword, code }, controller.signal,
        { 'X-CSRF-Token': session.csrfToken },
      );
      onLoggedOut(result.msg || '动态口令已关闭，请重新登录');
    } catch (failure) {
      if (isExpiredSession(failure) || isConcurrentChange(failure)) onExpired('账户状态已变更，请重新登录。');
      else if (isUnknownOutcome(failure)) {
        setClosePassword('');
        setCode('');
        setOutcomeUnknown(true);
        setError('关闭结果未确认。请勿重复提交，刷新页面后重新检查动态口令状态。');
      } else setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    if (!enrollment) return;
    setError('');
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      setNotice('密钥已复制；请勿分享，并在完成绑定后移除剪贴板中的副本。');
    } catch {
      setNotice('无法访问剪贴板，请手动选择并复制密钥。');
    }
  }

  return <section className="panel" aria-labelledby="totp-title">
    <div className="panel-heading"><div><h2 id="totp-title">TOTP 二次验证</h2><InfoTip label="动态口令说明" text="开启后，登录需要输入认证器生成的动态口令；绑定完成会撤销所有现有会话并要求重新登录。关闭操作需要当前密码和有效的动态口令。" /></div><span className="panel-meta">本人账户</span></div>
    {error && <div className="notice notice-error" role="alert" aria-live="assertive">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {outcomeUnknown ? <div className="totp-unknown">
      <p role="status">请勿重复提交；刷新页面以重新读取服务端动态口令状态。</p>
      <button className="button button-secondary" type="button" autoFocus onClick={() => window.location.reload()}>重新检查动态口令状态</button>
    </div> : session.totpEnabled ? <>
      <div className="totp-state"><span className="status-dot" />动态口令已开启</div>
      <form className="dns-form" onSubmit={close} aria-busy={busy}>
        <label className="form-field"><span>当前密码</span>
          <input type="password" autoComplete="current-password" maxLength={72} required disabled={busy} value={closePassword} onChange={(event) => setClosePassword(event.target.value)} />
        </label>
        <label className="form-field"><span>当前动态口令</span>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        <div className="form-actions"><button className="button button-secondary" type="submit" disabled={busy}>{busy ? '正在关闭…' : '关闭动态口令'}</button></div>
      </form>
    </> : enrollment ? <>
      <div className="totp-enrollment">
        <p role="status">使用认证器扫描二维码；无法扫描时，可手动输入密钥。绑定挑战有效期为 3 分钟，且只能使用一次。</p>
        <div className="totp-qr" role="img" aria-label="TOTP 绑定二维码"><div ref={qrHost} /></div>
        {qrError && <p className="totp-qr-error" role="status">{qrError}</p>}
        <div className="totp-secret"><span>手动设置密钥</span><code>{enrollment.secret}</code><button className="button button-secondary" type="button" disabled={busy} onClick={() => void copySecret()}>复制密钥</button></div>
      </div>
      <form className="dns-form" onSubmit={bind} aria-busy={busy}>
        <label className="form-field"><span>认证器中的 6 位动态口令</span>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus disabled={busy} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在验证…' : '完成绑定'}</button><button className="button button-secondary" type="button" disabled={busy} onClick={() => { setEnrollment(null); setCode(''); setError(''); }}>取消</button></div>
      </form>
    </> : <>
      <form className="dns-form" onSubmit={generate} aria-busy={busy}>
        <label className="form-field"><span>当前密码</span>
          <input type="password" autoComplete="current-password" maxLength={72} required disabled={busy} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在生成…' : '开启动态口令'}</button></div>
      </form>
    </>}
  </section>;
}
