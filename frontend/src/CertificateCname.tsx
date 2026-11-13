import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { InfoTip } from './InfoTip';
import { Modal } from './Modal';

interface CnameRow {
  id: number; domain: string; target: string; dnsDomainId: number; zoneName: string;
  enabled: boolean; remark: string | null; createdAt: number; updatedAt: number;
}
interface Props { session: Session; onExpired: (message: string) => void }

function date(value: number): string {
  return new Date(value * 1000).toLocaleString();
}

export function CertificateCname({ session, onExpired }: Props) {
  const [items, setItems] = useState<CnameRow[]>([]);
  const [domain, setDomain] = useState('');
  const [target, setTarget] = useState('');
  const [remark, setRemark] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const result = await request<{ code: 0; items: CnameRow[] }>('/api/v1/cert/cname', { signal });
      if (!signal.aborted) setItems(result.items);
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/cert/cname', 'POST', {
        domain: domain.trim(), target: target.trim(), remark: remark.trim() || undefined,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setDomain(''); setTarget(''); setRemark('');
      setFormOpen(false);
      setNotice('CNAME 代理已保存；请在域名服务商处把 challenge CNAME 手动指向该目标。');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function toggle(row: CnameRow) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/cname/${row.id}`, 'PATCH', { enabled: !row.enabled }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`CNAME 代理 ${row.domain} 已${row.enabled ? '停用' : '启用'}。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(row: CnameRow) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cert/cname/${row.id}`, 'DELETE', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`CNAME 代理 ${row.domain} 已删除。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="cname-list-title">
      <div className="panel-heading"><div><h2 id="cname-list-title">代理列表</h2><InfoTip label="CNAME 代理说明" text="当证书域名不在本系统管理的 Zone 内时，在自有 Zone 中为 _acme-challenge.<域名> 创建 CNAME 指向这里配置的目标。目标必须位于已同步的 DNS Zone。" /></div><div className="panel-heading-actions"><span className="panel-meta">共 {items.length} 条</span><button className="button button-primary" type="button" disabled={loading} onClick={() => { setDomain(''); setTarget(''); setRemark(''); setError(''); setNotice(''); setFormOpen(true); }}><Icon name="plus" />添加代理</button></div></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取 CNAME 代理…</div>
        : items.length === 0 ? <div className="panel-empty">还没有配置 CNAME 代理。</div>
          : <div className="table-wrap"><table className="data-table certificate-table">
            <thead><tr><th>证书域名</th><th>CNAME 目标</th><th>写入 Zone</th><th>状态</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>{items.map((row) => <tr key={row.id}>
              <td className="mono">{row.domain}</td>
              <td className="mono">{row.target}</td>
              <td>{row.zoneName}</td>
              <td><span className={`data-badge${row.enabled ? '' : ' muted'}`}>{row.enabled ? '启用' : '停用'}</span><span className="value-detail">{date(row.updatedAt)}</span></td>
              <td>{row.remark ?? '—'}</td>
              <td className="certificate-order-actions">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => void toggle(row)}>{row.enabled ? '停用' : '启用'}</button>
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void remove(row)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    {formOpen && <Modal title="添加 CNAME 代理" onClose={() => { if (!busy) setFormOpen(false); }}>
      <form className="dns-form certificate-setup-form" onSubmit={create}>
        <label className="form-field"><span>证书域名</span><input value={domain} onChange={(event) => setDomain(event.target.value)} required maxLength={253} placeholder="customer.example" /></label>
        <label className="form-field"><span>CNAME 目标</span><input value={target} onChange={(event) => setTarget(event.target.value)} required maxLength={253} placeholder="_acme-challenge.customer.example.proxy.example" /></label>
        <label className="form-field"><span>备注（选填）</span><input value={remark} onChange={(event) => setRemark(event.target.value)} maxLength={200} /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !domain.trim() || !target.trim()}>{busy ? '正在保存…' : '添加 CNAME 代理'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
