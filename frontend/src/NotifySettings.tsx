import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Config {
  url: string; method: string; headers: string; contentType: string; body: string;
  configured: boolean; webhookConfigured: boolean; urlConfigured: boolean; headersConfigured: boolean; bodyConfigured: boolean;
  wxpusherAppToken: string; wxpusherUids: string; wxpusherConfigured: boolean;
  wxpusherTokenConfigured: boolean; wxpusherUidsConfigured: boolean;
  telegramBotToken: string; telegramChatId: string; telegramTopicId: string; telegramConfigured: boolean;
  telegramTokenConfigured: boolean; telegramChatIdConfigured: boolean; telegramTopicIdConfigured: boolean;
  wecomWebhookUrl: string; wecomConfigured: boolean; wecomUrlConfigured: boolean;
  dingtalkWebhookUrl: string; dingtalkSecret: string; dingtalkAtMobiles: string;
  dingtalkConfigured: boolean; dingtalkUrlConfigured: boolean; dingtalkSecretConfigured: boolean; dingtalkAtMobilesConfigured: boolean;
  feishuWebhookUrl: string; feishuUserIds: string; feishuConfigured: boolean; feishuUrlConfigured: boolean; feishuUserIdsConfigured: boolean;
  mailTo: string; mailFrom: string; mailConfigured: boolean; mailToConfigured: boolean; mailFromConfigured: boolean; mailBindingAvailable: boolean;
  qqbotAppId: string; qqbotAppSecret: string; qqbotOpenId: string; qqbotConfigured: boolean;
  qqbotAppIdConfigured: boolean; qqbotAppSecretConfigured: boolean; qqbotOpenIdConfigured: boolean; qqbotWebhookUrl: string;
  clearUrl: boolean; clearHeaders: boolean; clearBody: boolean;
  clearWxpusherAppToken: boolean; clearWxpusherUids: boolean; clearTelegram: boolean; clearWecom: boolean; clearDingtalk: boolean; clearFeishu: boolean;
  clearMail: boolean; clearQqbot: boolean;
}
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
      const result = await request<{ code: 0 } & Omit<Config, 'clearUrl' | 'clearHeaders' | 'clearBody' | 'clearWxpusherAppToken' | 'clearWxpusherUids' | 'clearTelegram' | 'clearWecom' | 'clearDingtalk' | 'clearFeishu' | 'clearMail' | 'clearQqbot'>>('/api/v1/system/notify', { signal });
      if (!signal.aborted) setConfig({ ...result, clearUrl: false, clearHeaders: false, clearBody: false, clearWxpusherAppToken: false, clearWxpusherUids: false, clearTelegram: false, clearWecom: false, clearDingtalk: false, clearFeishu: false, clearMail: false, clearQqbot: false });
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function update(key: 'url' | 'method' | 'headers' | 'contentType' | 'body' | 'wxpusherAppToken' | 'wxpusherUids' | 'telegramBotToken' | 'telegramChatId' | 'telegramTopicId' | 'wecomWebhookUrl' | 'dingtalkWebhookUrl' | 'dingtalkSecret' | 'dingtalkAtMobiles' | 'feishuWebhookUrl' | 'feishuUserIds' | 'mailTo' | 'mailFrom' | 'qqbotAppId' | 'qqbotAppSecret' | 'qqbotOpenId', value: string) {
    setConfig((current) => {
      if (!current) return current;
      const updated = { ...current, [key]: value };
      if (key === 'url') updated.clearUrl = false;
      if (key === 'headers') updated.clearHeaders = false;
      if (key === 'body') updated.clearBody = false;
      if (key === 'wxpusherAppToken' || key === 'wxpusherUids') {
        updated.clearWxpusherAppToken = false;
        updated.clearWxpusherUids = false;
      }
      if (key === 'telegramBotToken' || key === 'telegramChatId' || key === 'telegramTopicId') updated.clearTelegram = false;
      if (key === 'wecomWebhookUrl') updated.clearWecom = false;
      if (key === 'dingtalkWebhookUrl' || key === 'dingtalkSecret' || key === 'dingtalkAtMobiles') updated.clearDingtalk = false;
      if (key === 'feishuWebhookUrl' || key === 'feishuUserIds') updated.clearFeishu = false;
      if (key === 'mailTo' || key === 'mailFrom') updated.clearMail = false;
      if (key === 'qqbotAppId' || key === 'qqbotAppSecret' || key === 'qqbotOpenId') updated.clearQqbot = false;
      return updated;
    });
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
        clearUrl: config.clearUrl, clearHeaders: config.clearHeaders, clearBody: config.clearBody,
        wxpusherAppToken: config.wxpusherAppToken, wxpusherUids: config.wxpusherUids,
        clearWxpusherAppToken: config.clearWxpusherAppToken, clearWxpusherUids: config.clearWxpusherUids,
        telegramBotToken: config.telegramBotToken, telegramChatId: config.telegramChatId, telegramTopicId: config.telegramTopicId,
        clearTelegram: config.clearTelegram, wecomWebhookUrl: config.wecomWebhookUrl, clearWecom: config.clearWecom,
        dingtalkWebhookUrl: config.dingtalkWebhookUrl, dingtalkSecret: config.dingtalkSecret,
        dingtalkAtMobiles: config.dingtalkAtMobiles, clearDingtalk: config.clearDingtalk,
        feishuWebhookUrl: config.feishuWebhookUrl, feishuUserIds: config.feishuUserIds, clearFeishu: config.clearFeishu,
        mailTo: config.mailTo, mailFrom: config.mailFrom, clearMail: config.clearMail,
        qqbotAppId: config.qqbotAppId, qqbotAppSecret: config.qqbotAppSecret, qqbotOpenId: config.qqbotOpenId, clearQqbot: config.clearQqbot,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setConfig((current) => current ? {
        ...current, url: '', headers: '', body: '', wxpusherAppToken: '', wxpusherUids: '',
        telegramBotToken: '', telegramChatId: '', telegramTopicId: '',
        clearUrl: false, clearHeaders: false, clearBody: false,
        clearWxpusherAppToken: false, clearWxpusherUids: false, clearTelegram: false, wecomWebhookUrl: '', clearWecom: false,
        dingtalkWebhookUrl: '', dingtalkSecret: '', dingtalkAtMobiles: '', clearDingtalk: false,
        feishuWebhookUrl: '', feishuUserIds: '', clearFeishu: false,
        mailTo: '', mailFrom: '', clearMail: false, qqbotAppSecret: '', qqbotOpenId: '', clearQqbot: false,
      } : current);
      setNotice('通知设置已保存');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function test() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/system/notify/test', 'POST', { title: 'DNSMGR 测试通知', content: '如果你收到这条消息，说明通知渠道配置有效。' }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('测试通知已发送');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="notify-title">
      <div className="panel-heading"><div><h2 id="notify-title">通知渠道</h2></div><span className="panel-meta">凭据使用 AES-GCM 加密</span></div>
      {loading || !config ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : <form className="dns-form" onSubmit={save}>
          <h3>自定义 Webhook</h3>
          <p className="form-hint">已保存的 URL、请求头和模板不会回显。留空表示保留现有值；勾选清除后保存可删除对应配置。</p>
          <label className="form-field"><span>Webhook URL</span><input value={config.url} onChange={(event) => update('url', event.target.value)} maxLength={1024} placeholder={config.urlConfigured ? '已配置，留空保留' : 'https://example.com/hook'} /></label>
          <label className="form-field"><span>方法</span><select value={config.method} onChange={(event) => update('method', event.target.value)}>
            <option value="POST">POST</option><option value="PUT">PUT</option><option value="GET">GET</option>
          </select></label>
          <label className="form-field"><span>Content-Type</span><input value={config.contentType} onChange={(event) => update('contentType', event.target.value)} maxLength={128} /></label>
          <label className="form-field"><span>请求头 JSON</span><input value={config.headers} onChange={(event) => update('headers', event.target.value)} maxLength={4096} placeholder={config.headersConfigured ? '已配置，留空保留' : '{"Authorization":"Bearer ..."}'} /></label>
          <label className="form-field" style={{ gridColumn: '1 / -1' }}><span>请求体模板</span>
            <textarea value={config.body} onChange={(event) => update('body', event.target.value)} rows={5} maxLength={8192}
              placeholder={config.bodyConfigured ? '已配置，留空保留' : '{"title":"{title}","content":"{content}"}'} />
          </label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearUrl} onChange={(event) => setConfig({ ...config, clearUrl: event.target.checked })} /> 清除已保存 URL</span></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearHeaders} onChange={(event) => setConfig({ ...config, clearHeaders: event.target.checked })} /> 清除已保存请求头</span></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearBody} onChange={(event) => setConfig({ ...config, clearBody: event.target.checked })} /> 清除已保存模板</span></label>
          <h3>WxPusher</h3>
          <label className="form-field"><span>AppToken</span><input value={config.wxpusherAppToken} onChange={(event) => update('wxpusherAppToken', event.target.value)} maxLength={256} placeholder={config.wxpusherTokenConfigured ? '已配置，留空保留' : '填写 WxPusher AppToken'} /></label>
          <label className="form-field"><span>接收用户 UID</span><input value={config.wxpusherUids} onChange={(event) => update('wxpusherUids', event.target.value)} maxLength={2048} placeholder={config.wxpusherUidsConfigured ? '已配置，留空保留' : 'UID_xxx，可用逗号分隔多个'} /></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearWxpusherAppToken && config.clearWxpusherUids} onChange={(event) => setConfig({ ...config, clearWxpusherAppToken: event.target.checked, clearWxpusherUids: event.target.checked })} /> 清除 WxPusher 凭据</span></label>
          <h3>Telegram</h3>
          <label className="form-field"><span>Bot Token</span><input value={config.telegramBotToken} onChange={(event) => update('telegramBotToken', event.target.value)} maxLength={256} placeholder={config.telegramTokenConfigured ? '已配置，留空保留' : '填写 Telegram Bot Token'} /></label>
          <label className="form-field"><span>Chat ID</span><input value={config.telegramChatId} onChange={(event) => update('telegramChatId', event.target.value)} maxLength={128} placeholder={config.telegramChatIdConfigured ? '已配置，留空保留' : '数字 ID 或 @channelusername'} /></label>
          <label className="form-field"><span>Topic ID（选填）</span><input value={config.telegramTopicId} onChange={(event) => update('telegramTopicId', event.target.value)} maxLength={12} placeholder={config.telegramTopicIdConfigured ? '已配置，留空保留' : '论坛群组消息主题 ID'} /></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearTelegram} onChange={(event) => setConfig({ ...config, clearTelegram: event.target.checked })} /> 清除 Telegram 凭据</span></label>
          <h3>企业微信群机器人</h3>
          <p className="form-hint">仅接受 qyapi.weixin.qq.com 官方 HTTPS 机器人 URL；链接包含密钥，保存后不会回显。</p>
          <label className="form-field"><span>机器人 Webhook URL</span><input value={config.wecomWebhookUrl} onChange={(event) => update('wecomWebhookUrl', event.target.value)} maxLength={1024} placeholder={config.wecomUrlConfigured ? '已配置，留空保留' : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'} /></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearWecom} onChange={(event) => setConfig({ ...config, clearWecom: event.target.checked })} /> 清除企业微信机器人凭据</span></label>
          <h3>钉钉群机器人</h3>
          <p className="form-hint">Webhook 只接受 oapi.dingtalk.com 官方 HTTPS 机器人地址。签名密钥选填；凭据保存后不会回显。</p>
          <label className="form-field"><span>机器人 Webhook URL</span><input value={config.dingtalkWebhookUrl} onChange={(event) => update('dingtalkWebhookUrl', event.target.value)} maxLength={1024} placeholder={config.dingtalkUrlConfigured ? '已配置，留空保留' : 'https://oapi.dingtalk.com/robot/send?access_token=...'} /></label>
          <label className="form-field"><span>签名密钥（选填）</span><input value={config.dingtalkSecret} onChange={(event) => update('dingtalkSecret', event.target.value)} maxLength={256} placeholder={config.dingtalkSecretConfigured ? '已配置，留空保留' : '机器人安全设置中的加签密钥'} /></label>
          <label className="form-field"><span>@用户手机号</span><input value={config.dingtalkAtMobiles} onChange={(event) => update('dingtalkAtMobiles', event.target.value)} maxLength={512} placeholder={config.dingtalkAtMobilesConfigured ? '已配置，留空保留' : '逗号分隔手机号，或填写 all'} /></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearDingtalk} onChange={(event) => setConfig({ ...config, clearDingtalk: event.target.checked })} /> 清除钉钉机器人配置</span></label>
          <h3>飞书群机器人</h3>
          <p className="form-hint">Webhook 仅接受 open.feishu.cn 或 open.larksuite.com 官方 HTTPS 机器人地址；链接包含密钥，保存后不会回显。</p>
          <label className="form-field"><span>机器人 Webhook URL</span><input value={config.feishuWebhookUrl} onChange={(event) => update('feishuWebhookUrl', event.target.value)} maxLength={1024} placeholder={config.feishuUrlConfigured ? '已配置，留空保留' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} /></label>
          <label className="form-field"><span>@用户 user_id（选填）</span><input value={config.feishuUserIds} onChange={(event) => update('feishuUserIds', event.target.value)} maxLength={2048} placeholder={config.feishuUserIdsConfigured ? '已配置，留空保留' : '逗号分隔 user_id，或填写 all'} /></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearFeishu} onChange={(event) => setConfig({ ...config, clearFeishu: event.target.checked })} /> 清除飞书机器人配置</span></label>
          <h3>邮件（Cloudflare Email）</h3>
          <p className="form-hint">通过 Worker 的 <code>send_email</code> 绑定发送，发件地址必须是 Cloudflare Email 服务已验证的域名。{config.mailBindingAvailable ? '当前环境已绑定邮件发送服务。' : '当前环境未绑定邮件发送服务，暂不能配置。'}</p>
          <label className="form-field"><span>收件邮箱</span><input value={config.mailTo} onChange={(event) => update('mailTo', event.target.value)} maxLength={1024} placeholder={config.mailToConfigured ? '已配置，留空保留' : 'ops@example.com，可用逗号分隔'} /></label>
          <label className="form-field"><span>发件邮箱</span><input value={config.mailFrom} onChange={(event) => update('mailFrom', event.target.value)} maxLength={254} placeholder={config.mailFromConfigured ? '已配置，留空保留' : 'dns@example.com'} /></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearMail} onChange={(event) => setConfig({ ...config, clearMail: event.target.checked })} /> 清除邮件通知配置</span></label>
          <h3>QQ 机器人</h3>
          <p className="form-hint">使用 QQ 开放平台机器人 API。回调地址为 <code>{config.qqbotWebhookUrl}</code>；与机器人单聊一次即可绑定 OpenID，也可手动填写。</p>
          <label className="form-field"><span>AppID</span><input value={config.qqbotAppId} onChange={(event) => update('qqbotAppId', event.target.value)} maxLength={32} placeholder={config.qqbotAppIdConfigured ? '已配置，留空保留' : 'QQ 开放平台 AppID'} /></label>
          <label className="form-field"><span>AppSecret</span><input type="password" value={config.qqbotAppSecret} onChange={(event) => update('qqbotAppSecret', event.target.value)} maxLength={128} autoComplete="new-password" placeholder={config.qqbotAppSecretConfigured ? '已配置，留空保留' : 'QQ 开放平台 AppSecret'} /></label>
          <label className="form-field"><span>绑定 OpenID</span><input value={config.qqbotOpenId} onChange={(event) => update('qqbotOpenId', event.target.value)} maxLength={128} placeholder={config.qqbotOpenIdConfigured ? '已配置，留空保留' : '单聊后自动写入'} /></label>
          <label className="form-field"><span><input type="checkbox" checked={config.clearQqbot} onChange={(event) => setConfig({ ...config, clearQqbot: event.target.checked })} /> 清除 QQ 机器人配置</span></label>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={busy}>保存</button>
            <button className="button button-secondary" type="button" disabled={busy || (!config.webhookConfigured && !config.wxpusherConfigured && !config.telegramConfigured && !config.wecomConfigured && !config.dingtalkConfigured && !config.feishuConfigured && !config.mailConfigured && !config.qqbotConfigured)} onClick={() => void test()}>发送测试</button>
            <span>Webhook 模板支持 <code>{'{title}'}</code> 与 <code>{'{content}'}</code>；GET 使用查询参数。</span>
          </div>
        </form>}
    </section>
    <section className="panel" aria-labelledby="notify-help-title">
      <div className="panel-heading"><div><h2 id="notify-help-title">说明</h2></div><span className="panel-meta">当前范围</span></div>
      <p>支持自定义 Webhook、WxPusher、Telegram、企业微信、钉钉、飞书、邮件与 QQ 机器人；定时任务失败、容灾切换/恢复、证书签发与续签结果会尝试发送已配置渠道。QQ 机器人主动消息受平台配额限制，发送失败会在测试结果中提示。通知失败不会回滚已完成的 DNS 或证书操作。</p>
    </section>
  </>;
}
