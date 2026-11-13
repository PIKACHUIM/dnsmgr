import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Modal } from './Modal';
import { InfoTip } from './InfoTip';

interface Task {
  id: number; domainId: number; domainName: string; recordId: string; recordName: string; recordType: string;
  mainValue: string; backupValue: string; intervalSeconds: number; timeoutSeconds: number;
  failureThreshold: number; consecutiveCount: number; currentBackup: boolean; active: boolean;
  nextCheckAt: number; lastCheckAt: number | null; lastHttpStatus: number | null;
  lastLatencyMs: number | null; lastError: string | null;
}
interface Domain { id: number; name: string }
interface RecordItem { id: string; name: string; type: string; value: string; status: number }
interface Log { id: number; event: string; probe_ok: number | null; http_status: number | null; latency_ms: number | null; message: string | null; created_at: number }
interface Props { session: Session; onExpired: (message: string) => void; navigate: (path: string) => void; overview?: boolean }

const EVENT_LABELS: Record<string, string> = {
  healthy: '探测正常', unhealthy: '探测失败', switch_backup: '切换至备用',
  recover_main: '恢复主线路', dns_update_failed: 'DNS 更新失败', runtime_error: '运行错误',
};

function timeOf(seconds: number | null): string {
  return seconds && seconds > 0 ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
}

