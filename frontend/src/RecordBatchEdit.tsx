import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { RECORD_TYPES, recordInfo, typeLabel, type DnsLine, type DomainSummary, type RecordRow } from './record-utils';

interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

const PAGE_SIZE = 50;

export function RecordBatchEdit({ session, domainId, navigate, onExpired }: Props) {
  const [domain, setDomain] = useState<DomainSummary | null>(null);
  const [lines, setLines] = useState<DnsLine[]>([]);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<'value' | 'line'>('value');
  const [type, setType] = useState('A');
  const [value, setValue] = useState('');
  const [line, setLine] = useState('default');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      request<{ code: 0; domain: DomainSummary }>(`/api/v1/dns/domains/${domainId}`, { signal: controller.signal }),
      request<{ code: 0; lines: DnsLine[] | null }>(`/api/v1/dns/domains/${domainId}/lines`, { signal: controller.signal }),
      request<{ code: 0; total: number; items: RecordRow[] }>(
        `/api/v1/dns/domains/${domainId}/records?page=${page}&pageSize=${PAGE_SIZE}`, { signal: controller.signal },
      ),
    ]).then(([info, lineInfo, list]) => {
      if (controller.signal.aborted) return;
      setDomain(info.domain);
      setLines(lineInfo.lines ?? []);
      setRecords(list.items);
      setTotal(list.total);
      if (lineInfo.lines?.[0]) setLine((current) => current === 'default' ? lineInfo.lines![0]!.id : current);
    }).catch((failure) => { if (!controller.signal.aborted) handle(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [domainId, handle, page]);

  function toggle(recordId: string) {
    setSelected((current) => current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (selected.length === 0) { setError('请先选择要修改的解析记录'); return; }
    if (action === 'value' && !value.trim()) { setError('记录值不能为空'); return; }
    const chosen = records.filter((record) => selected.includes(record.id));
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; success: number; failed: number; errors: string[] }>(
        `/api/v1/dns/domains/${domainId}/records/batch-edit`, 'POST',
        {
          action,
          ...(action === 'value' ? { type, value: value.trim() } : { line }),
          recordinfo: chosen.map(recordInfo),
        },
        controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(`批量修改完成：成功 ${result.success} 条${result.failed ? `，失败 ${result.failed} 条（${result.errors.join('；')}）` : ''}`);
      setSelected([]);
      setValue('');
      const refreshed = await request<{ code: 0; total: number; items: RecordRow[] }>(
        `/api/v1/dns/domains/${domainId}/records?page=${page}&pageSize=${PAGE_SIZE}`, { signal: controller.signal },
      );
      setRecords(refreshed.items);
      setTotal(refreshed.total);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-tools">
      <button className="button button-secondary" type="button" onClick={() => navigate(`/record/${domainId}`)}>返回解析记录</button>
      <button className="button button-secondary" type="button" onClick={() => navigate('/record/batchedit')}>切换域名</button>
      {domain && <span className="mono">{domain.name} · {domain.accountName}（{domain.accountType}）</span>}
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="batch-edit-title">
      <div className="panel-heading"><div><h2 id="batch-edit-title">批量修改解析</h2></div><span className="panel-meta">已选 {selected.length} 条</span></div>
      <form className="dns-form" onSubmit={submit}>
        <label className="form-field"><span>修改内容</span>
          <select value={action} onChange={(event) => setAction(event.target.value === 'line' ? 'line' : 'value')}>
            <option value="value">记录类型与记录值</option>
            <option value="line">解析线路</option>
          </select>
        </label>
        {action === 'value' ? <>
          <label className="form-field"><span>新类型</span>
            <select value={type} onChange={(event) => setType(event.target.value)}>
              {RECORD_TYPES.map((item) => <option key={item} value={item}>{typeLabel(item)}</option>)}
            </select>
          </label>
          <label className="form-field"><span>新记录值</span>
            <input value={value} onChange={(event) => setValue(event.target.value)} maxLength={2048} required placeholder="IP、目标域名或文本" />
          </label>
        </> : <label className="form-field"><span>新线路</span>
          <select value={line} onChange={(event) => setLine(event.target.value)}>
            {lines.length === 0 ? <option value="default">默认</option>
              : lines.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy || selected.length === 0}>{busy ? '正在提交…' : '应用修改'}</button>
          <button className="button button-quiet" type="button" disabled={busy} onClick={() => setSelected([])}>清空选择</button>
        </div>
      </form>
    </section>
    <section className="panel" aria-labelledby="batch-edit-list-title">
      <div className="panel-heading"><div><h2 id="batch-edit-list-title">解析记录</h2></div><span className="panel-meta">共 {total} 条</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取解析记录…</div>
        : records.length === 0 ? <div className="panel-empty">该域名暂无解析记录。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr>
              <th><input type="checkbox" aria-label="全选"
                checked={records.length > 0 && records.every((record) => selected.includes(record.id))}
                onChange={(event) => setSelected(event.target.checked ? records.map((record) => record.id) : [])} /></th>
              <th>主机</th><th>类型</th><th>记录值</th><th>线路</th><th>TTL</th><th>状态</th>
            </tr></thead>
            <tbody>{records.map((record) => <tr key={record.id}>
              <td><input type="checkbox" checked={selected.includes(record.id)} aria-label={`选择 ${record.name}`} onChange={() => toggle(record.id)} /></td>
              <td className="mono">{record.name}</td>
              <td>{typeLabel(record.type)}</td>
              <td className="record-value">{record.value}</td>
              <td>{lines.find((item) => item.id === record.line)?.name ?? record.line}</td>
              <td>{record.ttl}</td>
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
