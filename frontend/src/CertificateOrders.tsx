import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface CertificateOrder {
  id: number;
  source: 'manual' | 'acme';
  status: 'issued';
  issuer: string;
  keyType: 'RSA';
  keySize: number;
  issuedAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  domains: string[];
}

interface AcmeAccount {
  id: number; environment: 'staging' | 'production'; email: string; status: string;
  termsOfService: string | null; nonceReady: boolean; requestInFlight: boolean; createdAt: number; updatedAt: number;
}
interface DnsZone { id: number; name: string; accountName: string; accountType: string; thirdId: string | null }
interface AcmeIssuance {
  id: number; environment: 'staging' | 'production'; status: string; domains: string[];
  certificateOrderId: number | null; lastError: string | null; canPoll: boolean; nonceReady: boolean;
  requestInFlight: boolean; needsDnsCleanup: boolean; createdAt: number; updatedAt: number;
}
interface DomainResult { code: 0; items: DnsZone[]; page: number; pageSize: number; total: number }
interface Props { session: Session; onExpired: (message: string) => void; section?: 'all' | 'accounts' }

function date(value: number): string {
  return new Date(value * 1000).toLocaleString();
}

function issuanceStep(order: AcmeIssuance): { action: string; label: string } | null {
  if (order.needsDnsCleanup && order.status === 'failed') return { action: 'cleanup-dns', label: '清理 challenge TXT' };
  if (!order.nonceReady && (['draft','authorizing','challenge_ready','dns_present','triggering','trigger_unknown','submitted','ready_to_finalize','finalizing','processing','certificate_ready'].includes(order.status)
    || (order.status === 'outcome_unknown' && order.canPoll))) {
    return { action: 'prepare-nonce', label: order.requestInFlight ? '请求可能仍在处理中；等待后刷新 nonce' : '获取新的 ACME nonce' };
  }
  switch (order.status) {
    case 'draft': return { action: 'place', label: '提交 ACME 订单' };
    case 'authorizing': return { action: 'authorize', label: '读取下一项授权' };
    case 'challenge_ready': return { action: 'add-dns', label: '创建 Cloudflare TXT' };
    case 'dns_present': return { action: 'trigger', label: '通知 CA 验证' };
    case 'submitted':
    case 'trigger_unknown':
    case 'triggering': return { action: 'poll-authorization', label: '轮询授权状态' };
    case 'authorization_valid': return { action: 'cleanup-dns', label: '清理 challenge TXT' };
    case 'dns_adding':
    case 'dns_cleaning':
    case 'dns_outcome_unknown': return { action: 'reconcile-dns', label: '核对 Cloudflare TXT' };
    case 'ready_to_finalize': return { action: 'finalize', label: '请求签发证书' };
    case 'finalizing':
    case 'processing': return { action: 'poll-order', label: '轮询 CA 订单' };
    case 'outcome_unknown': return order.canPoll ? { action: 'poll-order', label: '核对远端订单' } : null;
    case 'certificate_ready': return { action: 'fetch-certificate', label: '取回并保存证书' };
    default: return null;
  }
}

function issuanceStatus(status: string): string {
  const names: Record<string, string> = {
    draft: '草稿', placing: '正在提交订单', authorizing: '等待域名授权', challenge_ready: '准备创建 TXT',
    dns_adding: '正在创建 TXT', dns_present: 'TXT 已创建', dns_outcome_unknown: 'TXT 状态待核对',
    dns_cleaning: '正在清理 TXT', triggering: '正在通知 CA', trigger_unknown: '验证触发结果待核对',
    submitted: '等待 CA 验证', authorization_valid: '域名已验证', ready_to_finalize: '可请求签发',
    finalizing: '正在请求签发', processing: 'CA 处理中', certificate_ready: '证书可取回',
    issued: '已签发', failed: '失败', outcome_unknown: '结果待核对', cancelled: '已取消',
  };
  return names[status] ?? status;
}

