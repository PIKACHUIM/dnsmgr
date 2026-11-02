import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';

interface Task {
  id: number; domainId: number; domainName: string; recordId: string | null; recordName: string;
  recordType: string; switchType: number; mode: string; runDate: string | null; weekday: number | null;
  monthDay: number | null; runTime: string; value: string | null; active: boolean;
  nextRunAt: number; lastRunAt: number | null; lastError: string | null;
}
interface Domain { id: number; name: string }
interface Props { session: Session; onExpired: (message: string) => void }

const SWITCHES = [{ value: '1', label: '启用解析' }, { value: '2', label: '暂停解析' }, { value: '3', label: '删除解析记录' }, { value: '0', label: '修改记录值' }];
const MODES = [{ value: 'once', label: '一次性' }, { value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }, { value: 'monthly', label: '每月' }];

function timeOf(seconds: number): string {
  return seconds > 0 ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
}

export function ScheduleTasks({ session, onExpired }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [form, setForm] = useState({
    domainId: '', recordName: '', recordType: 'A', recordId: '', switchType: '2',
    mode: 'daily', runDate: '', weekday: '1', monthDay: '1', runTime: '03:00', value: '', remark: '',
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const [taskList, domainList] = await Promise.all([
        request<{ code: 0; items: Task[] }>('/api/v1/schedule/tasks', { signal }),
        request<{ code: 0; items: Domain[] }>('/api/v1/dns/domains?page=1&pageSize=100', { signal }),
      ]);
      if (signal.aborted) return;
      setTasks(taskList.items);
      setDomains(domainList.items);
      setForm((current) => ({ ...current, domainId: current.domainId || String(domainList.items[0]?.id ?? '') }));
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/schedule/tasks', 'POST', {
        domainId: Number(form.domainId), recordName: form.recordName, recordType: form.recordType,
        recordId: form.recordId || undefined, switchType: Number(form.switchType), mode: form.mode,
        runDate: form.runDate || undefined, weekday: form.mode === 'weekly' ? Number(form.weekday) : undefined,
        monthDay: form.mode === 'monthly' ? Number(form.monthDay) : undefined,
        runTime: form.runTime, value: form.value || undefined, remark: form.remark || undefined,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('定时任务已创建');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function toggle(task: Task) {
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/schedule/tasks/${task.id}`, 'PATCH', { active: !task.active }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(task: Task) {
    if (busy || !window.confirm(`确认删除 ${task.domainName} 的定时任务？`)) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/schedule/tasks/${task.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function runNow() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; ran: number; failed: number }>('/api/v1/schedule/run', 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`执行完成：成功 ${result.ran}，失败 ${result.failed}`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <div className="page-tools"><button className="button button-secondary" type="button" disabled={busy} onClick={() => void runNow()}>立即执行到期任务</button><span className="mono">执行器需由外部每分钟调用 /cron</span></div>
    <section className="panel" aria-labelledby="schedule-form-title">
      <div className="panel-heading"><div><h2 id="schedule-form-title">新建定时切换</h2></div><span className="panel-meta">按本地时区计算</span></div>
      <form className="dns-form" onSubmit={create}>
        <label className="form-field"><span>域名</span><select value={form.domainId} onChange={(event) => setForm({ ...form, domainId: event.target.value })} required>
          {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
        </select></label>
        <label className="form-field"><span>主机记录</span><input value={form.recordName} onChange={(event) => setForm({ ...form, recordName: event.target.value })} required placeholder="www" /></label>
        <label className="form-field"><span>类型</span><input value={form.recordType} onChange={(event) => setForm({ ...form, recordType: event.target.value })} required /></label>
        <label className="form-field"><span>记录编号</span><input value={form.recordId} onChange={(event) => setForm({ ...form, recordId: event.target.value })} placeholder="启用/暂停/删除时必填" /></label>
        <label className="form-field"><span>操作</span><select value={form.switchType} onChange={(event) => setForm({ ...form, switchType: event.target.value })}>
          {SWITCHES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select></label>
        <label className="form-field"><span>新值</span><input value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} placeholder="修改记录值时必填" /></label>
        <label className="form-field"><span>周期</span><select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value })}>
          {MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select></label>
        {form.mode === 'once' && <label className="form-field"><span>日期</span><input type="date" value={form.runDate} onChange={(event) => setForm({ ...form, runDate: event.target.value })} required /></label>}
        {form.mode === 'weekly' && <label className="form-field"><span>星期</span><select value={form.weekday} onChange={(event) => setForm({ ...form, weekday: event.target.value })}>{['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, index) => <option key={label} value={index}>{label}</option>)}</select></label>}
        {form.mode === 'monthly' && <label className="form-field"><span>日期</span><input type="number" min={1} max={31} value={form.monthDay} onChange={(event) => setForm({ ...form, monthDay: event.target.value })} /></label>}
        <label className="form-field"><span>时间</span><input type="time" value={form.runTime} onChange={(event) => setForm({ ...form, runTime: event.target.value })} required /></label>
        <label className="form-field"><span>备注</span><input value={form.remark} onChange={(event) => setForm({ ...form, remark: event.target.value })} maxLength={100} /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !form.domainId}>创建任务</button></div>
      </form>
    </section>
    <section className="panel" aria-labelledby="schedule-list-title">
      <div className="panel-heading"><div><h2 id="schedule-list-title">定时任务</h2></div><span className="panel-meta">共 {tasks.length} 个</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取任务…</div>
        : tasks.length === 0 ? <div className="panel-empty">还没有定时任务。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>域名</th><th>记录</th><th>操作</th><th>周期</th><th>下次执行</th><th>状态</th><th>错误</th><th>操作</th></tr></thead>
            <tbody>{tasks.map((task) => <tr key={task.id}>
              <td>{task.domainName}</td>
              <td className="mono">{task.recordName} <span className="value-detail">{task.recordType}</span></td>
              <td>{SWITCHES.find((item) => Number(item.value) === task.switchType)?.label ?? task.switchType}</td>
              <td>{MODES.find((item) => item.value === task.mode)?.label ?? task.mode} {task.runTime}</td>
              <td className="mono">{timeOf(task.nextRunAt)}</td>
              <td>{task.active ? '启用' : '停用'}</td>
              <td>{task.lastError || '—'}</td>
              <td className="row-actions">
                <button className="button button-secondary" disabled={busy} onClick={() => void toggle(task)}>{task.active ? '停用' : '启用'}</button>
                <button className="button button-quiet" disabled={busy} onClick={() => void remove(task)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
  </>;
}
