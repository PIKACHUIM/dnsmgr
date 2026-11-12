import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { RECORD_TYPES, loadDomains, typeLabel, type DomainSummary, type RecordRow } from './record-utils';

interface Props {
  session: Session;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

interface SearchResult extends RecordRow {
  domainId: number;
  domainName: string;
  key: string;
}

function matchesValue(recordValue: string, keyword: string): boolean {
  const target = keyword.trim().toLowerCase();
  if (!target) return false;
  return recordValue.split(',').some((part) => {
    const normalized = part.trim().replace(/^"|"$/g, '').toLowerCase();
    return normalized === target || normalized === `${target}.`;
  });
}

export function RecordSearch({ session, navigate, onExpired }: Props) {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [failedDomains, setFailedDomains] = useState(0);
  const [editType, setEditType] = useState('A');
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    loadDomains(controller.signal).then((items) => { if (!controller.signal.aborted) setDomains(items); })
      .catch((failure) => { if (!controller.signal.aborted) handle(failure); });
    return () => controller.abort();
  }, [handle]);

  async function startSearch(event: React.FormEvent) {
    event.preventDefault();
    const value = keywordDraft.trim();
    if (!value) { setError('请输入要搜索的记录值'); return; }
    if (domains.length === 0) { setError('当前账号没有可搜索的域名'); return; }
    if (searching) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setError('');
    setNotice('');
    setKeyword(value);
    setResults([]);
    setSelected([]);
    setFailedDomains(0);
    setProgress({ done: 0, total: domains.length });
    const collected: SearchResult[] = [];
    let failed = 0;
    let done = 0;
    for (const domain of domains) {
      if (controller.signal.aborted) break;
      try {
        for (let page = 1; page <= 20; page++) {
          const list = await request<{ code: 0; total: number; items: RecordRow[] }>(
            `/api/v1/dns/domains/${domain.id}/records?page=${page}&pageSize=100&value=${encodeURIComponent(value)}`,
            { signal: controller.signal },
          );
          for (const record of list.items) {
            if (matchesValue(record.value, value)) {
              collected.push({ ...record, domainId: domain.id, domainName: domain.name, key: `${domain.id}:${record.id}` });
            }
          }
          if (list.items.length < 100 || page * 100 >= list.total) break;
        }
      } catch (failure) {
        if (controller.signal.aborted) break;
        failed++;
      }
      done++;
      setProgress({ done, total: domains.length });
      setResults([...collected]);
    }
    if (!controller.signal.aborted) {
      setSearching(false);
      setFailedDomains(failed);
      setSelected(collected.map((row) => row.key));
    }
  }

  function stopSearch() {
    abortRef.current?.abort();
    setSearching(false);
  }

  function toggle(key: string) {
    setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  const chosen = results.filter((row) => selected.includes(row.key));

  async function applyEdit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || chosen.length === 0) return;
    if (!editValue.trim()) { setError('记录值不能为空'); return; }
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    let success = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const row of chosen) {
      try {
        await send(`/api/v1/dns/domains/${row.domainId}/records/${row.id}`, 'PUT', {
          name: row.name, type: editType, value: editValue.trim(), line: row.line,
          ttl: row.ttl, mx: row.mx, weight: row.weight, remark: row.remark,
        }, signal.signal, { 'X-CSRF-Token': session.csrfToken });
        success++;
        setResults((current) => current.map((item) => item.key === row.key ? { ...item, type: editType, value: editValue.trim() } : item));
      } catch (failure) {
        failed++;
        if (errors.length < 5) errors.push(`${row.name}.${row.domainName}：${errorMessage(failure)}`);
      }
    }
    setBusy(false);
    setNotice(`批量修改完成：成功 ${success} 条${failed ? `，失败 ${failed} 条（${errors.join('；')}）` : ''}`);
  }

  async function removeSelected() {
    if (busy || chosen.length === 0) return;
    if (!window.confirm(`确认删除选中的 ${chosen.length} 条解析记录？删除后不可恢复。`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    let success = 0;
    let failed = 0;
    const removed = new Set<string>();
    for (const row of chosen) {
      try {
        await send(`/api/v1/dns/domains/${row.domainId}/records/${row.id}`, 'DELETE', undefined, signal.signal, { 'X-CSRF-Token': session.csrfToken });
        success++;
        removed.add(row.key);
      } catch { failed++; }
    }
    setResults((current) => current.filter((item) => !removed.has(item.key)));
    setSelected((current) => current.filter((key) => !removed.has(key)));
    setBusy(false);
    setNotice(`批量删除完成：成功 ${success} 条${failed ? `，失败 ${failed} 条` : ''}`);
  }

  return <>
    <div className="page-tools">
      <button className="button button-secondary" type="button" onClick={() => navigate('/domain')}>返回域名列表</button>
      <button className="button button-secondary" type="button" onClick={() => navigate('/record/smartparse')}>智能批量添加</button>
      <span className="mono">可搜索 {domains.length} 个域名</span>
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="record-search-title">
      <div className="panel-heading"><div><h2 id="record-search-title">按记录值搜索</h2></div><span className="panel-meta">逐个域名查询，每个域名最多读取 2000 条匹配记录</span></div>
      <form className="dns-search" onSubmit={startSearch}>
        <input aria-label="记录值" type="search" value={keywordDraft} onChange={(event) => setKeywordDraft(event.target.value)} maxLength={255} placeholder="要搜索的记录值，例如 1.1.1.1" />
        <button className="button button-primary" type="submit" disabled={searching}>{searching ? '正在搜索…' : '开始搜索'}</button>
        {searching && <button className="button button-quiet" type="button" onClick={stopSearch}>停止</button>}
      </form>
      {(searching || progress.total > 0) && <p className="form-hint">
        {searching ? `正在搜索 ${progress.done} / ${progress.total} 个域名…` : `搜索完成，共 ${progress.total} 个域名${failedDomains ? `，${failedDomains} 个域名搜索失败` : ''}，找到 ${results.length} 条记录`}
        {keyword && <span className="mono">（记录值：{keyword}）</span>}
      </p>}
    </section>
    <section className="panel" aria-labelledby="record-search-result-title">
      <div className="panel-heading"><div><h2 id="record-search-result-title">搜索结果</h2></div><span className="panel-meta">已选 {selected.length} 条</span></div>
      {results.length === 0 ? <div className="panel-empty">{searching ? '正在读取域名解析记录…' : '尚无搜索结果。'}</div>
        : <>
          <div className="dns-batch">
            <button className="button button-quiet" type="button" disabled={busy} onClick={() => setSelected(results.map((row) => row.key))}>全选</button>
            <button className="button button-quiet" type="button" disabled={busy} onClick={() => setSelected([])}>清空</button>
            <button className="button button-quiet" type="button" disabled={busy || chosen.length === 0} onClick={() => void removeSelected()}>批量删除</button>
          </div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>选择</th><th>域名</th><th>主机</th><th>类型</th><th>记录值</th><th>线路</th><th>TTL</th></tr></thead>
            <tbody>{results.map((row) => <tr key={row.key}>
              <td><input type="checkbox" checked={selected.includes(row.key)} aria-label={`选择 ${row.name}.${row.domainName}`} onChange={() => toggle(row.key)} /></td>
              <td className="mono">{row.domainName}</td>
              <td className="mono">{row.name}</td>
              <td>{typeLabel(row.type)}</td>
              <td className="record-value">{row.value}</td>
              <td>{row.line}</td>
              <td>{row.ttl}</td>
            </tr>)}</tbody>
          </table></div>
          <form className="dns-form" onSubmit={applyEdit}>
            <label className="form-field"><span>新类型</span>
              <select value={editType} onChange={(event) => setEditType(event.target.value)}>
                {RECORD_TYPES.map((item) => <option key={item} value={item}>{typeLabel(item)}</option>)}
              </select>
            </label>
            <label className="form-field"><span>新记录值</span>
              <input value={editValue} onChange={(event) => setEditValue(event.target.value)} maxLength={2048} placeholder="将应用到所有选中记录" required />
            </label>
            <div className="form-actions">
              <button className="button button-primary" type="submit" disabled={busy || chosen.length === 0}>{busy ? '正在修改…' : `批量修改 ${chosen.length} 条`}</button>
            </div>
          </form>
        </>}
    </section>
  </>;
}
