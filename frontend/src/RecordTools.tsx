import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, errorMessage, request, type Session } from './api';

interface Domain { id: number; name: string; accountName: string; accountType: string }

interface Props {
  session: Session;
  mode: 'batchadd' | 'batchedit';
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

const titles: Record<Props['mode'], { title: string; scope: string; action: string }> = {
  batchadd: { title: '批量添加解析', scope: '先选择域名，再按行填写主机记录与记录值', action: '批量添加' },
  batchedit: { title: '批量修改解析', scope: '先选择域名，再勾选记录批量修改类型、记录值或线路', action: '批量修改' },
};

export function RecordTools({ mode, navigate, onExpired }: Props) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const result = await request<{ code: 0; items: Domain[] }>('/api/v1/dns/domains?page=1&pageSize=100', { signal });
      if (!signal.aborted) setDomains(result.items);
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

  const visible = useMemo(() => {
    const value = keyword.trim().toLowerCase();
    if (!value) return domains;
    return domains.filter((domain) => domain.name.toLowerCase().includes(value) || domain.accountName.toLowerCase().includes(value));
  }, [domains, keyword]);

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <section className="panel" aria-labelledby="record-tools-title">
      <div className="panel-heading"><div><h2 id="record-tools-title">{titles[mode].title}</h2></div><span className="panel-meta">{domains.length} 个域名</span></div>
      <form className="dns-search" onSubmit={(event) => event.preventDefault()}>
        <input aria-label="筛选域名" type="search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="按域名或账户筛选" maxLength={128} />
      </form>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取域名…</div>
        : visible.length === 0 ? <div className="panel-empty">没有匹配的域名。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>域名</th><th>服务商</th><th>操作</th></tr></thead>
            <tbody>{visible.map((domain) => <tr key={domain.id}>
              <td className="mono">{domain.name}</td>
              <td>{domain.accountName}<span className="value-detail mono">{domain.accountType}</span></td>
              <td className="row-actions">
                <button className="button button-secondary" onClick={() => navigate(`/record/${mode}/${domain.id}`)}>{titles[mode].action}</button>
                <button className="button button-quiet" onClick={() => navigate(`/record/${domain.id}`)}>解析记录</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
  </>;
}
