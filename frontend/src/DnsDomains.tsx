import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Domain {
  id: number; name: string; accountId: number; accountName: string; accountType: string;
  remark: string | null; recordCount: number; hidden: boolean;
}
interface Account { id: number; name: string; type: string }

interface Props {
  session: Session;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

const PAGE_SIZE = 20;

export function DnsDomains({ session, navigate, onExpired }: Props) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [name, setName] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal, currentPage: number, filter: string) => {
    setLoading(true);
    setError('');
    try {
      const [list, accountList] = await Promise.all([
        request<{ code: 0; total: number; items: Domain[] }>(
          `/api/v1/dns/domains?page=${currentPage}&pageSize=${PAGE_SIZE}${filter ? `&keyword=${encodeURIComponent(filter)}` : ''}`, { signal },
        ),
        request<{ code: 0; items: Account[] }>('/api/v1/dns/accounts', { signal }),
      ]);
      if (signal.aborted) return;
      setDomains(list.items);
      setTotal(list.total);
      setAccounts(accountList.items);
      setAccountId((value) => value || String(accountList.items[0]?.id ?? ''));
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, page, '');
    return () => controller.abort();
  }, [load, page]);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const controller = new AbortController();
    await load(controller.signal, 1, keyword.trim());
    setPage(1);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    try {
      const result = await send<{ code: 0; name: string }>('/api/v1/dns/domains', 'POST', { accountId: Number(accountId), name }, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`域名「${result.name}」已添加`);
      setName('');
      await load(signal.signal, page, '');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(domain: Domain) {
    if (busy || !window.confirm(`确认从面板移除「${domain.name}」？平台上的域名不会被删除。`)) return;
    setBusy(true);
    setError('');
    const signal = new AbortController();
    try {
      await send(`/api/v1/dns/domains/${domain.id}`, 'PATCH', { hidden: true }, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`已隐藏「${domain.name}」`);
      await load(signal.signal, page, '');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="domain-form-title">
      <div className="panel-heading"><div><h2 id="domain-form-title">添加域名</h2></div><span className="panel-meta">调用服务商接口</span></div>
      {accounts.length === 0
        ? <div className="panel-empty">请先在「域名账户」添加 DNS 账户。</div>
        : <form className="dns-form" onSubmit={submit}>
          <label className="form-field"><span>所属账户</span>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}（{account.type}）</option>)}
            </select>
          </label>
          <label className="form-field"><span>域名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="example.com" required maxLength={253} /></label>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在提交…' : '添加域名'}</button></div>
        </form>}
    </section>
    <section className="panel" aria-labelledby="domain-list-title">
      <div className="panel-heading"><div><h2 id="domain-list-title">域名列表</h2></div><span className="panel-meta">共 {total} 个</span></div>
      <form className="dns-search" onSubmit={search}><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="按域名搜索" maxLength={64} aria-label="按域名搜索" /><button className="button button-secondary" type="submit">搜索</button></form>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取域名…</div>
        : domains.length === 0 ? <div className="panel-empty">没有匹配的域名。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>域名</th><th>账户</th><th>记录数</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{domains.map((domain) => <tr key={domain.id}>
              <td><a href={`/record/${domain.id}`} onClick={(event) => { event.preventDefault(); navigate(`/record/${domain.id}`); }}>{domain.name}</a></td>
              <td>{domain.accountName}<span className="value-detail mono">{domain.accountType}</span></td>
              <td>{domain.recordCount}</td>
              <td>{domain.hidden ? '已隐藏' : '正常'}</td>
              <td className="row-actions"><a className="button button-secondary" href={`/record/${domain.id}`} onClick={(event) => { event.preventDefault(); navigate(`/record/${domain.id}`); }}>解析记录</a><button className="button button-quiet" disabled={busy} onClick={() => void remove(domain)}>隐藏</button></td>
            </tr>)}</tbody>
          </table></div>}
      <div className="pagination">
        <button className="button button-secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
        <span className="mono">第 {page} 页</span>
        <button className="button button-secondary" disabled={page * PAGE_SIZE >= total || loading} onClick={() => setPage((value) => value + 1)}>下一页</button>
      </div>
    </section>
  </>;
}
