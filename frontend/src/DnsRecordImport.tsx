import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { InfoTip } from './InfoTip';
import { parseDnsImportRows, type ParsedDnsImportRecord } from './record-import';

interface DomainInfo { id: number; name: string; accountName: string; accountType: string }
interface DnsLine { id: string; name: string; parent: string | null }
interface LineSettings { code: 0; lines: DnsLine[] | null; minTtl: number | null }
interface BatchResult { index: number; ok: boolean; uncertain?: boolean; error?: string }
interface BatchResponse { code: 0; added: number; failed: number; results?: BatchResult[] }
interface ImportRow extends ParsedDnsImportRecord {
  state: 'invalid' | 'ready' | 'adding' | 'added' | 'failed' | 'unknown' | 'not-sent';
  result: string;
}
interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}
interface SheetJs {
  read(data: Uint8Array, options: { type: 'array'; sheetRows: number; sheets: number[] }): {
    SheetNames: string[];
    Sheets: { [name: string]: { '!ref'?: string; '!fullref'?: string } };
  };
  utils: {
    decode_range(ref: string): { e: { c: number; r: number } };
    sheet_to_json(sheet: { '!ref'?: string; '!fullref'?: string }, options: { defval: string; raw: false }): unknown[];
  };
}
interface WindowWithSheetJs extends Window { XLSX?: SheetJs }

const XLSX_URL = new URL('../../public/static/js/xlsx.full.min.js', import.meta.url).href;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 100;
const MAX_SHEET_ROWS = 1001;
const MAX_SHEET_COLUMNS = 64;
const API_BATCH_SIZE = 3;
let sheetJsPromise: Promise<SheetJs> | null = null;

function loadSheetJs(): Promise<SheetJs> {
  const existing = (window as WindowWithSheetJs).XLSX;
  if (existing) return Promise.resolve(existing);
  if (sheetJsPromise) return sheetJsPromise;
  sheetJsPromise = new Promise<SheetJs>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = XLSX_URL;
    script.async = true;
    script.onload = () => {
      const library = (window as WindowWithSheetJs).XLSX;
      if (library) resolve(library);
      else reject(new Error('Excel 解析组件未能初始化'));
    };
    script.onerror = () => reject(new Error('Excel 解析组件加载失败，请刷新页面后重试'));
    document.head.append(script);
  }).catch((failure: unknown) => {
    sheetJsPromise = null;
    throw failure;
  });
  return sheetJsPromise;
}

