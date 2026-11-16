import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { InfoTip } from './InfoTip';
import { Modal } from './Modal';
import { CertificateCname } from './CertificateCname';
import { CertificateSettings } from './CertificateSettings';

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
  isAuto: boolean;
  revokedAt: number | null;
  renewedFrom: number | null;
  domains: string[];
  remark: string | null;
}

interface AcmeAccount {
  id: number; environment: 'staging' | 'production'; ca: string; email: string; status: string;
  termsOfService: string | null; nonceReady: boolean; requestInFlight: boolean; createdAt: number; updatedAt: number;
}
interface AcmeEvent { action: string; detail: string; createdAt: number }
interface AcmeIssuance {
  id: number; environment: 'staging' | 'production'; ca: string; status: string; domains: string[];
  authorizationIndex: number; authorizationTotal: number; currentDomain: string | null;
  certificateOrderId: number | null; lastError: string | null; canPoll: boolean; nonceReady: boolean;
  requestInFlight: boolean; needsDnsCleanup: boolean; events: AcmeEvent[]; createdAt: number; updatedAt: number;
}
interface AdvanceResult {
  code: 0; id: number; status: string; done: boolean; manual: boolean; pending: boolean; retryAfter: number;
  steps: string[]; authorizationIndex: number; authorizationTotal: number; currentDomain: string | null;
  certificateOrderId: number | null;
}

const autoStatuses = [
  'draft','authorizing','challenge_ready','dns_present','submitted','triggering','trigger_unknown',
  'authorization_valid','ready_to_finalize','finalizing','processing','certificate_ready',
];

