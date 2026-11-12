import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { RECORD_TYPES, typeLabel, type DnsLine, type DomainSummary } from './record-utils';

interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

interface RowResult { index: number; ok: boolean; error?: string }

export function RecordBatchAdd({ session, domainId, navigate, onExpired }: Props) {
  const [domain, setDomain] = useState<DomainSummary | null>(null);
  const [lines, setLines] = useState<DnsLine[]>([]);
  const [minTtl, setMinTtl] = useState<number | null>(null);
  const [form, setForm] = useState({ type: '', line: 'default', ttl: '600', mx: '', remark: '' });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState<RowResult[] | null>(null);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      request<{ code: 0; domain: DomainSummary }>(`/api/v1/dns/domains/${domainId}`, { signal: controller.signal }),
      request<{ code: 0; lines: DnsLine[] | null; minTtl: number | null }>(`/api/v1/dns/domains/${domainId}/lines`, { signal: controller.signal }),
    ]).then(([info, lineInfo]) => {
      if (controller.signal.aborted) return;
      setDomain(info.domain);
      setLines(lineInfo.lines ?? []);
      setMinTtl(lineInfo.minTtl);
      if (lineInfo.lines?.[0]) setForm((current) => ({ ...current, line: lineInfo.lines![0]!.id }));
    }).catch((failure) => { if (!controller.signal.aborted) handle(failure); });
    return () => controller.abort();
  }, [domainId, handle]);

  function update(key: 'type' | 'line' | 'ttl' | 'mx' | 'remark', value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed: { name: string; value: string; error?: string }[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) parsed.push({ name: line, value: '', error: '每行需包含「主机记录 记录值」' });
      else parsed.push({ name: parts[0]!, value: parts.slice(1).join(' ') });
    }
    if (parsed.length === 0) { setError('请填写至少一行解析记录'); return; }
    setBusy(true);
    setError('');
    setNotice('');
    setResults(null);
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; added: number; failed: number; errors: string[]; results: RowResult[] }>(
        `/api/v1/dns/domains/${domainId}/records/batch-add`, 'POST',
        {
          records: parsed.map((row) => ({
            name: row.name,
            value: row.value,
            ...(form.type ? { type: form.type } : {}),
            line: form.line,
            ttl: Number(form.ttl),
            mx: form.mx === '' ? null : Number(form.mx),
            remark: form.remark.trim() || null,
          })),
        },
        controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setResults(result.results);
      setNotice(`批量添加完成：成功 ${result.added} 条${result.failed ? `，失败 ${result.failed} 条（${result.errors.join('；')}）` : ''}`);
      if (result.added > 0) setText('');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-tools">
      <button className="button button-secondary" type="button" onClick={() => navigate(`/record/${domainId}`)}>返回解析记录</button>
      <button className="button button-secondary" type="button" onClick={() => navigate('/record/batchadd')}>切换域名</button>
      {domain && <span className="mono">{domain.name} · {domain.accountName}（{domain.accountType}）</span>}
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="batch-add-title">
      <div className="panel-heading"><div><h2 id="batch-add-title">批量添加解析</h2></div><span className="panel-meta">每行「主机记录 记录值」，最多 100 行</span></div>
      <form className="dns-form" onSubmit={submit}>
        <label className="form-field"><span>默认类型（留空自动判断）</span>
          <select value={form.type} onChange={(event) => update('type', event.target.value)}>
            <option value="">自动判断</option>
            {RECORD_TYPES.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
          </select>
        </label>
        <label className="form-field"><span>线路</span>
          <select value={form.line} onChange={(event) => update('line', event.target.value)}>
            {lines.length === 0 ? <option value="default">默认</option>
              : lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
          </select>
        </label>
        <label className="form-field"><span>TTL</span>
          <input type="number" min={minTtl ?? 1} max={86400} value={form.ttl} onChange={(event) => update('ttl', event.target.value)} required />
        </label>
        <label className="form-field"><span>MX 优先级</span>
          <input type="number" min={0} max={65535} value={form.mx} onChange={(event) => update('mx', event.target.value)} placeholder="仅 MX" />
        </label>
        <label className="form-field"><span>备注</span>
          <input value={form.remark} onChange={(event) => update('remark', event.target.value)} maxLength={100} placeholder="可选" />
        </label>
        <label className="form-field" style={{ gridColumn: '1 / -1' }}><span>记录行</span>
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={8} maxLength={20000}
            placeholder={'www 1.1.1.1\n@ 2001:db8::1\nmail mail.example.com'} required />
        </label>
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在提交…' : '批量添加'}</button>
        </div>
      </form>
      {minTtl !== null && <div className="panel-footnote">当前服务商最小 TTL：{minTtl}</div>}
    </section>
    {results && <section className="panel" aria-labelledby="batch-add-result-title">
      <div className="panel-heading"><div><h2 id="batch-add-result-title">逐行结果</h2></div><span className="panel-meta">共 {results.length} 行</span></div>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>行号</th><th>结果</th><th>说明</th></tr></thead>
        <tbody>{results.map((row) => <tr key={row.index}>
          <td className="mono">{row.index + 1}</td>
          <td>{row.ok ? '成功' : '失败'}</td>
          <td>{row.error ?? '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </>;
}