export function CertificateOrders({ session, onExpired, section = 'all' }: Props) {
  const accountsOnly = section === 'accounts';
  const [items, setItems] = useState<CertificateOrder[]>([]);
  const [accounts, setAccounts] = useState<AcmeAccount[]>([]);
  const [dnsZones, setDnsZones] = useState<DnsZone[]>([]);
  const [issuances, setIssuances] = useState<AcmeIssuance[]>([]);
  const [fullchain, setFullchain] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountEnvironment, setAccountEnvironment] = useState<'staging' | 'production'>('staging');
  const [confirmProduction, setConfirmProduction] = useState(false);
  const [issuanceAccountId, setIssuanceAccountId] = useState('');
  const [dnsDomainId, setDnsDomainId] = useState('');
  const [domainsText, setDomainsText] = useState('');
  const [termsAccepted, setTermsAccepted] = useState<Record<number, boolean>>({});
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
    setError('');
    try {
      const [orderResult, accountResult, domainResult, issuanceResult] = await Promise.all([
        request<{ code: 0; items: CertificateOrder[] }>('/api/v1/cert/orders?limit=100&offset=0', { signal }),
        request<{ code: 0; items: AcmeAccount[] }>('/api/v1/cert/acme/accounts', { signal }),
        request<DomainResult>('/api/v1/dns/domains?page=1&pageSize=100', { signal }),
        request<{ code: 0; items: AcmeIssuance[] }>('/api/v1/cert/acme/orders', { signal }),
      ]);
      if (!signal.aborted) {
        setItems(orderResult.items);
        setAccounts(accountResult.items);
        setDnsZones(domainResult.items.filter((zone) => zone.accountType === 'cloudflare' && Boolean(zone.thirdId)));
        setIssuances(issuanceResult.items);
        setIssuanceAccountId((current) => current || String(accountResult.items.find((account) => account.status === 'ready')?.id ?? ''));
        setDnsDomainId((current) => current || String(domainResult.items.find((zone) => zone.accountType === 'cloudflare' && zone.thirdId)?.id ?? ''));
      }
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function importCertificate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const created = await send<{ code: 0; id: number }>('/api/v1/cert/orders/import', 'POST', {
        fullchain, privateKey,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setFullchain('');
      setPrivateKey('');
      setNotice(`证书已安全导入，订单编号 ${created.id}`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function createAcmeAccount(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const account = await send<{ code: 0; id: number }>('/api/v1/cert/acme/accounts', 'POST', {
        email: accountEmail, environment: accountEnvironment, confirmProduction,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await send(`/api/v1/cert/acme/accounts/${account.id}/directory`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await send(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setAccountEmail(''); setConfirmProduction(false);
      setNotice(`${accountEnvironment === 'staging' ? 'Staging' : '生产'} ACME 账户已准备注册；同意服务条款后可继续。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  async function prepareAccount(account: AcmeAccount) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      if (account.status === 'pending_directory') {
        await send(`/api/v1/cert/acme/accounts/${account.id}/directory`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      }
      await send(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('已取得一次性 CA nonce，可以继续注册或签发。');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function registerAccount(account: AcmeAccount) {
    if (busy || !termsAccepted[account.id]) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/acme/accounts/${account.id}/register`, 'POST', { agreeToTerms: true }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`ACME ${account.environment} 账户已注册。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function createAcmeOrder(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !issuanceAccountId || !dnsDomainId) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; id: number }>('/api/v1/cert/acme/orders', 'POST', {
        accountId: issuanceAccountId, dnsDomainId,
        domains: domainsText.split(/[\\s,;]+/).map((domain) => domain.trim()).filter(Boolean),
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setDomainsText('');
      setNotice(`ACME ${accounts.find((account) => account.id === Number(issuanceAccountId))?.environment ?? ''} 签发任务 ${result.id} 已建立；后续每一步都需显式推进。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function issuanceAction(order: AcmeIssuance, action: string, success: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/acme/orders/${order.id}/${action}`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(success);
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  async function download(order: CertificateOrder) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/v1/cert/orders/${order.id}/export`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/x-pkcs12', 'X-CSRF-Token': session.csrfToken },
      });
      if (!response.ok) {
        let body: Record<string, unknown> = {};
        try { body = await response.json() as Record<string, unknown>; } catch { body = {}; }
        if (response.status === 401) { onExpired('会话已失效，请重新登录。'); return; }
        throw new ApiError(typeof body.msg === 'string' ? body.msg : '证书下载未完成。', response.status, body);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `certificate-${order.id}.p12`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setNotice(`订单 ${order.id} 的 PFX 已下载；兼容密码为 123456`);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  const selectedAccount = accounts.find((account) => String(account.id) === issuanceAccountId);

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="acme-account-title">
      <div className="panel-heading"><div><h2 id="acme-account-title">ACME 账户</h2></div><span className="panel-meta">RSA 账户密钥使用 AES-GCM 加密</span></div>
      <p className="form-hint certificate-security-note">默认使用 Let's Encrypt staging。生产 CA 只有在明确选择并确认后才会请求；单测不会连接任何 CA。</p>
      <form className="dns-form certificate-setup-form" onSubmit={createAcmeAccount}>
        <label className="form-field"><span>联系邮箱</span><input type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} required maxLength={254} autoComplete="email" /></label>
        <label className="form-field"><span>CA 环境</span><select value={accountEnvironment} onChange={(event) => setAccountEnvironment(event.target.value as 'staging' | 'production')}>
          <option value="staging">Let's Encrypt staging（测试）</option><option value="production">Let's Encrypt production（正式签发）</option>
        </select></label>
        {accountEnvironment === 'production' && <label className="certificate-confirm"><input type="checkbox" checked={confirmProduction} onChange={(event) => setConfirmProduction(event.target.checked)} />我明确确认将向 production CA 注册账户</label>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !accountEmail.trim() || (accountEnvironment === 'production' && !confirmProduction)}>创建 ACME 账户</button><span>创建账户后仍需读取 Directory、获取 nonce 并同意 CA 条款完成注册。</span></div>
      </form>
      {accounts.length > 0 && <div className="certificate-account-list">{accounts.map((account) => <article className="certificate-account-card" key={account.id}>
        <div><strong>#{account.id} · {account.email}</strong><span className="value-detail">{account.environment === 'staging' ? '测试 CA' : '生产 CA'} · {account.status}</span></div>
        <div className="certificate-account-actions">
          {account.status !== 'disabled' && (account.status !== 'ready' || !account.nonceReady) && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void prepareAccount(account)}>{account.status === 'pending_directory' ? '读取 Directory 并准备 nonce' : account.status === 'ready' ? '准备签发 nonce' : '刷新一次性 nonce'}</button>}
          {account.status === 'pending_registration' && <>
            {account.termsOfService && <a href={account.termsOfService} target="_blank" rel="noreferrer">查看 CA 服务条款</a>}
            <label className="certificate-confirm"><input type="checkbox" checked={termsAccepted[account.id] ?? false} onChange={(event) => setTermsAccepted((current) => ({ ...current, [account.id]: event.target.checked }))} />我同意 CA 服务条款</label>
            <button className="button button-primary" type="button" disabled={busy || !termsAccepted[account.id] || !account.nonceReady || account.requestInFlight} onClick={() => void registerAccount(account)}>注册账户</button>
          </>}
          {account.status === 'ready' && <span className="data-badge">已注册</span>}
        </div>
      </article>)}</div>}
    </section>
    {!accountsOnly && <>
    <section className="panel" aria-labelledby="acme-issuance-title">
      <div className="panel-heading"><div><h2 id="acme-issuance-title">申请新证书</h2></div><span className="panel-meta">DNS-01 · Cloudflare</span></div>
      <p className="form-hint certificate-security-note">每个订单分步推进，自动写入并清理本系统创建的 TXT challenge。CA 请求结果未知时必须先核对状态，不会自动重试。</p>
      <form className="dns-form certificate-setup-form" onSubmit={createAcmeOrder}>
        <label className="form-field"><span>已注册 ACME 账户</span><select value={issuanceAccountId} onChange={(event) => setIssuanceAccountId(event.target.value)} required>
          <option value="">选择 staging 或已确认的 production 账户</option>{accounts.filter((account) => account.status === 'ready').map((account) => <option key={account.id} value={account.id}>#{account.id} · {account.environment} · {account.email}</option>)}
        </select></label>
        <label className="form-field"><span>Cloudflare DNS Zone</span><select value={dnsDomainId} onChange={(event) => setDnsDomainId(event.target.value)} required>
          <option value="">选择已同步的 Cloudflare 域名</option>{dnsZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name} · {zone.accountName}</option>)}
        </select></label>
        <label className="form-field certificate-domain-field"><span>证书域名（每行一个，可用通配符）</span><textarea value={domainsText} onChange={(event) => setDomainsText(event.target.value)} required maxLength={6000} spellCheck={false} placeholder={'example.com\nwww.example.com\n*.example.com'} /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !issuanceAccountId || !dnsDomainId || !domainsText.trim() || !selectedAccount?.nonceReady}>创建并准备签发任务</button><span>仅支持当前 Zone 覆盖的域名；账号密钥与 CSR 私钥均加密存储。所选账户须先在上方准备一次性 nonce。</span></div>
      </form>
      <div className="certificate-issuance-list">
        {issuances.length === 0 ? <div className="panel-empty">尚无 ACME 签发任务。</div> : issuances.map((order) => {
          const step = issuanceStep(order);
          const canCancel = ['draft','outcome_unknown','failed'].includes(order.status) && !order.needsDnsCleanup;
          return <article className="certificate-issuance-card" key={order.id}>
            <div className="certificate-issuance-heading"><div><strong className="mono">任务 #{order.id}</strong><span className="value-detail">{order.environment === 'staging' ? '测试 CA' : '生产 CA'} · {issuanceStatus(order.status)}</span></div>
              <div className="certificate-domains">{order.domains.map((domain) => <span className="data-badge mono" key={domain}>{domain}</span>)}</div>
            </div>
            {order.lastError && <p className="form-hint certificate-order-error">状态提示：{order.lastError}。请先核对 CA/DNS 侧结果，不要盲目重试。</p>}
            <div className="certificate-account-actions">
              {step && <button className="button button-primary" type="button" disabled={busy} onClick={() => void issuanceAction(order, step.action, `任务 ${order.id}：${step.label} 已提交。`)}>{step.label}</button>}
              {canCancel && <button className="button button-quiet" type="button" disabled={busy} onClick={() => void issuanceAction(order, 'cancel', `任务 ${order.id} 已在本地取消。`)}>取消本地任务</button>}
              {order.certificateOrderId && <span className="data-badge">证书订单 #{order.certificateOrderId}</span>}
            </div>
          </article>;
        })}
      </div>
      <div className="panel-footnote">Staging 与 production 使用不同 CA 账户。取消只关闭本地任务，不会撤销 CA 侧订单；TXT 清理须先核对记录编号。</div>
    </section>
    <section className="panel" aria-labelledby="certificate-import-title">
      <div className="panel-heading"><div><h2 id="certificate-import-title">导入已签发证书</h2></div><span className="panel-meta">RSA · PEM · AES-GCM 加密存储</span></div>
      <p className="form-hint certificate-security-note">支持手动导入证书链和匹配的 RSA 私钥（至少 2048 位）。私钥不会回显在订单列表；自动续签和部署仍待接入。</p>
      <form className="dns-form certificate-import-form" onSubmit={importCertificate}>
        <label className="form-field"><span>完整证书链（PEM）</span><textarea value={fullchain} onChange={(event) => setFullchain(event.target.value)} required maxLength={48 * 1024} autoComplete="off" spellCheck={false} aria-label="完整证书链 PEM" placeholder="-----BEGIN CERTIFICATE-----" /></label>
        <label className="form-field"><span>未加密 RSA 私钥（PEM）</span><textarea value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} required maxLength={16 * 1024} autoComplete="off" spellCheck={false} aria-label="RSA 私钥 PEM" placeholder="-----BEGIN PRIVATE KEY-----" /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !fullchain.trim() || !privateKey.trim()}>{busy ? '正在处理…' : '验证并导入'}</button><span>仅支持 X.509 证书链和未加密 RSA 私钥。材料不写入浏览器本地存储。</span></div>
      </form>
    </section>
    <section className="panel" aria-labelledby="certificate-orders-title">
      <div className="panel-heading"><div><h2 id="certificate-orders-title">证书订单</h2></div><span className="panel-meta">共 {items.length} 条 · 证书材料不在列表响应中</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取证书订单…</div>
        : items.length === 0 ? <div className="panel-empty">还没有证书订单。可导入一份已签发的 PEM 证书和匹配私钥。</div>
          : <div className="table-wrap"><table className="data-table certificate-table">
            <thead><tr><th>订单</th><th>域名</th><th>签发机构</th><th>密钥</th><th>有效期</th><th>操作</th></tr></thead>
            <tbody>{items.map((order) => <tr key={order.id}>
              <td><strong className="mono">#{order.id}</strong><span className="value-detail">{order.source === 'acme' ? 'ACME 签发' : '手动导入'}</span></td>
              <td className="certificate-domains">{order.domains.map((domain) => <span className="data-badge mono" key={domain}>{domain}</span>)}</td>
              <td>{order.issuer}</td>
              <td className="mono">{order.keyType} {order.keySize}</td>
              <td><span>{date(order.issuedAt)}</span><span className="value-detail">到期 {date(order.expiresAt)}</span></td>
              <td><button className="button button-secondary" type="button" disabled={busy} onClick={() => void download(order)}>下载 PFX</button></td>
            </tr>)}</tbody>
          </table></div>}
      <div className="panel-footnote">PFX 遵循旧接口兼容密码 123456。导出操作会写审计；审计未确认时不会返回证书材料。</div>
    </section>
    </>}
  </>;
}
