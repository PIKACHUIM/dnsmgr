import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { type DomainSummary, type RecordRow } from './record-utils';

interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

interface WeightSubdomain {
  subdomain: string;
  rr: string;
  type: string;
  line: string;
  count: number;
  enabled: boolean;
}

const PAGE_SIZE = 20;

export function RecordWeight({ session, domainId, navigate, onExpired }: Props) {
  const [domain, setDomain] = useState<DomainSummary | null>(null);
  const [rows, setRows] = useState<WeightSubdomain[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<WeightSubdomain | null>(null);
  const [weightRecords, setWeightRecords] = useState<RecordRow[] | null>(null);
  const [weights, setWeights] = useState<{ [id: string]: string }>({});
  const [enabled, setEnabled] = useState(true);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const loadWeights = useCallback(async (signal: AbortSignal, currentPage: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(currentPage), pageSize: String(PAGE_SIZE) });
      if (keyword) params.set('keyword', keyword);
      const result = await request<{ code: 0; total: number; items: WeightSubdomain[] }>(
        `/api/v1/dns/domains/${domainId}/weight-subdomains?${params}`, { signal },
      );
      if (signal.aborted) return;
      setRows(result.items);
      setTotal(result.total);
      setSupported(true);
    } catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 501) { setSupported(false); setRows([]); setTotal(0); }
      else handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [domainId, handle, keyword]);

  useEffect(() => {
    const controller = new AbortController();
    request<{ code: 0; domain: DomainSummary }>(`/api/v1/dns/domains/${domainId}`, { signal: controller.signal })
      .then((info) => { if (!controller.signal.aborted) setDomain(info.domain); })
      .catch((failure) => { if (!controller.signal.aborted) handle(failure); });
    void loadWeights(controller.signal, page);
    return () => controller.abort();
  }, [domainId, handle, loadWeights, page]);

  function applySearch(event: React.FormEvent) {
    event.preventDefault();
    setKeyword(keywordDraft.trim());
    setPage(1);
  }

  async function toggleStatus(row: WeightSubdomain) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/dns/domains/${domainId}/weights`, 'POST', {
        action: 'status', subdomain: row.subdomain, type: row.type, line: row.line, enabled: !row.enabled,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`已${row.enabled ? '关闭' : '开启'} ${row.subdomain} 的权重配置`);
      await loadWeights(controller.signal, page);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function openEditor(row: WeightSubdomain) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setEditing(row);
    setWeightRecords(null);
    const controller = new AbortController();
    try {
      const result = await request<{ code: 0; total: number; items: RecordRow[] }>(
        `/api/v1/dns/domains/${domainId}/records?page=1&pageSize=100&name=${encodeURIComponent(row.rr)}`, { signal: controller.signal },
      );
      let matched = result.items.filter((record) => record.name === row.rr && record.line === row.line);
      if (matched.length === 0) {
        const all = await request<{ code: 0; total: number; items: RecordRow[] }>(
          `/api/v1/dns/domains/${domainId}/records?page=1&pageSize=100`, { signal: controller.signal },
        );
        matched = all.items.filter((record) => record.name === row.rr && record.line === row.line);
      }
      setWeightRecords(matched);
      setWeights(Object.fromEntries(matched.map((record) => [record.id, String(record.weight ?? 0)])));
      setEnabled(row.type === 'CNAME' ? true : row.enabled);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function saveEditor(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !editing) return;
    if (enabled && weightRecords && weightRecords.length === 0) { setError('该线路没有可配置权重的记录'); return; }
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; updated: number }>(
        `/api/v1/dns/domains/${domainId}/weights`, 'POST', {
          action: 'update', subdomain: editing.subdomain, type: editing.type, line: editing.line, enabled,
          weights: enabled ? Object.fromEntries(Object.entries(weights).map(([id, value]) => [id, Number(value)])) : {},
        },
        controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(enabled ? `已保存权重配置，更新 ${result.updated} 条记录` : '已关闭权重配置');
      setEditing(null);
      setWeightRecords(null);
      await loadWeights(controller.signal, page);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-tools">
      <button className="button button-secondary" type="button" onClick={() => navigate(`/record/${domainId}`)}>返回解析记录</button>
      {domain && <span className="mono">{domain.name} · {domain.accountName}（{domain.accountType}）</span>}
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!supported ? <section className="panel"><div className="panel-empty">当前服务商不支持权重配置，仅阿里云解析提供此功能。</div></section>
      : <>
        <section className="panel" aria-labelledby="weight-list-title">
          <div className="panel-heading"><div><h2 id="weight-list-title">权重配置</h2></div><span className="panel-meta">共 {total} 个子域名 · 权重范围 0–100</span></div>
          <form className="dns-search" onSubmit={applySearch}>
            <input aria-label="搜索子域名" type="search" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} maxLength={128} placeholder="子域名，例如 www" />
            <button className="button button-secondary" type="submit" disabled={loading || busy}>搜索</button>
            {(keywordDraft || keyword) && <button className="button button-quiet" type="button" disabled={loading || busy} onClick={() => { setKeywordDraft(''); setKeyword(''); setPage(1); }}>清除</button>}
          </form>
          {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取权重配置…</div>
            : rows.length === 0 ? <div className="panel-empty">暂无开启权重配置的子域名。</div>
              : <div className="table-wrap"><table className="data-table">
                <thead><tr><th>子域名</th><th>类型</th><th>线路</th><th>记录数量</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>{rows.map((row) => <tr key={`${row.subdomain}-${row.type}-${row.line}`}>
                  <td className="mono">{row.subdomain}</td>
                  <td>{row.type}</td>
                  <td>{row.line}</td>
                  <td>{row.count}</td>
                  <td>{row.enabled ? '已开启' : '已关闭'}</td>
                  <td className="row-actions">
                    <button className="button button-secondary" disabled={busy} onClick={() => void openEditor(row)}>设置权重</button>
                    {row.type === 'CNAME'
                      ? <span className="form-hint">CNAME 默认开启权重</span>
                      : <button className="button button-quiet" disabled={busy} onClick={() => void toggleStatus(row)}>{row.enabled ? '关闭权重' : '开启权重'}</button>}
                  </td>
                </tr>)}</tbody>
              </table></div>}
          <div className="pagination">
            <button className="button button-secondary" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>
            <span className="mono">第 {page} 页</span>
            <button className="button button-secondary" disabled={page * PAGE_SIZE >= total || loading} onClick={() => setPage((current) => current + 1)}>下一页</button>
          </div>
        </section>
        {editing && <section className="panel" aria-labelledby="weight-editor-title">
          <div className="panel-heading"><div><h2 id="weight-editor-title">设置权重 · {editing.subdomain}</h2></div><span className="panel-meta">{editing.type} · {editing.line}</span></div>
          <form className="dns-form" onSubmit={saveEditor}>
            <label className="form-field"><span>权重开关</span>
              <select value={enabled ? '1' : '0'} onChange={(event) => setEnabled(event.target.value === '1')} disabled={editing.type === 'CNAME'}>
                <option value="1">开启</option>
                <option value="0">关闭</option>
              </select>
            </label>
            <div className="form-actions">
              <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存权重'}</button>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setEditing(null); setWeightRecords(null); }}>取消</button>
            </div>
          </form>
          {weightRecords === null ? <div className="panel-loading" role="status"><span className="spinner" />正在读取线路记录…</div>
            : weightRecords.length === 0 ? <div className="panel-empty">该线路没有可配置权重的记录。</div>
              : <div className="table-wrap"><table className="data-table">
                <thead><tr><th>主机记录</th><th>类型</th><th>记录值</th><th>权重</th></tr></thead>
                <tbody>{weightRecords.map((record) => <tr key={record.id}>
                  <td className="mono">{record.name}</td>
                  <td>{record.type}</td>
                  <td className="record-value">{record.value}</td>
                  <td><input type="number" min={0} max={100} value={weights[record.id] ?? '0'} disabled={!enabled}
                    aria-label={`${record.name} 权重`}
                    onChange={(event) => setWeights((current) => ({ ...current, [record.id]: event.target.value }))} /></td>
                </tr>)}</tbody>
              </table></div>}
        </section>}
      </>}
  </>;
}
