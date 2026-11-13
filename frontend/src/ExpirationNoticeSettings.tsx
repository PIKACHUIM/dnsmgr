import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { InfoTip } from './InfoTip';

const NOTICE_CHANNELS = [
  { key: 'webhook', label: '自定义 Webhook' },
  { key: 'wxpusher', label: 'WxPusher' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'wecom', label: '企业微信' },
  { key: 'dingtalk', label: '钉钉' },
  { key: 'feishu', label: '飞书' },
] as const;
type NoticeChannel = typeof NOTICE_CHANNELS[number]['key'];
type ChannelSettings = Record<NoticeChannel, boolean>;
interface Config { days: string; channels: ChannelSettings }
interface Props { session: Session; onExpired: (message: string) => void }

const DEFAULT_CHANNELS: ChannelSettings = {
  webhook: true, wxpusher: true, telegram: true, wecom: true, dingtalk: true, feishu: true,
};

export function ExpirationNoticeSettings({ session, onExpired }: Props) {
  const [days, setDays] = useState('');
  const [channels, setChannels] = useState<ChannelSettings>(DEFAULT_CHANNELS);
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
      const result = await request<{ code: 0 } & Config>('/api/v1/system/expiration-notice', { signal });
      if (!signal.aborted) {
        setDays(result.days);
        setChannels(result.channels);
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
      const result = await send<{ code: 0 } & Config>('/api/v1/system/expiration-notice', 'PUT', { days, channels }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setDays(result.days);
      setChannels(result.channels);
      setNotice('到期提醒策略已保存');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="expiration-notice-title">
      <div className="panel-heading"><div><h2 id="expiration-notice-title">域名到期提醒设置</h2><InfoTip label="到期提醒规则" text="保存策略不会立即发送通知。cron 每分钟运行；没有到期查询工作时，才在配置时区 09:00 后按剩余天数分组发送，每次至多一组、最多 10 个域名。单域名发送后冷却 20 小时，发送失败也会冷却。" /></div><span className="panel-meta">策略配置</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : !loaded ? <div className="panel-empty" role="status">设置读取失败，保存操作已禁用，请刷新页面重试。</div>
          : <form className="dns-form" onSubmit={save}>
          <div className="form-field"><div className="form-label"><label htmlFor="expiration-days">到期提前提醒天数</label><InfoTip label="提醒天数格式" text="使用英文逗号分隔多个 0–3650 之间的天数，最多 32 项；填写 7,14 表示到期前 7 天和 14 天分别提醒。留空表示关闭提醒。" /></div>
            <input id="expiration-days" type="text" inputMode="numeric" autoComplete="off" value={days} onChange={(event) => setDays(event.target.value)} maxLength={256} placeholder="例如：7,14" disabled={busy} />
          </div>
          <fieldset className="notice-channel-grid" disabled={busy} aria-label="到期提醒通知渠道">
            <legend>提醒发送渠道 <InfoTip label="发送渠道规则" text="只会向已配置且已启用的渠道发送。所有开关关闭时不发送，并释放本次提醒占用。" /></legend>
            <div className="notice-channel-options">
              {NOTICE_CHANNELS.map(({ key, label }) => <label className="notice-channel-option" key={key}>
                <input type="checkbox" checked={channels[key]} onChange={(event) => setChannels((current) => ({ ...current, [key]: event.target.checked }))} />
                <span>{label}</span>
              </label>)}
            </div>
          </fieldset>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button></div>
        </form>}
    </section>
  </>;
}
