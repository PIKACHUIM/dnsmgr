import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { RECORD_TYPES, guessRecordType, loadDomains, typeLabel, type DnsLine, type DomainSummary } from './record-utils';

interface Props {
  session: Session;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

interface ParsedRow {
  host: string;
  value: string;
  type: string;
  domainId: number;
  domainName: string;
  line: string;
  ttl: number;
  status: 'pending' | 'ok' | 'fail';
  message?: string;
}

interface RowResult { index: number; ok: boolean; error?: string }

export function SmartParse({ session, navigate, onExpired }: Props) {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [defaultDomainId, setDefaultDomainId] = useState('');
  const [defaultType, setDefaultType] = useState('');
  const [defaultLine, setDefaultLine] = useState('default');
  const [defaultTtl, setDefaultTtl] = useState('600');
  const [batchValue, setBatchValue] = useState('');
  const [lines, setLines] = useState<DnsLine[]>([]);
  const [inputText, setInputText] = useState('');
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [summary, setSummary] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    loadDomains(controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setDomains(items);
      if (items[0]) setDefaultDomainId(String(items[0].id));
    }).catch((failure) => { if (!controller.signal.aborted) handle(failure); });
    return () => controller.abort();
  }, [handle]);

  useEffect(() => {
    if (!defaultDomainId) { setLines([]); return; }
    const controller = new AbortController();
    request<{ code: 0; lines: DnsLine[] | null }>(`/api/v1/dns/domains/${defaultDomainId}/lines`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLines(result.lines ?? []);
        setDefaultLine(result.lines?.[0]?.id ?? 'default');
      })
      .catch((failure) => { if (!controller.signal.aborted) handle(failure); });
    return () => controller.abort();
  }, [defaultDomainId, handle]);

  function preview(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setSummary('');
    const text = inputText.trim();
    if (!text) { setError('请输入批量解析数据'); return; }
    if (domains.length === 0) { setError('当前账号没有可用域名'); return; }

    const sorted = [...domains].sort((first, second) => second.name.length - first.name.length);
    const byName = new Map(domains.map((domain) => [domain.name.toLowerCase(), domain]));
    const fallback = defaultDomainId ? domains.find((domain) => String(domain.id) === defaultDomainId) : undefined;
    const parsed: ParsedRow[] = [];
    const errors: string[] = [];

    for (const [index, raw] of text.split('\n').entries()) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      let host = '';
      let value = '';
      let domainName: string | null = null;

      if (parts.length === 1 && batchValue.trim()) {
        const full = parts[0]!;
        const match = sorted.find((domain) => full === domain.name || full.endsWith(`.${domain.name}`));
        if (!match) { errors.push(`第${index + 1}行：域名 "${full}" 不在你的域名列表中`); continue; }
        host = full === match.name ? '@' : full.slice(0, full.length - match.name.length - 1);
        domainName = match.name;
        value = batchValue.trim();
      } else if (parts.length < 2) {
        errors.push(`第${index + 1}行格式错误：至少需要主机记录和记录值`);
        continue;
      } else if (parts.length === 2) {
        const candidate = parts[1]!;
        const match = sorted.find((domain) => candidate === domain.name || candidate.endsWith(`.${domain.name}`));
        if (match) {
          host = candidate === match.name ? '@' : candidate.slice(0, candidate.length - match.name.length - 1);
          value = parts[0]!;
          domainName = match.name;
        } else {
          host = parts[0]!;
          value = parts[1]!;
        }
      } else {
        host = parts[0]!;
        value = parts[1]!;
        domainName = parts[2] ?? null;
      }

      let domain: DomainSummary | undefined;
      if (domainName) {
        domain = byName.get(domainName.toLowerCase());
        if (!domain) { errors.push(`第${index + 1}行：域名 "${domainName}" 不在你的域名列表中`); continue; }
      } else if (fallback) {
        domain = fallback;
      } else {
        errors.push(`第${index + 1}行：未指定域名且没有设置默认域名`);
        continue;
      }

      const type = defaultType || guessRecordType(value);
      const ttl = Number(defaultTtl);
      if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) { errors.push(`第${index + 1}行：TTL 必须在 1–86400 之间`); continue; }
      parsed.push({
        host, value, type, domainId: domain.id, domainName: domain.name,
        line: defaultLine, ttl, status: 'pending',
      });
    }

    setParseErrors(errors);
    if (errors.length > 0) { setRows([]); return; }
    if (parsed.length === 0) { setError('没有有效的解析记录'); return; }
    if (parsed.length > 200) { setError('一次最多解析 200 条记录'); return; }
    setRows(parsed);
    setSummary(`已解析 ${parsed.length} 条记录，涉及 ${new Set(parsed.map((row) => row.domainId)).size} 个域名`);
  }

  async function submit() {
    if (busy || rows.length === 0) return;
    setBusy(true);
    setError('');
    setNotice('');
    const grouped = new Map<number, { rows: number[]; domain: string }>();
    rows.forEach((row, index) => {
      const entry = grouped.get(row.domainId) ?? { rows: [], domain: row.domainName };
      entry.rows.push(index);
      grouped.set(row.domainId, entry);
    });
    let success = 0;
    let failed = 0;
    const updated = [...rows];
    const controller = new AbortController();
    try {
      for (const [domainId, group] of grouped) {
        const records = group.rows.map((index) => {
          const row = rows[index]!;
          return { name: row.host, value: row.value, type: row.type, line: row.line, ttl: row.ttl };
        });
        try {
          const result = await send<{ code: 0; added: number; failed: number; errors: string[]; results: RowResult[] }>(
            `/api/v1/dns/domains/${domainId}/records/batch-add`, 'POST', { records },
            controller.signal, { 'X-CSRF-Token': session.csrfToken },
          );
          for (const item of result.results) {
            const rowIndex = group.rows[item.index];
            if (rowIndex === undefined) continue;
            updated[rowIndex] = { ...updated[rowIndex]!, status: item.ok ? 'ok' : 'fail', message: item.error };
            if (item.ok) success++;
            else failed++;
          }
          if (result.results.length === 0) {
            success += result.added;
            failed += result.failed;
          }
        } catch (failure) {
          for (const index of group.rows) {
            updated[index] = { ...updated[index]!, status: 'fail', message: errorMessage(failure) };
          }
          failed += group.rows.length;
        }
        setRows([...updated]);
      }
      setNotice(`批量添加完成：成功 ${success} 条${failed ? `，失败 ${failed} 条` : ''}`);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="page-tools">
      <button className="button button-secondary" type="button" onClick={() => navigate('/record/search')}>按记录值搜索</button>
      <button className="button button-secondary" type="button" onClick={() => navigate('/domain')}>返回域名列表</button>
      <span className="mono">可添加 {domains.length} 个域名</span>
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="smartparse-title">
      <div className="panel-heading"><div><h2 id="smartparse-title">智能批量添加</h2></div><span className="panel-meta">按行解析域名、主机记录与记录值</span></div>
      <form className="dns-form" onSubmit={preview}>
        <label className="form-field"><span>默认域名</span>
          <select value={defaultDomainId} onChange={(event) => setDefaultDomainId(event.target.value)}>
            {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
          </select>
        </label>
        <label className="form-field"><span>默认类型（留空自动判断）</span>
          <select value={defaultType} onChange={(event) => setDefaultType(event.target.value)}>
            <option value="">自动判断</option>
            {RECORD_TYPES.map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}
          </select>
        </label>
        <label className="form-field"><span>默认线路</span>
          <select value={defaultLine} onChange={(event) => setDefaultLine(event.target.value)}>
            {lines.length === 0 ? <option value="default">默认</option>
              : lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
          </select>
        </label>
        <label className="form-field"><span>默认 TTL</span>
          <input type="number" min={1} max={86400} value={defaultTtl} onChange={(event) => setDefaultTtl(event.target.value)} required />
        </label>
        <label className="form-field"><span>统一记录值（可选）</span>
          <input value={batchValue} onChange={(event) => setBatchValue(event.target.value)} maxLength={2048} placeholder="填写后，单列域名行使用该值" />
        </label>
        <label className="form-field" style={{ gridColumn: '1 / -1' }}><span>解析数据</span>
          <textarea value={inputText} onChange={(event) => setInputText(event.target.value)} rows={8} maxLength={30000}
            placeholder={'www 1.1.1.1\nwww.example.com 1.1.1.1\nmail mail.example.com\n@ 2001:db8::1'} required />
        </label>
        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={busy}>解析预览</button>
          <button className="button button-secondary" type="button" disabled={busy || rows.length === 0} onClick={() => void submit()}>{busy ? '正在提交…' : `确认添加 ${rows.length} 条`}</button>
        </div>
      </form>
      {parseErrors.length > 0 && <div className="notice notice-error" role="alert">
        <strong>解析失败</strong><span>{parseErrors.slice(0, 10).join('；')}</span>
      </div>}
      {summary && <p className="form-hint">{summary}</p>}
    </section>
    {rows.length > 0 && <section className="panel" aria-labelledby="smartparse-preview-title">
      <div className="panel-heading"><div><h2 id="smartparse-preview-title">添加预览</h2></div><span className="panel-meta">共 {rows.length} 条</span></div>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>域名</th><th>主机记录</th><th>类型</th><th>记录值</th><th>线路</th><th>TTL</th><th>状态</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${row.domainId}-${index}`}>
          <td className="mono">{row.domainName}</td>
          <td className="mono">{row.host}</td>
          <td>{typeLabel(row.type)}</td>
          <td className="record-value">{row.value}</td>
          <td>{row.line}</td>
          <td>{row.ttl}</td>
          <td>{row.status === 'ok' ? '已添加' : row.status === 'fail' ? `失败：${row.message ?? '未知错误'}` : '待添加'}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </>;
}