export function DnsFailover({ session, onExpired, navigate, overview = false }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [form, setForm] = useState({
    domainId: '', recordId: '', recordType: 'A', recordName: '', mainValue: '', backupValue: '',
    checkUrl: '', intervalSeconds: '60', timeoutSeconds: '5', failureThreshold: '3',
  });
  const [logsTask, setLogsTask] = useState<number | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [cleanDays, setCleanDays] = useState('30');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selectedDomainId = useRef('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const loadRecords = useCallback(async (domainId: string, signal?: AbortSignal) => {
    if (!domainId) { setRecords([]); return; }
    const result = await request<{ code: 0; items: RecordItem[] }>(`/api/v1/dns/domains/${domainId}/records?page=1&pageSize=100`, { signal });
    if (!signal?.aborted) setRecords(result.items.filter((record) => ['A', 'AAAA', 'CNAME'].includes(record.type) && record.status === 1));
  }, []);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const [taskList, domainList] = await Promise.all([
        request<{ code: 0; items: Task[] }>('/api/v1/failover/tasks?page=1&pageSize=100', { signal }),
        request<{ code: 0; items: Domain[] }>('/api/v1/dns/domains?page=1&pageSize=100', { signal }),
      ]);
      if (signal.aborted) return;
      setTasks(taskList.items);
      setDomains(domainList.items);
      const domainId = selectedDomainId.current || String(domainList.items[0]?.id ?? '');
      selectedDomainId.current = domainId;
      setForm((current) => ({ ...current, domainId }));
      await loadRecords(domainId, signal);
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle, loadRecords]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function refresh() {
    const controller = new AbortController();
    await load(controller.signal);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; id: number }>('/api/v1/failover/tasks', 'POST', {
        domainId: Number(form.domainId), recordId: form.recordId, recordType: form.recordType, recordName: form.recordName,
        mainValue: form.mainValue, backupValue: form.backupValue, checkUrl: form.checkUrl,
        intervalSeconds: Number(form.intervalSeconds), timeoutSeconds: Number(form.timeoutSeconds),
        failureThreshold: Number(form.failureThreshold),
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`容灾策略 #${result.id} 已创建，首次探测将在下一次 /cron 运行时执行。`);
      setForm((current) => ({ ...current, recordId: '', recordName: '', mainValue: '', backupValue: '', checkUrl: '' }));
      setFormOpen(false);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function toggle(task: Task) {
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/failover/tasks/${task.id}`, 'PATCH', { active: !task.active }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(task: Task) {
    if (busy || !window.confirm(`确认删除 ${task.domainName} ${task.recordName} 的容灾策略？`)) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/failover/tasks/${task.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      if (logsTask === task.id) { setLogsTask(null); setLogs([]); }
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function clean(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; deleted: number; msg: string }>('/api/v1/failover/logs/clean', 'POST', { days: Number(cleanDays) }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(result.msg);
      setCleanOpen(false);
      if (logsTask !== null) {
        const refreshed = await request<{ code: 0; items: Log[] }>(`/api/v1/failover/tasks/${logsTask}/logs?page=1&pageSize=50`, { signal: controller.signal });
        setLogs(refreshed.items);
      }
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function checkNow(task: Task) {
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; checked: number; switched: number; failed: number }>(
        `/api/v1/failover/tasks/${task.id}/run`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(`检查完成：已执行 ${result.checked} 次，发生切换 ${result.switched} 次，失败 ${result.failed} 次。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function showLogs(task: Task) {
    setError('');
    const controller = new AbortController();
    try {
      const result = await request<{ code: 0; items: Log[] }>(`/api/v1/failover/tasks/${task.id}/logs?page=1&pageSize=50`, { signal: controller.signal });
      setLogsTask(task.id);
      setLogs(result.items);
    } catch (failure) { handle(failure); }
  }

  const activeCount = tasks.filter((task) => task.active).length;
  const backupCount = tasks.filter((task) => task.currentBackup).length;
  const errorCount = tasks.filter((task) => Boolean(task.lastError)).length;

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {overview && <div className="metric-grid">
      <section className="panel metric-panel"><div className="metric-row"><h2>启用策略</h2><strong className="metric-value">{activeCount}</strong></div></section>
      <section className="panel metric-panel"><div className="metric-row"><h2>当前备用线路</h2><strong className="metric-value">{backupCount}</strong></div></section>
      <section className="panel metric-panel"><div className="metric-row"><h2>最近有错误</h2><strong className="metric-value">{errorCount}</strong></div></section>
    </div>}
    {overview && <div className="page-tools">
      <button className="button button-secondary" type="button" disabled={busy || loading} onClick={() => void refresh()}>刷新</button>
      <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setError(''); setNotice(''); setCleanOpen(true); }}>清理日志</button>
      <button className="button button-primary" type="button" onClick={() => navigate('/dmonitor/task')}>管理切换策略</button>
    </div>}
    <section className="panel" aria-labelledby="failover-list-title">
      <div className="panel-heading"><div><h2 id="failover-list-title">{overview ? '容灾策略状态' : '切换策略'}</h2></div>{overview
        ? <span className="panel-meta">共 {tasks.length} 条</span>
        : <div className="panel-heading-actions"><span className="panel-meta">共 {tasks.length} 条</span><button className="button button-secondary" type="button" disabled={busy || loading} onClick={() => void refresh()}>刷新</button><button className="button button-primary" type="button" disabled={loading} onClick={() => { setError(''); setNotice(''); setFormOpen(true); }}>新建策略</button></div>}</div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取策略…</div>
        : tasks.length === 0 ? <div className="panel-empty">还没有容灾策略。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>域名 / 记录</th><th>主备值</th><th>状态</th><th>间隔 / 阈值</th><th>上次探测</th><th>错误</th><th>操作</th></tr></thead>
            <tbody>{tasks.map((task) => <tr key={task.id}>
              <td>{task.domainName}<span className="value-detail mono">{task.recordName} · {task.recordType}</span></td>
              <td className="mono">主：{task.mainValue}<span className="value-detail">备：{task.backupValue}</span></td>
              <td>{!task.active ? '停用' : task.currentBackup ? '备用中' : '主线路'}<span className="value-detail">连续计数 {task.consecutiveCount}/{task.failureThreshold}</span></td>
              <td>{task.intervalSeconds}s / {task.failureThreshold} 次</td>
              <td>{timeOf(task.lastCheckAt)}<span className="value-detail">HTTP {task.lastHttpStatus ?? '—'} · {task.lastLatencyMs ?? '—'} ms</span></td>
              <td>{task.lastError || '—'}</td>
              <td className="row-actions">
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => void checkNow(task)}>立即检查</button>
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void showLogs(task)}>日志</button>
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void toggle(task)}>{task.active ? '停用' : '启用'}</button>
                <button className="button button-quiet" type="button" disabled={busy} onClick={() => void remove(task)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    {logsTask !== null && <section className="panel" aria-labelledby="failover-log-title">
      <div className="panel-heading"><h2 id="failover-log-title">策略 #{logsTask} 运行日志</h2><button className="button button-quiet" type="button" onClick={() => setLogsTask(null)}>关闭</button></div>
      {logs.length === 0 ? <div className="panel-empty">暂无运行日志。</div> : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>时间</th><th>事件</th><th>HTTP</th><th>耗时</th><th>详情</th></tr></thead>
        <tbody>{logs.map((log) => <tr key={log.id}><td>{timeOf(log.created_at)}</td><td>{EVENT_LABELS[log.event] ?? log.event}</td><td>{log.http_status ?? '—'}</td><td>{log.latency_ms ?? '—'} ms</td><td>{log.message ?? '—'}</td></tr>)}</tbody>
      </table></div>}
    </section>}
    {formOpen && <Modal title="新建 HTTP 容灾策略" wide onClose={() => { if (!busy) setFormOpen(false); }}>
      <form className="dns-form" onSubmit={create}>
        <label className="form-field"><span>域名</span><select required value={form.domainId} onChange={(event) => {
          const domainId = event.target.value;
          selectedDomainId.current = domainId;
          setForm((current) => ({ ...current, domainId, recordId: '', recordName: '', mainValue: '' }));
          void loadRecords(domainId).catch(handle);
        }}>
          <option value="">选择域名</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
        </select></label>
        <div className="form-field"><div className="form-label"><label htmlFor="failover-record">解析记录</label><InfoTip label="记录范围" text="仅支持启用状态的 A、AAAA、CNAME 记录。" /></div><select id="failover-record" required value={form.recordId} onChange={(event) => {
          const record = records.find((item) => item.id === event.target.value);
          setForm((current) => ({ ...current, recordId: record?.id ?? '', recordType: record?.type ?? 'A', recordName: record?.name ?? '', mainValue: record?.value ?? '' }));
        }}>
          <option value="">选择记录</option>{records.map((record) => <option key={record.id} value={record.id}>{record.name} · {record.type} · {record.value}</option>)}
        </select></div>
        <label className="form-field"><span>主线路值</span><input required value={form.mainValue} onChange={(event) => setForm({ ...form, mainValue: event.target.value })} maxLength={253} /></label>
        <label className="form-field"><span>备用线路值</span><input required value={form.backupValue} onChange={(event) => setForm({ ...form, backupValue: event.target.value })} maxLength={253} placeholder={form.recordType === 'A' ? '例如 8.8.8.8' : '输入备用地址或目标'} /></label>
        <label className="form-field"><span>健康检查 URL</span><input required type="url" value={form.checkUrl} onChange={(event) => setForm({ ...form, checkUrl: event.target.value })} maxLength={512} placeholder="https://origin.example.com/health" /></label>
        <label className="form-field"><span>检测间隔（秒）</span><input required type="number" min={30} max={86400} value={form.intervalSeconds} onChange={(event) => setForm({ ...form, intervalSeconds: event.target.value })} /></label>
        <label className="form-field"><span>超时（秒）</span><input required type="number" min={1} max={30} value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: event.target.value })} /></label>
        <label className="form-field"><span>连续失败/恢复阈值</span><input required type="number" min={1} max={10} value={form.failureThreshold} onChange={(event) => setForm({ ...form, failureThreshold: event.target.value })} /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !form.domainId || !form.recordId}>{busy ? '正在提交…' : '创建策略'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>取消</button></div>
      </form>
    </Modal>}
    {cleanOpen && <Modal title="清理容灾日志" onClose={() => { if (!busy) setCleanOpen(false); }}>
      <form className="dns-form" onSubmit={clean}>
        <label className="form-field"><span>保留天数</span><input type="number" min={0} max={3650} value={cleanDays} onChange={(event) => setCleanDays(event.target.value)} required /></label>
        <p className="panel-footnote">早于保留天数的运行日志会被删除；填 0 表示清空全部历史日志。策略本身不会被删除。</p>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在清理…' : '开始清理'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setCleanOpen(false)}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