function canAutoAdvance(order: AcmeIssuance): boolean {
  return autoStatuses.includes(order.status) || (order.status === 'failed' && order.needsDnsCleanup);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

interface Props { session: Session; onExpired: (message: string) => void; section?: 'all' | 'accounts' }

const acmeCas = [
  { value: 'letsencrypt', name: "Let's Encrypt", staging: true, eab: false },
  { value: 'zerossl', name: 'ZeroSSL', staging: false, eab: true },
  { value: 'google', name: 'Google Trust Services', staging: true, eab: true },
  { value: 'litessl', name: 'LiteSSL', staging: false, eab: true },
  { value: 'customacme', name: '自定义 ACME', staging: false, eab: false },
] as const;

type AcmeCaName = typeof acmeCas[number]['value'];

function caName(value: string): string {
  return acmeCas.find((entry) => entry.value === value)?.name ?? value;
}

function date(value: number): string {
  return new Date(value * 1000).toLocaleString();
}

function authorizationProgress(order: AcmeIssuance): string {
  if (order.authorizationTotal === 0) return '';
  return `授权 ${order.authorizationIndex}/${order.authorizationTotal}`;
}

function nextAuthorizationLabel(order: AcmeIssuance): string {
  if (order.authorizationTotal === 0) return '读取下一项授权';
  const position = `${order.authorizationIndex + 1}/${order.authorizationTotal}`;
  return `读取第 ${position} 项授权${order.currentDomain ? `（${order.currentDomain}）` : ''}`;
}

function eventText(event: AcmeEvent): string {
  const challengeName = (prefix: string) => (event.detail.startsWith(prefix) ? event.detail.slice(prefix.length) : '');
  switch (event.action) {
    case 'cert.acme.order.create': return '创建签发任务';
    case 'cert.acme.order.placed': return `提交 ACME 订单${event.detail.replace(/^(\d+) ACME authorizations$/, ' · 共 $1 项域名授权')}`;
    case 'cert.acme.dns.create': return `写入 TXT${challengeName('TXT challenge ') ? ` · ${challengeName('TXT challenge ')}` : ''}`;
    case 'cert.acme.dns.cleanup': return `清理 TXT${challengeName('TXT challenge removed · ') ? ` · ${challengeName('TXT challenge removed · ')}` : ''}`;
    case 'cert.acme.order.issued': return '证书签发完成';
    case 'cert.acme.order.cancel': return '本地取消任务';
    default: return `${event.action}${event.detail ? ` · ${event.detail}` : ''}`;
  }
}

function issuanceStep(order: AcmeIssuance): { action: string; label: string } | null {
  if (order.needsDnsCleanup && order.status === 'failed') return { action: 'cleanup-dns', label: '清理 challenge TXT' };
  if (!order.nonceReady && (['draft','authorizing','challenge_ready','dns_present','triggering','trigger_unknown','submitted','ready_to_finalize','finalizing','processing','certificate_ready'].includes(order.status)
    || (order.status === 'outcome_unknown' && order.canPoll))) {
    return { action: 'prepare-nonce', label: order.requestInFlight ? '请求可能仍在处理中；等待后刷新 nonce' : '获取新的 ACME nonce' };
  }
  switch (order.status) {
    case 'draft': return { action: 'place', label: '提交 ACME 订单' };
    case 'authorizing': return { action: 'authorize', label: nextAuthorizationLabel(order) };
    case 'challenge_ready': return { action: 'add-dns', label: '创建 DNS TXT' };
    case 'dns_present': return { action: 'trigger', label: '通知 CA 验证' };
    case 'submitted':
    case 'trigger_unknown':
    case 'triggering': return { action: 'poll-authorization', label: '轮询授权状态' };
    case 'authorization_valid': return { action: 'cleanup-dns', label: '清理 challenge TXT' };
    case 'dns_adding':
    case 'dns_cleaning':
    case 'dns_outcome_unknown': return { action: 'reconcile-dns', label: '核对 DNS TXT' };
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
  const [issuances, setIssuances] = useState<AcmeIssuance[]>([]);
  const [fullchain, setFullchain] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountCa, setAccountCa] = useState<AcmeCaName>('letsencrypt');
  const [accountDirectoryUrl, setAccountDirectoryUrl] = useState('');
  const [eabKid, setEabKid] = useState('');
  const [eabHmacKey, setEabHmacKey] = useState('');
  const [accountEnvironment, setAccountEnvironment] = useState<'staging' | 'production'>('staging');
  const [confirmProduction, setConfirmProduction] = useState(false);
  const [issuanceAccountId, setIssuanceAccountId] = useState('');
  const [domainsText, setDomainsText] = useState('');
  const [termsAccepted, setTermsAccepted] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);
  const [autoNotice, setAutoNotice] = useState<{ id: number; message: string } | null>(null);
  const [autoRunning, setAutoRunning] = useState<number | null>(null);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const autoAbort = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AcmeAccount | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editingOrder, setEditingOrder] = useState<CertificateOrder | null>(null);
  const [orderRemark, setOrderRemark] = useState('');
  const [orderAuto, setOrderAuto] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [material, setMaterial] = useState<{ orderId: number; domains: string[]; crt: string; key: string } | null>(null);
  const [pfxPassword, setPfxPassword] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [orderResult, accountResult, issuanceResult] = await Promise.all([
        request<{ code: 0; items: CertificateOrder[] }>('/api/v1/cert/orders?limit=100&offset=0', { signal }),
        request<{ code: 0; items: AcmeAccount[] }>('/api/v1/cert/acme/accounts', { signal }),
        request<{ code: 0; autoAdvance?: boolean; items: AcmeIssuance[] }>('/api/v1/cert/acme/orders', { signal }),
      ]);
      if (!signal.aborted) {
        setItems(orderResult.items);
        setAccounts(accountResult.items);
        setIssuances(issuanceResult.items);
        setAutoAdvance(issuanceResult.autoAdvance !== false);
        setIssuanceAccountId((current) => current || String(accountResult.items.find((account) => account.status === 'ready')?.id ?? ''));
      }
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => () => autoAbort.current?.abort(), []);

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
      setImportOpen(false);
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
        email: accountEmail, ca: accountCa, environment: accountEnvironment, confirmProduction,
        directoryUrl: accountCa === 'customacme' ? accountDirectoryUrl.trim() : undefined,
        eabKid: eabKid.trim() || undefined, eabHmacKey: eabHmacKey.trim() || undefined,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await send(`/api/v1/cert/acme/accounts/${account.id}/directory`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await send(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setAccountEmail(''); setEabKid(''); setEabHmacKey(''); setAccountDirectoryUrl(''); setConfirmProduction(false);
      setAccountOpen(false);
      setNotice(`${caName(accountCa)} ${accountEnvironment === 'staging' ? 'Staging' : '生产'} ACME 账户已准备注册；同意服务条款后可继续。`);
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

  function openAccountEdit(account: AcmeAccount) {
    setEditingAccount(account);
    setEditEmail(account.email);
    setError('');
    setNotice('');
  }

  async function saveAccountEmail(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !editingAccount) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; contactUpdated: boolean }>(
        `/api/v1/cert/acme/accounts/${editingAccount.id}`, 'PATCH', { email: editEmail },
        controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(`ACME 账户 #${editingAccount.id} 的联系邮箱已更新${result.contactUpdated ? '，并已同步到 CA' : ''}。`);
      setEditingAccount(null);
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  function openOrderEdit(order: CertificateOrder) {
    setEditingOrder(order);
    setOrderRemark(order.remark ?? '');
    setOrderAuto(order.isAuto);
    setError('');
    setNotice('');
  }

  async function saveOrder(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !editingOrder) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/orders/${editingOrder.id}`, 'PATCH', { remark: orderRemark, isAuto: orderAuto },
        controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`证书订单 #${editingOrder.id} 已更新。`);
      setEditingOrder(null);
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  async function removeAccount(account: AcmeAccount) {
    if (busy) return;
    const caution = account.status === 'ready'
      ? 'CA 侧已注册的账户不会被注销，只是本系统不再保存它的私钥。'
      : '该账户尚未在 CA 注册。';
    if (!window.confirm(`删除 ACME 账户 #${account.id}？${caution}已结束的签发任务记录会一并删除，已签发的证书订单保留。`)) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/acme/accounts/${account.id}`, 'DELETE', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`ACME 账户 #${account.id} 已删除。`);
      setTermsAccepted((current) => {
        const next = { ...current };
        delete next[account.id];
        return next;
      });
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  async function createAcmeOrder(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !issuanceAccountId) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; id: number }>('/api/v1/cert/acme/orders', 'POST', {
        accountId: issuanceAccountId,
        domains: domainsText.split(/[\s,;]+/).map((domain) => domain.trim()).filter(Boolean),
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setDomainsText('');
      setOrderOpen(false);
      setNotice(`ACME ${accounts.find((account) => account.id === Number(issuanceAccountId))?.environment ?? ''} 签发任务 ${result.id} 已建立；后续每一步都需显式推进。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function runIssuance(order: AcmeIssuance) {
    if (busy) return;
    setBusy(true); setAutoRunning(order.id); setError(''); setNotice('');
    setActionError(null); setAutoNotice(null);
    const controller = new AbortController();
    autoAbort.current = controller;
    const startedAt = Date.now();
    try {
      for (let round = 0; round < 120; round += 1) {
        const result = await send<AdvanceResult>(
          `/api/v1/cert/acme/orders/${order.id}/advance`, 'POST', {},
          controller.signal, { 'X-CSRF-Token': session.csrfToken },
        );
        await load(controller.signal);
        const progress = result.authorizationTotal > 0 ? ` · 授权 ${result.authorizationIndex}/${result.authorizationTotal}` : '';
        const recent = result.steps.length > 0 ? ` · 本轮：${result.steps.join('、')}` : '';
        if (result.done) {
          setAutoNotice({ id: order.id, message: `全部步骤已完成，证书订单 #${result.certificateOrderId ?? '—'} 已保存。` });
          setNotice(`签发任务 ${order.id} 已完成。`);
          return;
        }
        if (result.manual) {
          setAutoNotice({ id: order.id, message: `自动推进停在「${issuanceStatus(result.status)}」，需要人工核对后再继续。` });
          return;
        }
        setAutoNotice({ id: order.id, message: `自动推进中：${issuanceStatus(result.status)}${progress}${recent}${result.pending ? '（已开启站点定时任务时，关闭本页也会继续）' : ''}` });
        if (Date.now() - startedAt > 15 * 60_000) {
          setAutoNotice({ id: order.id, message: '自动推进已持续 15 分钟，本页已暂停；开启站点定时任务或稍后再次点击可继续。' });
          return;
        }
        await sleep(Math.min(60, Math.max(2, result.retryAfter || 3)) * 1000);
      }
      setAutoNotice({ id: order.id, message: '自动推进轮次较多，已暂停；可再次点击继续。' });
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
      else setActionError({ id: order.id, message: errorMessage(failure) });
      await load(controller.signal);
    } finally { setBusy(false); setAutoRunning(null); autoAbort.current = null; }
  }

  async function issuanceAction(order: AcmeIssuance, action: string, success: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setActionError(null);
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/acme/orders/${order.id}/${action}`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(success);
      await load(controller.signal);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
      else setActionError({ id: order.id, message: errorMessage(failure) });
      await load(controller.signal);
    }
    finally { setBusy(false); }
  }

  function saveBlob(filename: string, blob: Blob) {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }

  async function exportRequest(orderId: number, format: 'pem' | 'pfx'): Promise<Response | null> {
    const response = await fetch(`/api/v1/cert/orders/${orderId}/export`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {
        Accept: format === 'pfx' ? 'application/x-pkcs12' : 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken,
      },
      body: JSON.stringify({ format }),
    });
    if (response.ok) return response;
    let body: Record<string, unknown> = {};
    try { body = await response.json() as Record<string, unknown>; } catch { body = {}; }
    if (response.status === 401) { onExpired('会话已失效，请重新登录。'); return null; }
    throw new ApiError(typeof body.msg === 'string' ? body.msg : '证书导出未完成。', response.status, body);
  }

  async function openMaterial(order: CertificateOrder) {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setPfxPassword('');
    try {
      const response = await exportRequest(order.id, 'pem');
      if (!response) return;
      const payload = await response.json() as { item: { crt: string; key: string } };
      setMaterial({ orderId: order.id, domains: order.domains, crt: payload.item.crt, key: payload.item.key });
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  function closeMaterial() {
    if (busy) return;
    setMaterial(null);
    setPfxPassword('');
  }

  async function downloadPfx(orderId: number) {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setPfxPassword('');
    try {
      const response = await exportRequest(orderId, 'pfx');
      if (!response) return;
      const password = response.headers.get('X-Cert-Pfx-Password') ?? '';
      saveBlob(`certificate-${orderId}.pfx`, await response.blob());
      setPfxPassword(password);
      setNotice(`订单 ${orderId} 的 PFX 已下载；本次随机密码只显示这一次，请立即保存。`);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label}已复制到剪贴板。`);
    } catch { setError('复制失败，请手动选择文本内容后复制。'); }
  }

  async function toggleAuto(order: CertificateOrder, isAuto: boolean) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/orders/${order.id}`, 'PATCH', { isAuto }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`订单 ${order.id} 自动续签已${isAuto ? '开启' : '关闭'}。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  async function removeOrder(order: CertificateOrder) {
    if (busy || !window.confirm(`删除证书订单 #${order.id}？已保存的证书材料将不可恢复。`)) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/orders/${order.id}`, 'DELETE', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`证书订单 ${order.id} 已删除。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  async function revokeOrder(order: CertificateOrder) {
    if (busy || !window.confirm(`吊销订单 #${order.id} 的证书？该操作会请求 CA 且不可撤销。`)) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/orders/${order.id}/revoke`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`订单 ${order.id} 的证书已吊销。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); await load(controller.signal); }
    finally { setBusy(false); }
  }

  const selectedAccount = accounts.find((account) => String(account.id) === issuanceAccountId);
  const accountCaEntry = acmeCas.find((entry) => entry.value === accountCa)!;

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="acme-account-title">
      <div className="panel-heading"><div><h2 id="acme-account-title">ACME 账户</h2><InfoTip label="ACME 账户说明" text="支持 Let's Encrypt、ZeroSSL、Google Trust Services、LiteSSL 与自定义 ACME。生产 CA 需明确选择并确认后才会发起请求。" /></div><button className="button button-primary" type="button" disabled={busy} onClick={() => { setAccountEmail(''); setConfirmProduction(false); setError(''); setNotice(''); setAccountOpen(true); }}><Icon name="plus" />添加账户</button></div>
      {accounts.length === 0 ? <div className="panel-empty">还没有 ACME 账户。</div> : null}
      {accounts.length > 0 && <div className="certificate-account-list">{accounts.map((account) => <article className="certificate-account-card" key={account.id}>
        <div><strong>#{account.id} · {account.email}</strong><span className="value-detail">{caName(account.ca)} · {account.environment === 'staging' ? '测试 CA' : '生产 CA'} · {account.status}</span></div>
        <div className="certificate-account-actions">
          {account.status !== 'disabled' && (account.status !== 'ready' || !account.nonceReady) && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void prepareAccount(account)}>{account.status === 'pending_directory' ? '读取 Directory 并准备 nonce' : account.status === 'ready' ? '准备签发 nonce' : '刷新一次性 nonce'}</button>}
          {account.status === 'pending_registration' && <>
            {account.termsOfService && <a href={account.termsOfService} target="_blank" rel="noreferrer">查看 CA 服务条款</a>}
            <label className="certificate-confirm"><input type="checkbox" checked={termsAccepted[account.id] ?? false} onChange={(event) => setTermsAccepted((current) => ({ ...current, [account.id]: event.target.checked }))} />我同意 CA 服务条款</label>
            <button className="button button-primary" type="button" disabled={busy || !termsAccepted[account.id] || !account.nonceReady || account.requestInFlight} onClick={() => void registerAccount(account)}>注册账户</button>
          </>}
          {account.status === 'ready' && <span className="data-badge">已注册</span>}
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => openAccountEdit(account)}>编辑</button>
          <button className="button button-quiet" type="button" disabled={busy || account.requestInFlight} onClick={() => void removeAccount(account)}>删除</button>
        </div>
      </article>)}</div>}
    </section>
    {accountsOnly && <CertificateCname session={session} onExpired={onExpired} />}
    {!accountsOnly && <>
    <section className="panel" aria-labelledby="acme-issuance-title">
      <div className="panel-heading"><div><h2 id="acme-issuance-title">申请新证书</h2><InfoTip label="签发说明" text="「自动完成签发」会逐个域名重复「读取授权 → 写 TXT → 通知验证 → 清理 TXT」，写入 TXT 后等待权威 DNS 生效再验证；已开启站点定时任务（系统设置 → Cron）时，关闭本页后仍会继续推进。遇到结果未知或需要核对的 DNS 状态会停下并要求人工处理。" /></div><button className="button button-primary" type="button" disabled={busy || accounts.every((account) => account.status !== 'ready')} onClick={() => { setError(''); setNotice(''); setOrderOpen(true); }}><Icon name="plus" />申请证书</button></div>
      <div className="certificate-issuance-list">
        {issuances.length === 0 ? <div className="panel-empty">尚无 ACME 签发任务。</div> : issuances.map((order) => {
          const step = issuanceStep(order);
          const auto = canAutoAdvance(order);
          const canCancel = ['draft','outcome_unknown','failed'].includes(order.status) && !order.needsDnsCleanup;
          return <article className="certificate-issuance-card" key={order.id}>
            <div className="certificate-issuance-heading"><div><strong className="mono">任务 #{order.id}</strong><span className="value-detail">{caName(order.ca)} · {order.environment === 'staging' ? '测试 CA' : '生产 CA'} · {issuanceStatus(order.status)}{authorizationProgress(order) ? ` · ${authorizationProgress(order)}` : ''}</span></div>
              <div className="certificate-domains">{order.domains.map((domain) => <span className="data-badge mono" key={domain}>{domain}</span>)}</div>
            </div>
            {order.lastError && <p className="form-hint certificate-order-error">{order.lastError}</p>}
            {actionError?.id === order.id && <p className="form-hint certificate-order-error" role="alert">{actionError.message}</p>}
            {autoNotice?.id === order.id && <p className="form-hint certificate-auto-progress" role="status">{autoNotice.message}</p>}
            <div className="certificate-account-actions">
              {step && autoAdvance && auto && <button className="button button-primary" type="button" disabled={busy} onClick={() => void runIssuance(order)}>{autoRunning === order.id ? '自动推进中…' : '自动完成签发'}</button>}
              {step && <button className={autoAdvance && auto ? 'button button-secondary' : 'button button-primary'} type="button" disabled={busy} onClick={() => void issuanceAction(order, step.action, `任务 ${order.id}：${step.label} 已提交。`)}>{step.label}</button>}
              {canCancel && <button className="button button-quiet" type="button" disabled={busy} onClick={() => void issuanceAction(order, 'cancel', `任务 ${order.id} 已在本地取消。`)}>取消本地任务</button>}
              {order.certificateOrderId && <span className="data-badge">证书订单 #{order.certificateOrderId}</span>}
            </div>
            {order.events.length > 0 && <ol className="certificate-issuance-log">
              {order.events.map((event) => <li key={`${event.createdAt}-${event.action}-${event.detail}`}>
                <time dateTime={new Date(event.createdAt * 1000).toISOString()}>{date(event.createdAt)}</time>
                <span>{eventText(event)}</span>
              </li>)}
            </ol>}
          </article>;
        })}
      </div>
    </section>
    <section className="panel" aria-labelledby="certificate-orders-title">
      <div className="panel-heading"><div><h2 id="certificate-orders-title">证书订单</h2></div><div className="panel-heading-actions"><span className="panel-meta">共 {items.length} 条</span><button className="button button-secondary" type="button" disabled={busy} onClick={() => { setError(''); setNotice(''); setRenewOpen(true); }}><Icon name="sliders" />续签设置</button><button className="button button-primary" type="button" disabled={busy} onClick={() => { setFullchain(''); setPrivateKey(''); setError(''); setNotice(''); setImportOpen(true); }}><Icon name="plus" />导入证书</button></div></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取证书订单…</div>
        : items.length === 0 ? <div className="panel-empty">还没有证书订单。可导入一份已签发的 PEM 证书和匹配私钥。</div>
          : <div className="table-wrap"><table className="data-table certificate-table">
            <thead><tr><th>订单</th><th>域名</th><th>签发机构</th><th>密钥</th><th>有效期</th><th>自动续签</th><th>操作</th></tr></thead>
            <tbody>{items.map((order) => <tr key={order.id}>
              <td><strong className="mono">#{order.id}</strong><span className="value-detail">{order.source === 'acme' ? 'ACME 签发' : '手动导入'}</span>{order.remark && <span className="value-detail">{order.remark}</span>}{order.renewedFrom && <span className="value-detail">续签自 #{order.renewedFrom}</span>}</td>
              <td className="certificate-domains">{order.domains.map((domain) => <span className="data-badge mono" key={domain}>{domain}</span>)}</td>
              <td>{order.issuer}</td>
              <td className="mono">{order.keyType} {order.keySize}</td>
              <td><span>{date(order.issuedAt)}</span><span className="value-detail">到期 {date(order.expiresAt)}</span></td>
              <td><label className="certificate-confirm"><input type="checkbox" checked={order.isAuto} disabled={busy || order.revokedAt !== null} onChange={(event) => void toggleAuto(order, event.target.checked)} />自动</label>{order.revokedAt !== null && <span className="value-detail">已吊销 {date(order.revokedAt)}</span>}</td>
              <td className="certificate-order-actions">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => openOrderEdit(order)}>编辑</button>
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => void openMaterial(order)}>证书 / 下载</button>
                {order.source === 'acme' && order.revokedAt === null && <button className="button button-quiet" type="button" disabled={busy} onClick={() => void revokeOrder(order)}>吊销</button>}
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void removeOrder(order)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
      <div className="panel-footnote">证书与私钥可分别复制或下载为 .crt / .key；PFX 每次下载使用随机密码，只显示一次。</div>
    </section>
    </>}
    {accountOpen && <Modal title="创建 ACME 账户" wide onClose={() => { if (!busy) setAccountOpen(false); }}>
      <form className="dns-form certificate-setup-form" onSubmit={createAcmeAccount}>
        <label className="form-field"><span>CA 服务商</span><select value={accountCa} onChange={(event) => {
          const next = event.target.value as AcmeCaName;
          setAccountCa(next);
          const entry = acmeCas.find((candidate) => candidate.value === next)!;
          if (!entry.staging) setAccountEnvironment('production');
          setConfirmProduction(false);
        }}>
          {acmeCas.map((entry) => <option key={entry.value} value={entry.value}>{entry.name}</option>)}
        </select></label>
        <label className="form-field"><span>联系邮箱</span><input type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} required maxLength={254} autoComplete="email" /></label>
        <label className="form-field"><span>CA 环境</span><select value={accountEnvironment} onChange={(event) => { setAccountEnvironment(event.target.value as 'staging' | 'production'); setConfirmProduction(false); }}>
          {accountCaEntry.staging && <option value="staging">Staging（测试）</option>}<option value="production">Production（正式签发）</option>
        </select></label>
        {accountCa === 'customacme' && <label className="form-field"><span>Directory URL</span><input type="url" value={accountDirectoryUrl} onChange={(event) => setAccountDirectoryUrl(event.target.value)} placeholder="https://ca.example.com/acme/directory" required maxLength={512} /></label>}
        {accountCaEntry.eab && <>
          <label className="form-field"><span>EAB KID</span><input value={eabKid} onChange={(event) => setEabKid(event.target.value)} maxLength={256} autoComplete="off" required /></label>
          <label className="form-field"><span>EAB HMAC Key</span><input type="password" value={eabHmacKey} onChange={(event) => setEabHmacKey(event.target.value)} maxLength={512} autoComplete="new-password" required /></label>
        </>}
        {accountEnvironment === 'production' && <label className="certificate-confirm"><input type="checkbox" checked={confirmProduction} onChange={(event) => setConfirmProduction(event.target.checked)} />我明确确认将向 production CA 注册账户</label>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !accountEmail.trim() || (accountEnvironment === 'production' && !confirmProduction) || (accountCa === 'customacme' && !accountDirectoryUrl.trim()) || (accountCaEntry.eab && (!eabKid.trim() || !eabHmacKey.trim()))}>创建 ACME 账户</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setAccountOpen(false)}>取消</button></div>
      </form>
    </Modal>}
    {orderOpen && <Modal title="申请新证书" wide onClose={() => { if (!busy) setOrderOpen(false); }}>
      <form className="dns-form certificate-setup-form" onSubmit={createAcmeOrder}>
        <label className="form-field"><span>已注册 ACME 账户</span><select value={issuanceAccountId} onChange={(event) => setIssuanceAccountId(event.target.value)} required>
          <option value="">选择 staging 或已确认的 production 账户</option>{accounts.filter((account) => account.status === 'ready').map((account) => <option key={account.id} value={account.id}>#{account.id} · {caName(account.ca)} · {account.environment} · {account.email}</option>)}
        </select></label>
        <label className="form-field certificate-domain-field"><span>证书域名（每行一个，可用通配符）</span><textarea value={domainsText} onChange={(event) => setDomainsText(event.target.value)} required maxLength={6000} spellCheck={false} placeholder={'example.com\nwww.example.com\n*.example.com'} /></label>
        <p className="form-hint">每个域名会自动匹配到已同步的 DNS Zone，可以跨多个 Zone、多个账号；匹配不到且没有 CNAME 代理时会拒绝创建。</p>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !issuanceAccountId || !domainsText.trim() || !selectedAccount?.nonceReady}>创建并准备签发任务</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setOrderOpen(false)}>取消</button></div>
      </form>
    </Modal>}
    {importOpen && <Modal title="导入已签发证书" wide onClose={() => { if (!busy) setImportOpen(false); }}>
      <form className="dns-form certificate-import-form" onSubmit={importCertificate}>
        <label className="form-field"><span>完整证书链（PEM）</span><textarea value={fullchain} onChange={(event) => setFullchain(event.target.value)} required maxLength={48 * 1024} autoComplete="off" spellCheck={false} aria-label="完整证书链 PEM" placeholder="-----BEGIN CERTIFICATE-----" /></label>
        <label className="form-field"><span>未加密 RSA 私钥（PEM）</span><textarea value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} required maxLength={16 * 1024} autoComplete="off" spellCheck={false} aria-label="RSA 私钥 PEM" placeholder="-----BEGIN PRIVATE KEY-----" /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !fullchain.trim() || !privateKey.trim()}>{busy ? '正在处理…' : '验证并导入'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setImportOpen(false)}>取消</button></div>
      </form>
    </Modal>}
    {material && <Modal title={`证书材料 #${material.orderId}`} wide onClose={closeMaterial}>
      <div className="certificate-domains">{material.domains.map((domain) => <span className="data-badge mono" key={domain}>{domain}</span>)}</div>
      <form className="dns-form certificate-material" onSubmit={(event) => event.preventDefault()}>
        <label className="form-field"><span>证书（PEM 格式）</span>
          <textarea readOnly value={material.crt} spellCheck={false} aria-label="证书 PEM" />
        </label>
        <label className="form-field"><span>私钥（PEM 格式）</span>
          <textarea readOnly value={material.key} spellCheck={false} aria-label="私钥 PEM" />
        </label>
        <div className="form-actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void copyText('证书', material.crt)}>复制证书</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => saveBlob(`fullchain-${material.orderId}.crt`, new Blob([material.crt], { type: 'application/x-pem-file' }))}>下载 .crt</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void copyText('私钥', material.key)}>复制私钥</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => saveBlob(`private-${material.orderId}.key`, new Blob([material.key], { type: 'application/x-pem-file' }))}>下载 .key</button>
        </div>
        <div className="certificate-material-pfx">
          <h3>IIS / PKCS#12（PFX）</h3>
          <p className="form-hint">每次下载都会生成新的随机密码，密码只在本次下载后显示，关闭窗口后无法再次查看。</p>
          <div className="form-actions">
            <button className="button button-primary" type="button" disabled={busy} onClick={() => void downloadPfx(material.orderId)}>下载 PFX</button>
            <button className="button button-quiet" type="button" disabled={busy} onClick={closeMaterial}>关闭</button>
          </div>
          {pfxPassword && <div className="notice" role="status">
            <span>本次 PFX 密码（只显示这一次）</span>
            <strong className="mono">{pfxPassword}</strong>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => void copyText('PFX 密码', pfxPassword)}>复制密码</button>
          </div>}
        </div>
      </form>
    </Modal>}
    {renewOpen && <Modal title="续签设置" onClose={() => { if (!busy) setRenewOpen(false); }}>
      <CertificateSettings session={session} onExpired={onExpired} onSaved={() => { setRenewOpen(false); setNotice('自动续签设置已保存'); }} />
    </Modal>}
    {editingAccount && <Modal title={`编辑 ACME 账户 #${editingAccount.id}`} onClose={() => { if (!busy) setEditingAccount(null); }}>
      <form className="dns-form" onSubmit={saveAccountEmail}>
        <label className="form-field"><span>联系邮箱</span><input type="email" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} required maxLength={254} autoComplete="email" /></label>
        <p className="form-hint">{editingAccount.status === 'ready' ? '邮箱保存在 CA 账户上，保存时会带一次性 nonce 向 CA 更新联系邮箱。' : '该账户尚未在 CA 注册，保存后注册时将使用新的联系邮箱。'}</p>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !editEmail.trim() || editEmail.trim().toLowerCase() === editingAccount.email}>{busy ? '正在保存…' : '保存修改'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setEditingAccount(null)}>取消</button></div>
      </form>
    </Modal>}
    {editingOrder && <Modal title={`编辑证书订单 #${editingOrder.id}`} onClose={() => { if (!busy) setEditingOrder(null); }}>
      <form className="dns-form" onSubmit={saveOrder}>
        <label className="form-field"><span>备注（可选）</span><input value={orderRemark} onChange={(event) => setOrderRemark(event.target.value)} maxLength={100} placeholder="例如 官网主站" /></label>
        <label className="certificate-confirm"><input type="checkbox" checked={orderAuto} disabled={editingOrder.revokedAt !== null} onChange={(event) => setOrderAuto(event.target.checked)} />自动续签{editingOrder.revokedAt !== null ? '（已吊销的证书不能开启）' : ''}</label>
        <p className="form-hint">证书内容与域名属于已签发材料，不能修改；这里只调整备注与自动续签。</p>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存修改'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setEditingOrder(null)}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
