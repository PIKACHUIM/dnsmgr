import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, type Session } from './api';

interface LogRow {
  id: number; userId: number; action: string; target: string | null;
  detail: string | null; createdAt: number;
}

interface Props {
  session: Session;
  onExpired: (message: string) => void;
}

const PAGE_SIZE = 30;

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

export function DnsLogs({ session, onExpired }: Props) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [domain, setDomain] = useState('');
  const [uid, setUid] = useState('');
  const [applied, setApplied] = useState({ keyword: '', domain: '', uid: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal, currentPage: number, filters: typeof applied) => {
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(currentPage), pageSize: String(PAGE_SIZE) });
    if (filters.keyword) query.set('keyword', filters.keyword);
    if (filters.domain) query.set('domain', filters.domain);
    if (filters.uid) query.set('uid', filters.uid);
    try {
      const result = await request<{ code: 0; total: number; items: LogRow[] }>(`/api/v1/dns/logs?${query}`, { signal });
      if (signal.aborted) return;
      setRows(result.items);
      setTotal(result.total);
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, page, applied);
    return () => controller.abort();
  }, [load, page, applied]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    setPage(1);
    setApplied({ keyword: keyword.trim(), domain: domain.trim(), uid: uid.trim() });
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <section className="panel" aria-labelledby="log-list-title">
      <div className="panel-heading"><div><h2 id="log-list-title">操作日志</h2></div><span className="panel-meta">共 {total} 条</span></div>
      <form className="dns-search" onSubmit={search}>
        <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="域名" maxLength={253} aria-label="按域名筛选" />
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="操作或详情关键字" maxLength={64} aria-label="按关键字筛选" />
        {session.user.level === 2 && <input value={uid} onChange={(event) => setUid(event.target.value)} placeholder="用户 ID" inputMode="numeric" maxLength={10} aria-label="按用户筛选" />}
        <button className="button button-secondary" type="submit">筛选</button>
      </form>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取日志…</div>
        : rows.length === 0 ? <div className="panel-empty">没有匹配的日志。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>时间</th><th>用户</th><th>操作</th><th>对象</th><th>详情</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.id}>
              <td className="mono">{formatTime(row.createdAt)}</td>
              <td>{row.userId}</td>
              <td><span className="mono">{row.action}</span></td>
              <td>{row.target || '—'}</td>
              <td>{row.detail || '—'}</td>
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
