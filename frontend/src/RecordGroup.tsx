import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { typeLabel, type DomainSummary, type RecordRow } from './record-utils';

interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

interface RecordGroup { id: string; name: string; count: number | null }

const PAGE_SIZE = 50;

export function RecordGroup({ session, domainId, navigate, onExpired }: Props) {
  const [domain, setDomain] = useState<DomainSummary | null>(null);
  const [groups, setGroups] = useState<RecordGroup[]>([]);
  const [groupError, setGroupError] = useState('');
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [groupId, setGroupId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const loadGroups = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await request<{ code: 0; items: RecordGroup[] }>(
        `/api/v1/dns/domains/${domainId}/record-groups`, { signal },
      );
      if (!signal.aborted) {
        setGroups(result.items);
        setGroupError('');
        setGroupId((current) => current || result.items[0]?.id || '');
      }
    } catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 501) setGroupError(errorMessage(failure));
      else handle(failure);
    }
  }, [domainId, handle]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      request<{ code: 0; domain: DomainSummary }>(`/api/v1/dns/domains/${domainId}`, { signal: controller.signal }),
      request<{ code: 0; total: number; items: RecordRow[] }>(
        `/api/v1/dns/domains/${domainId}/records?page=${page}&pageSize=${PAGE_SIZE}`, { signal: controller.signal },
      ),
    ]).then(([info, list]) => {
      if (controller.signal.aborted) return;
      setDomain(info.domain);
      setRecords(list.items);
      setTotal(list.total);
    }).catch((failure) => { if (!controller.signal.aborted) handle(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    void loadGroups(controller.signal);
    return () => controller.abort();
  }, [domainId, handle, loadGroups, page]);

  function toggle(recordId: string) {
    setSelected((current) => current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (selected.length === 0) { setError('请先选择要移动的解析记录'); return; }
    if (groupId === '') { setError('请选择目标分组'); return; }
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; moved: number }>(
        `/api/v1/dns/domains/${domainId}/records/group`, 'POST',
        { recordIds: selected, groupId },
        controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(`已移动 ${result.moved} 条解析记录到目标分组`);
      setSelected([]);
      await loadGroups(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  const grouped = groups.find((group) => group.id === groupId);

  return <>
    <div className="page-tools">
      <button className="button button-secondary" type="button" onClick={() => navigate(`/record/${domainId}`)}>返回解析记录</button>
      <button className="button button-secondary" type="button" disabled={busy} onClick={() => { void loadGroups(new AbortController().signal); }}>刷新分组</button>
      {domain && <span className="mono">{domain.name} · {domain.accountName}（{domain.accountType}）</span>}
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {groupError && <div className="notice notice-error" role="alert">{groupError}</div>}
    <section className="panel" aria-labelledby="record-groups-title">
      <div className="panel-heading"><div><h2 id="record-groups-title">解析记录分组</h2></div><span className="panel-meta">{groups.length} 个分组</span></div>
      {groups.length === 0 ? <div className="panel-empty">{groupError ? '当前服务商不支持分组。' : '该域名暂无分组。'}</div>
        : <div className="table-wrap"><table className="data-table">
          <thead><tr><th>分组编号</th><th>分组名称</th><th>记录数量</th></tr></thead>
          <tbody>{groups.map((group) => <tr key={group.id}>
            <td className="mono">{group.id}</td>
            <td>{group.name}</td>
            <td>{group.count ?? '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <section className="panel" aria-labelledby="record-group-move-title">
      <div className="panel-heading"><div><h2 id="record-group-move-title">移动记录到分组</h2></div><span className="panel-meta">已选 {selected.length} 条</span></div>
      <form className="dns-form" onSubmit={submit}>
        <label className="form-field"><span>目标分组</span>
          <select value={groupId} onChange={(event) => setGroupId(event.target.value)} disabled={groups.length === 0}>
            {domain?.accountType === 'dnspod' && <option value="">全部记录（未分组）</option>}
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}{group.count === null ? '' : `（${group.count}）`}</option>)}
          </select>
        </label>
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy || selected.length === 0 || groups.length === 0}>
            {busy ? '正在移动…' : `移动到${grouped ? `「${grouped.name}」` : '所选分组'}`}
          </button>
          <button className="button button-quiet" type="button" disabled={busy} onClick={() => setSelected([])}>清空选择</button>
        </div>
      </form>
    </section>
    <section className="panel" aria-labelledby="record-group-list-title">
      <div className="panel-heading"><div><h2 id="record-group-list-title">解析记录</h2></div><span className="panel-meta">共 {total} 条</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取解析记录…</div>
        : records.length === 0 ? <div className="panel-empty">该域名暂无解析记录。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr>
              <th><input type="checkbox" aria-label="全选"
                checked={records.length > 0 && records.every((record) => selected.includes(record.id))}
                onChange={(event) => setSelected(event.target.checked ? records.map((record) => record.id) : [])} /></th>
              <th>主机</th><th>类型</th><th>记录值</th><th>线路</th><th>状态</th>
            </tr></thead>
            <tbody>{records.map((record) => <tr key={record.id}>
              <td><input type="checkbox" checked={selected.includes(record.id)} aria-label={`选择 ${record.name}`} onChange={() => toggle(record.id)} /></td>
              <td className="mono">{record.name}</td>
              <td>{typeLabel(record.type)}</td>
              <td className="record-value">{record.value}</td>
              <td>{record.line}</td>
              <td>{record.status === 1 ? '启用' : '停用'}</td>
            </tr>)}</tbody>
          </table></div>}
      <div className="pagination">
        <button className="button button-secondary" disabled={page <= 1 || loading} onClick={() => { setPage((current) => Math.max(1, current - 1)); setSelected([]); }}>上一页</button>
        <span className="mono">第 {page} 页</span>
        <button className="button button-secondary" disabled={page * PAGE_SIZE >= total || loading} onClick={() => { setPage((current) => current + 1); setSelected([]); }}>下一页</button>
      </div>
    </section>
  </>;
}