export function DnsRecordImport({ session, domainId, navigate, onExpired }: Props) {
  const [domain, setDomain] = useState<DomainInfo | null>(null);
  const [lines, setLines] = useState<DnsLine[] | null>(null);
  const [minTtl, setMinTtl] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const validRows = useMemo(() => rows.filter((row) => row.errors.length === 0), [rows]);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      request<{ code: 0; domain: DomainInfo }>(`/api/v1/dns/domains/${domainId}`, { signal: controller.signal }),
      request<LineSettings>(`/api/v1/dns/domains/${domainId}/lines`, { signal: controller.signal }),
    ]).then(([domainResult, lineResult]) => {
      if (controller.signal.aborted) return;
      setDomain(domainResult.domain);
      setLines(lineResult.lines);
      setMinTtl(lineResult.minTtl);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) handle(failure);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [domainId, handle]);

  async function selectFile(file: File | undefined) {
    setRows([]);
    setFileName('');
    setAttempted(false);
    setError('');
    setNotice('');
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) { setError('请选择 .xlsx 或 .xls 文件'); return; }
    if (file.size > MAX_FILE_BYTES) { setError('文件不能超过 5 MiB'); return; }
    setParsing(true);
    try {
      const xlsx = await loadSheetJs();
      const workbook = xlsx.read(new Uint8Array(await file.arrayBuffer()), {
        type: 'array', sheetRows: MAX_SHEET_ROWS, sheets: [0],
      });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) throw new Error('Excel 中没有工作表');
      const sheet = workbook.Sheets[firstSheetName];
      if (!sheet?.['!ref']) throw new Error('首个工作表为空');
      const range = xlsx.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
      if (range.e.r + 1 > MAX_SHEET_ROWS || range.e.c + 1 > MAX_SHEET_COLUMNS) {
        throw new Error('工作表范围过大（最多 1001 行、64 列）');
      }
      const sourceRows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
      const parsed = parseDnsImportRows(sourceRows, lines, minTtl);
      if (parsed.length === 0) throw new Error('首个工作表中没有可导入的记录');
      if (parsed.length > MAX_IMPORT_RECORDS) throw new Error('最多导入 100 条记录，请拆分工作簿后重试');
      setRows(parsed.map((record) => ({
        ...record,
        state: record.errors.length > 0 ? 'invalid' : 'ready',
        result: record.errors.length > 0 ? record.errors.join('；') : '待添加',
      })));
      setFileName(file.name);
    } catch (failure) {
      setError(`读取 Excel 失败：${errorMessage(failure)}`);
    } finally {
      setParsing(false);
    }
  }

  async function confirmImport() {
    if (importing || attempted || validRows.length === 0) return;
    const accepted = window.confirm(`将向 ${domain?.name ?? '当前域名'} 的 DNS 服务商写入 ${validRows.length} 条解析记录。此操作不会自动回滚，确认继续？`);
    if (!accepted) return;
    setAttempted(true);
    setImporting(true);
    setError('');
    setNotice('');
    const validIndexes = rows.flatMap((row, index) => row.errors.length === 0 ? [index] : []);
    let added = 0;
    let failed = 0;
    let unknown = 0;
    let stopped = false;
    for (let start = 0; start < validIndexes.length; start += API_BATCH_SIZE) {
      const indexes = validIndexes.slice(start, start + API_BATCH_SIZE);
      const batch = indexes.map((index) => {
        const row = rows[index]!;
        return {
          name: row.name, type: row.type, value: row.value, line: row.line,
          ttl: row.ttl, mx: row.mx, weight: row.weight, remark: row.remark,
        };
      });
      setRows((current) => current.map((row, index) => indexes.includes(index)
        ? { ...row, state: 'adding', result: '正在添加…' }
        : row));
      try {
        const response = await send<BatchResponse>(
          `/api/v1/dns/domains/${domainId}/records/batch-add`, 'POST', { records: batch },
          new AbortController().signal, { 'X-CSRF-Token': session.csrfToken },
        );
        const outcomes = new Map((response.results ?? []).map((result) => [result.index, result]));
        const updates = new Map<number, Partial<ImportRow>>();
        let batchHasUnknown = false;
        indexes.forEach((rowIndex, batchIndex) => {
          const outcome = outcomes.get(batchIndex);
          if (!outcome) {
            unknown++;
            batchHasUnknown = true;
            updates.set(rowIndex, { state: 'unknown', result: '服务未返回此行结果；请先核对服务商记录' });
          } else if (outcome.ok) {
            added++;
            updates.set(rowIndex, { state: 'added', result: '添加成功' });
          } else if (outcome.uncertain) {
            unknown++;
            batchHasUnknown = true;
            updates.set(rowIndex, { state: 'unknown', result: `${outcome.error || '服务商请求失败'}；结果未确认，请核对服务商记录` });
          } else {
            failed++;
            updates.set(rowIndex, { state: 'failed', result: outcome.error || '添加失败' });
          }
        });
        setRows((current) => current.map((row, index) => ({ ...row, ...updates.get(index) })));
        if (batchHasUnknown) {
          const remaining = validIndexes.slice(start + indexes.length);
          setRows((current) => current.map((row, index) => remaining.includes(index)
            ? { ...row, state: 'not-sent', result: '前一批状态未确认，本次未发送' }
            : row));
          stopped = true;
          break;
        }
      } catch (failure) {
        handle(failure);
        const message = errorMessage(failure);
        const rejectedBeforeWrite = failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
        if (rejectedBeforeWrite) {
          failed += indexes.length;
          setRows((current) => current.map((row, index) => indexes.includes(index)
            ? { ...row, state: 'failed', result: `请求被拒绝，未写入：${message}` }
            : row));
        } else {
          unknown += indexes.length;
          setRows((current) => current.map((row, index) => indexes.includes(index)
            ? { ...row, state: 'unknown', result: '请求未确认完成；请先核对服务商记录，未自动重试' }
            : row));
        }
        const remaining = validIndexes.slice(start + indexes.length);
        setRows((current) => current.map((row, index) => remaining.includes(index)
          ? { ...row, state: 'not-sent', result: '前一批请求已停止，本次未发送' }
          : row));
        stopped = true;
        break;
      }
    }
    const stopAdvice = stopped
      ? unknown > 0 ? '请先在服务商侧核对状态未知的记录，避免重复添加。' : '后续批次未发送，请修复请求问题后重新导入。'
      : '';
    setNotice(`导入${stopped ? '已停止' : '完成'}：成功 ${added} 条，失败 ${failed} 条，状态未知 ${unknown} 条，校验未通过 ${rows.length - validRows.length} 条。${stopAdvice}`);
    setImporting(false);
  }

  const busy = loading || parsing || importing;
  const stateLabel: { [state in ImportRow['state']]: string } = {
    invalid: '未提交', ready: '待添加', adding: '添加中', added: '成功',
    failed: '失败', unknown: '状态未知', 'not-sent': '未发送',
  };

  return <>
    <div className="page-tools">
      <a className="button button-secondary" href={`/record/${domainId}`} onClick={(event) => { event.preventDefault(); navigate(`/record/${domainId}`); }}>返回解析记录</a>
      {domain && <span className="mono">{domain.name} · {domain.accountName}（{domain.accountType}）</span>}
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="record-import-title">
      <div className="panel-heading"><div><h2 id="record-import-title">表格导入解析记录</h2><InfoTip label="导入说明" text="支持主机记录、记录类型、线路类型、记录值、TTL、权重和备注；未匹配线路使用默认线路。最多 5 MiB、100 条记录。上游响应不确定时会停止后续批次，需先核对记录，不会自动重试。" /></div><span className="panel-meta">单域名 · 逐行结果</span></div>
      <div className="dns-form">
        <label className="form-field"><span>Excel 文件（.xlsx / .xls）</span>
          <input type="file" accept=".xlsx,.xls" disabled={busy || attempted} onChange={(event) => void selectFile(event.currentTarget.files?.[0])} />
        </label>
        {parsing && <div className="panel-loading" role="status"><span className="spinner" />正在读取工作簿…</div>}
        {fileName && !parsing && <div className="form-actions"><span>{fileName} · 共 {rows.length} 条，校验通过 {validRows.length} 条，未通过 {rows.length - validRows.length} 条</span>
          <button className="button button-primary" type="button" disabled={busy || attempted || validRows.length === 0} onClick={() => void confirmImport()}>
            {importing ? '正在写入…' : attempted ? '本次导入已提交' : `确认添加 ${validRows.length} 条`}
          </button>
        </div>}
      </div>
    </section>
    {rows.length > 0 && <section className="panel" aria-labelledby="record-import-preview-title">
      <div className="panel-heading"><div><h2 id="record-import-preview-title">导入预览与结果</h2></div><span className="panel-meta">首个工作表</span></div>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>序号</th><th>主机记录</th><th>类型</th><th>线路</th><th>记录值</th><th>TTL</th><th>权重</th><th>状态 / 结果</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${index}-${row.name}`}>
          <td>{index + 1}</td><td className="mono">{row.name || '—'}</td><td>{row.type || '—'}</td>
          <td>{row.lineFallback || row.lineDescription !== row.lineName ? `${row.lineDescription} → ${row.lineName}` : row.lineName}</td>
          <td className="record-value">{row.value || '—'}</td><td>{Number.isFinite(row.ttl) ? row.ttl : '—'}</td><td>{row.weight}</td>
          <td><strong>{stateLabel[row.state]}</strong><div>{row.result}</div></td>
        </tr>)}</tbody>
      </table></div>
    </section>}
  </>;
}
