import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { Modal } from './Modal';

interface Alias { id: string; name: string; remoteId: string }
interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

export function DnsAliases({ session, domainId, navigate, onExpired }: Props) {
  const [items, setItems] = useState<Alias[]>([]);
  const [alias, setAlias] = useState('');
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
      const result = await request<{ code: 0; items: Alias[] }>(`/api/v1/dns/domains/${domainId}/aliases`, { signal });
      if (!signal.aborted) setItems(result.items);
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [domainId, handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; items: Alias[] }>(`/api/v1/dns/domains/${domainId}/aliases`, 'POST', { alias }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setItems(result.items);
      setAlias('');
      setFormOpen(false);
      setNotice('域名别名已添加');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(item: Alias) {
    if (busy || !window.confirm(`确认删除别名「${item.name}」？`)) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/dns/domains/${domainId}/aliases/${item.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setItems((current) => current.filter((row) => row.id !== item.id));
      setNotice('域名别名已删除');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-tools">
      <a className="button button-secondary" href={`/record/${domainId}`} onClick={(event) => { event.preventDefault(); navigate(`/record/${domainId}`); }}>返回解析记录</a>
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="alias-list-title">
      <div className="panel-heading"><div><h2 id="alias-list-title">别名列表</h2></div><div className="panel-heading-actions"><span className="panel-meta">共 {items.length} 个</span><button className="button button-primary" type="button" disabled={loading} onClick={() => { setAlias(''); setError(''); setNotice(''); setFormOpen(true); }}><Icon name="plus" />添加别名</button></div></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取别名…</div>
        : items.length === 0 ? <div className="panel-empty">还没有域名别名。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>别名</th><th>厂商编号</th><th>操作</th></tr></thead>
            <tbody>{items.map((item) => <tr key={item.id}>
              <td className="mono">{item.name}</td>
              <td className="mono">{item.remoteId}</td>
              <td><button className="button button-quiet" disabled={busy} onClick={() => void remove(item)}>删除</button></td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    {formOpen && <Modal title="添加别名" onClose={() => { if (!busy) setFormOpen(false); }}>
      <form className="dns-form" onSubmit={add}>
        <label className="form-field"><span>别名域名</span><input value={alias} onChange={(event) => setAlias(event.target.value)} required maxLength={253} placeholder="alias.example.com" /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>添加</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
