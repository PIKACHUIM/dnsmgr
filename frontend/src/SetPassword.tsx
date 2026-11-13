import { useState, type FormEvent } from 'react';
import { ApiError, errorMessage, send, type Session } from './api';
import { InfoTip } from './InfoTip';
import { TotpSettings } from './TotpSettings';

interface Props {
  session: Session;
  onExpired: (message: string) => void;
  onLoggedOut: (notice?: string) => void;
}

export function SetPassword({ session, onExpired, onLoggedOut }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (password !== confirmation) {
      setError('两次输入的新密码不一致');
      return;
    }
    const passwordBytes = new TextEncoder().encode(password).length;
    if (passwordBytes < 12 || passwordBytes > 72) {
      setError('新密码需为 12–72 个 UTF-8 字节');
      return;
    }

    setBusy(true);
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; msg?: string }>('/setpwd', 'POST', { currentPassword, password }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      onLoggedOut(result.msg || '密码已更新，请重新登录');
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401 && failure.body.reason !== 'INVALID_CREDENTIALS') {
        onExpired('会话已失效，请重新登录。');
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  return <>
    <section className="panel" aria-labelledby="set-password-title">
      <div className="panel-heading"><div><h2 id="set-password-title">修改当前账户密码</h2></div><span className="panel-meta">本人账户</span></div>
      <form className="dns-form" onSubmit={submit} aria-busy={busy}>
        <label className="form-field"><span>当前密码</span>
          <input type="password" autoComplete="current-password" maxLength={72} required disabled={busy} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <div className="form-field"><div className="form-label"><label htmlFor="new-password">新密码</label><InfoTip label="密码规则" text="新密码须为 12–72 个 UTF-8 字节；空格会按原样保留。更新后所有现有会话都会失效，需要重新登录。" /></div>
          <input id="new-password" type="password" autoComplete="new-password" maxLength={72} required disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <label className="form-field"><span>确认新密码</span>
          <input type="password" autoComplete="new-password" maxLength={72} required disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在更新…' : '更新密码'}</button></div>
      </form>
      {error && <div className="notice notice-error" role="alert" aria-live="assertive">{error}</div>}
    </section>
    <TotpSettings session={session} onExpired={onExpired} onLoggedOut={onLoggedOut} />
  </>;
}
