import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface DomainInfo { id: number; name: string; accountName: string; accountType: string }
interface DnsLine { id: string; name: string; parent: string | null }
interface Record {
  id: string; name: string; type: string; value: string; line: string;
  ttl: number; mx: number | null; weight: number | null; remark: string | null; status: 0 | 1;
}
interface FormState {
  name: string; type: string; value: string; line: string; ttl: string; mx: string; remark: string;
}

const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR', 'URL'];
const PAGE_SIZE = 20;
const EMPTY: FormState = { name: '', type: 'A', value: '', line: 'default', ttl: '600', mx: '', remark: '' };

interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

export function DnsRecords({ session, domainId, navigate, onExpired }: Props) {
  const [domain, setDomain] = useState<DomainInfo | null>(null);
  const [records, setRecords] = useState<Record[]>([]);
  const [lines, setLines] = useState<DnsLine[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal, currentPage: number) => {
    setLoading(true);
    setError('');
    try {
      const [info, list, lineInfo] = await Promise.all([
        request<{ code: 0; domain: DomainInfo }>(`/api/v1/dns/domains/${domainId}`, { signal }),
        request<{ code: 0; total: number; items: Record[] }>(`/api/v1/dns/domains/${domainId}/records?page=${currentPage}&pageSize=${PAGE_SIZE}`, { signal }),
        request<{ code: 0; lines: DnsLine[] | null; minTtl: number | null }>(`/api/v1/dns/domains/${domainId}/lines`, { signal }),
      ]);
      if (signal.aborted) return;
      setDomain(info.domain);
      setRecords(list.items);
      setTotal(list.total);
      setLines(lineInfo.lines);
      setForm((current) => current.line === 'default' && lineInfo.lines?.[0]
        ? { ...current, line: lineInfo.lines[0].id }
        : current);
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [domainId, handle]);

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal, page);
    return () => abort.abort();
  }, [load, page]);

  function update(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    controller.current = new AbortController();
    const body = {
      name: form.name.trim(), type: form.type, value: form.value.trim(), line: form.line,
      ttl: Number(form.ttl), mx: form.mx === '' ? null : Number(form.mx), remark: form.remark.trim(),
    };
    try {
      if (editing) {
        await send(`/api/v1/dns/domains/${domainId}/records/${editing}`, 'PUT', body, controller.current.signal, { 'X-CSRF-Token': session.csrfToken });
        setNotice('解析记录已更新');
      } else {
        await send(`/api/v1/dns/domains/${domainId}/records`, 'POST', body, controller.current.signal, { 'X-CSRF-Token': session.csrfToken });
        setNotice('解析记录已添加');
      }
      setForm({ ...EMPTY, line: form.line });
      setEditing(null);
      await load(controller.current.signal, page);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function act(record: Record, action: 'delete' | 'toggle') {
    if (busy) return;
    if (action === 'delete' && !window.confirm(`确认删除 ${record.name} 的 ${record.type} 记录？`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    try {
      if (action === 'delete') {
        await send(`/api/v1/dns/domains/${domainId}/records/${record.id}`, 'DELETE', undefined, signal.signal, { 'X-CSRF-Token': session.csrfToken });
        setNotice('解析记录已删除');
      } else {
        await send(`/api/v1/dns/domains/${domainId}/records/${record.id}/status`, 'POST', { enabled: record.status !== 1 }, signal.signal, { 'X-CSRF-Token': session.csrfToken });
        setNotice(record.status === 1 ? '解析记录已停用' : '解析记录已启用');
      }
      await load(signal.signal, page);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  function edit(record: Record) {
    setEditing(record.id);
    setForm({
      name: record.name, type: record.type, value: record.value, line: record.line,
      ttl: String(record.ttl), mx: record.mx === null ? '' : String(record.mx), remark: record.remark ?? '',
    });
    setNotice('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return <>
    <div className="page-tools">
      <a className="button button-secondary" href="/domain" onClick={(event) => { event.preventDefault(); navigate('/domain'); }}>返回域名列表</a>
      {domain && <span className="mono">{domain.name} · {domain.accountName}（{domain.accountType}）</span>}
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="record-form-title">
      <div className="panel-heading"><div><h2 id="record-form-title">{editing ? '修改解析记录' : '添加解析记录'}</h2></div><span className="panel-meta">实时写入服务商</span></div>
      <form className="dns-form" onSubmit={submit}>
        <label className="form-field"><span>主机记录</span><input value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="@ 或 www" required maxLength={128} /></label>
        <label className="form-field"><span>类型</span><select value={form.type} onChange={(event) => update('type', event.target.value)}>{TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <label className="form-field"><span>记录值</span><input value={form.value} onChange={(event) => update('value', event.target.value)} required maxLength={2048} placeholder="IP、目标域名或文本" /></label>
        <label className="form-field"><span>线路</span><select value={form.line} onChange={(event) => update('line', event.target.value)}>
          {lines === null
            ? <option value="default">默认</option>
            : lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
        </select></label>
        <label className="form-field"><span>TTL</span><input type="number" min={1} max={86400} value={form.ttl} onChange={(event) => update('ttl', event.target.value)} required /></label>
        <label className="form-field"><span>MX 优先级</span><input type="number" min={0} max={65535} value={form.mx} onChange={(event) => update('mx', event.target.value)} placeholder="仅 MX" /></label>
        <label className="form-field"><span>备注</span><input value={form.remark} onChange={(event) => update('remark', event.target.value)} maxLength={100} /></label>
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在提交…' : editing ? '保存修改' : '添加记录'}</button>
          {editing && <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setEditing(null); setForm({ ...EMPTY, line: form.line }); }}>取消编辑</button>}
        </div>
      </form>
    </section>
    <section className="panel" aria-labelledby="record-list-title">
      <div className="panel-heading"><div><h2 id="record-list-title">解析记录</h2></div><span className="panel-meta">共 {total} 条</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取解析记录…</div>
        : records.length === 0 ? <div className="panel-empty">该域名暂无解析记录。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>主机</th><th>类型</th><th>记录值</th><th>线路</th><th>TTL</th><th>状态</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>{records.map((record) => <tr key={record.id}>
              <td className="mono">{record.name}</td>
              <td>{record.type}</td>
              <td className="record-value">{record.value}</td>
              <td>{lines?.find((line) => line.id === record.line)?.name ?? record.line}</td>
              <td>{record.ttl}</td>
              <td>{record.status === 1 ? '启用' : '停用'}</td>
              <td>{record.remark ?? '—'}</td>
              <td className="row-actions">
                <button className="button button-secondary" disabled={busy} onClick={() => edit(record)}>编辑</button>
                <button className="button button-secondary" disabled={busy} onClick={() => void act(record, 'toggle')}>{record.status === 1 ? '停用' : '启用'}</button>
                <button className="button button-quiet" disabled={busy} onClick={() => void act(record, 'delete')}>删除</button>
              </td>
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
