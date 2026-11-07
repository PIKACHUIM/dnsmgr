import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface CertificateOrder {
  id: number;
  source: 'manual';
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

interface Props { session: Session; onExpired: (message: string) => void }

function date(value: number): string {
  return new Date(value * 1000).toLocaleString();
}

export function CertificateOrders({ session, onExpired }: Props) {
  const [items, setItems] = useState<CertificateOrder[]>([]);
  const [fullchain, setFullchain] = useState('');
  const [privateKey, setPrivateKey] = useState('');
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
      const result = await request<{ code: 0; items: CertificateOrder[] }>('/api/v1/cert/orders?limit=100&offset=0', { signal });
      if (!signal.aborted) setItems(result.items);
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

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="certificate-import-title">
      <div className="panel-heading"><div><h2 id="certificate-import-title">导入已签发证书</h2></div><span className="panel-meta">RSA · PEM · AES-GCM 加密存储</span></div>
      <p className="form-hint certificate-security-note">首阶段支持手动导入证书链和匹配的 RSA 私钥（至少 2048 位）。私钥不会回显在订单列表；CA 自动申请、续签和部署将在后续阶段接入。</p>
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
              <td><strong className="mono">#{order.id}</strong><span className="value-detail">手动导入</span></td>
              <td className="certificate-domains">{order.domains.map((domain) => <span className="data-badge mono" key={domain}>{domain}</span>)}</td>
              <td>{order.issuer}</td>
              <td className="mono">{order.keyType} {order.keySize}</td>
              <td><span>{date(order.issuedAt)}</span><span className="value-detail">到期 {date(order.expiresAt)}</span></td>
              <td><button className="button button-secondary" type="button" disabled={busy} onClick={() => void download(order)}>下载 PFX</button></td>
            </tr>)}</tbody>
          </table></div>}
      <div className="panel-footnote">PFX 遵循旧接口兼容密码 123456。导出操作会写审计；审计未确认时不会返回证书材料。</div>
    </section>
  </>;
}
