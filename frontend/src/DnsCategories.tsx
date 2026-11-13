import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { Modal } from './Modal';

interface Category { id: number; name: string; sort: number; domainCount: number }

interface Props {
  session: Session;
  onExpired: (message: string) => void;
}

export function DnsCategories({ session, onExpired }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [sort, setSort] = useState('0');
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
      const result = await request<{ code: 0; items: Category[] }>('/api/v1/dns/categories', { signal });
      if (!signal.aborted) setCategories(result.items);
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/dns/categories', 'POST', { name: name.trim(), sort: Number(sort) }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`分类「${name.trim()}」已创建`);
      setName('');
      setFormOpen(false);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function rename(category: Category) {
    const value = window.prompt('新的分类名称', category.name)?.trim();
    if (!value || value === category.name) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/dns/categories/${category.id}`, 'PUT', { name: value }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(category: Category) {
    if (busy || !window.confirm(`确认删除分类「${category.name}」？`)) return;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/dns/categories/${category.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`分类「${category.name}」已删除`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="category-list-title">
      <div className="panel-heading"><div><h2 id="category-list-title">分类列表</h2></div><div className="panel-heading-actions"><span className="panel-meta">共 {categories.length} 个</span><button className="button button-primary" type="button" disabled={loading} onClick={() => { setName(''); setSort('0'); setError(''); setNotice(''); setFormOpen(true); }}><Icon name="plus" />新建分类</button></div></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取分类…</div>
        : categories.length === 0 ? <div className="panel-empty">还没有分类。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>名称</th><th>排序</th><th>域名数</th><th>操作</th></tr></thead>
            <tbody>{categories.map((category) => <tr key={category.id}>
              <td>{category.name}</td>
              <td className="mono">{category.sort}</td>
              <td>{category.domainCount}</td>
              <td className="row-actions">
                <button className="button button-secondary" disabled={busy} onClick={() => void rename(category)}>重命名</button>
                <button className="button button-quiet" disabled={busy} onClick={() => void remove(category)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    {formOpen && <Modal title="新建分类" onClose={() => { if (!busy) setFormOpen(false); }}>
      <form className="dns-form" onSubmit={create}>
        <label className="form-field"><span>分类名称</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={50} placeholder="例如：生产环境" /></label>
        <label className="form-field"><span>排序</span><input value={sort} onChange={(event) => setSort(event.target.value)} type="number" min={-1000000} max={1000000} /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>创建分类</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
