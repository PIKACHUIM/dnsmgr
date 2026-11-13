import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { InfoTip } from './InfoTip';

interface Config { enabled: boolean; days: number; notifyEnabled: boolean; deployStart: number; deployEnd: number }
interface Props { session: Session; onExpired: (message: string) => void; onSaved?: () => void }

const CHANNELS = [
  ['webhook', '自定义 Webhook'], ['wxpusher', 'WxPusher'], ['telegram', 'Telegram'], ['wecom', '企业微信'],
  ['dingtalk', '钉钉'], ['feishu', '飞书'], ['mail', '邮件'], ['qqbot', 'QQ 机器人'],
] as const;
type ChannelMode = '0' | '1' | '2';

const HOURS = Array.from({ length: 24 }, (_, index) => index);

export function CertificateSettings({ session, onExpired, onSaved }: Props) {
  const [enabled, setEnabled] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [days, setDays] = useState('7');
  const [deployStart, setDeployStart] = useState('0');
  const [deployEnd, setDeployEnd] = useState('23');
  const [channels, setChannels] = useState<Record<string, ChannelMode>>({});
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
      const [result, notice] = await Promise.all([
        request<{ code: 0 } & Config>('/api/v1/system/certificate-renew', { signal }),
        request<{ code: 0; channels: Record<string, ChannelMode> }>('/api/v1/system/cert-notice', { signal }),
      ]);
      if (!signal.aborted) {
        setEnabled(result.enabled);
        setNotifyEnabled(result.notifyEnabled);
        setDays(String(result.days));
        setDeployStart(String(result.deployStart));
        setDeployEnd(String(result.deployEnd));
        setChannels(notice.channels);
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
        enabled, days: Number(days), notifyEnabled, deployStart: Number(deployStart), deployEnd: Number(deployEnd),
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      const updated = await send<{ code: 0; channels: Record<string, ChannelMode> }>('/api/v1/system/cert-notice', 'PUT', {
        channels,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setEnabled(result.enabled);
      setNotifyEnabled(result.notifyEnabled);
      setDays(String(result.days));
      setDeployStart(String(result.deployStart));
      setDeployEnd(String(result.deployEnd));
      setChannels(updated.channels);
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
          <div className="form-field"><div className="form-label"><label htmlFor="deploy-start">部署时间窗</label><InfoTip label="部署时间窗说明" text="cron 只在该时段内执行自动部署，跨天按环绕处理（例如 22 到 6）；手动“立即检查一次”不受限制。" /></div>
            <div className="dns-search">
              <select id="deploy-start" value={deployStart} disabled={busy} aria-label="部署开始小时" onChange={(event) => setDeployStart(event.target.value)}>
                {HOURS.map((hour) => <option key={hour} value={hour}>{hour} 时</option>)}
              </select>
              <span>—</span>
              <select value={deployEnd} disabled={busy} aria-label="部署结束小时" onChange={(event) => setDeployEnd(event.target.value)}>
                {HOURS.map((hour) => <option key={hour} value={hour}>{hour} 时</option>)}
              </select>
            </div>
          </div>
          <label className="certificate-confirm"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />启用证书自动续签</label>
          <label className="certificate-confirm"><input type="checkbox" checked={notifyEnabled} disabled={busy} onChange={(event) => setNotifyEnabled(event.target.checked)} />签发、续签与续签失败时发送通知</label>
          <fieldset className="form-field" style={{ gridColumn: '1 / -1' }}>
            <legend>证书通知渠道</legend>
            <div className="dns-search">
              {CHANNELS.map(([id, label]) => <label key={id} className="notice-channel-option">
                <span>{label}</span>
                <select value={channels[id] ?? '1'} disabled={busy} aria-label={`${label} 通知方式`}
                  onChange={(event) => setChannels({ ...channels, [id]: event.target.value as ChannelMode })}>
                  <option value="0">关闭</option>
                  <option value="1">开启</option>
                  <option value="2">仅失败时</option>
                </select>
              </label>)}
            </div>
          </fieldset>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void runOnce()}>立即检查一次</button>
          </div>
        </form>}
  </>;
}
