import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, type Session } from './api';
import type { DomainSummary } from './record-utils';

interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

interface VendorLog { time: string | null; action: string }

const PAGE_SIZE = 50;

export function DnsRecordLog({ session, domainId, navigate, onExpired }: Props) {
  const [domain, setDomain] = useState<DomainSummary | null>(null);
  const [logs, setLogs] = useState<VendorLog[]>([]);
  const [total, setTotal] = useState(0);
  const [supported, setSupported] = useState(true);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      request<{ code: 0; domain: DomainSummary }>(`/api/v1/dns/domains/${domainId}`, { signal: controller.signal }),
      request<{ code: 0; supported: boolean; total: number; items: VendorLog[] }>(
        `/api/v1/dns/domains/${domainId}/record-logs?page=${page}&pageSize=${PAGE_SIZE}`, { signal: controller.signal },
      ),
    ]).then(([info, result]) => {
      if (controller.signal.aborted) return;
      setDomain(info.domain);
      setSupported(result.supported);
      setLogs(result.items);
      setTotal(result.total);
    }).catch((failure) => { if (!controller.signal.aborted) handle(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [domainId, handle, page]);

  return <>
    <div className="page-tools">
      <button className="button button-secondary" type="button" onClick={() => navigate(`/record/${domainId}`)}>返回解析记录</button>
      {domain && <span className="mono">{domain.name} · {domain.accountName}（{domain.accountType}）</span>}
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <section className="panel" aria-labelledby="record-log-title">
      <div className="panel-heading"><div><h2 id="record-log-title">服务商操作日志</h2></div><span className="panel-meta">共 {total} 条 · 只读</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取日志…</div>
        : !supported ? <div className="panel-empty">当前服务商不提供解析操作日志。</div>
          : logs.length === 0 ? <div className="panel-empty">服务商没有返回日志。</div>
            : <div className="table-wrap"><table className="data-table">
              <thead><tr><th>时间</th><th>操作</th></tr></thead>
              <tbody>{logs.map((log, index) => <tr key={`${log.time ?? 't'}-${index}`}>
                <td className="mono">{log.time ?? '—'}</td>
                <td>{log.action}</td>
              </tr>)}</tbody>
            </table></div>}
      <div className="pagination">
        <button className="button button-secondary" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>
        <span className="mono">第 {page} 页</span>
        <button className="button button-secondary" disabled={page * PAGE_SIZE >= total || loading} onClick={() => setPage((current) => current + 1)}>下一页</button>
      </div>
    </section>
  </>;
}
