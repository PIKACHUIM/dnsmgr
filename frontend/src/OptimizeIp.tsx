import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { InfoTip } from './InfoTip';
import { Modal } from './Modal';

interface OptimizeConfig { api: '0' | '1' | '2'; minMinutes: number; keyConfigured: boolean }
interface DnsZone { id: number; name: string; thirdId: string | null }
interface DnsLine { id: string; name: string }
interface OptimizeTask {
  id: number; domainId: number; domainName: string; rr: string; recordType: 'A' | 'AAAA';
  ipGroup: 'DEF' | 'CT' | 'CU' | 'CM'; cdnType: number; recordCount: number; ttl: number; line: string;
  enabled: boolean; remark: string | null; lastRunAt: number | null; lastStatus: string | null; lastError: string | null;
}
interface Props { session: Session; onExpired: (message: string) => void }

const apiNames: Record<string, string> = { '0': 'wetest.vip（需密钥）', '1': 'hostmonit.com', '2': 'xingpingcn.top（免费）' };
const cdnNames: Record<number, string> = { 1: 'Cloudflare', 2: 'CloudFront', 3: 'Gcore', 4: 'EdgeOne' };

function date(value: number | null): string {
  return value === null ? '—' : new Date(value * 1000).toLocaleString();
}

export function OptimizeIpSettings({ session, onExpired }: Props) {
  const [api, setApi] = useState<'0' | '1' | '2'>('2');
  const [key, setKey] = useState('');
  const [minMinutes, setMinMinutes] = useState('60');
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  useEffect(() => {
    const controller = new AbortController();
    request<{ code: 0 } & OptimizeConfig>('/api/v1/optimize/settings', { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setApi(result.api); setMinMinutes(String(result.minMinutes)); setKeyConfigured(result.keyConfigured);
      })
      .catch((failure) => { if (!controller.signal.aborted) handle(failure); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [handle]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0 } & OptimizeConfig>('/api/v1/optimize/settings', 'PUT', {
        api, minMinutes: Number(minMinutes), key: key.trim() || undefined,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setKey(''); setKeyConfigured(result.keyConfigured); setApi(result.api); setMinMinutes(String(result.minMinutes));
      setNotice('优选设置已保存');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="optimize-settings-title">
      <div className="panel-heading"><div><h2 id="optimize-settings-title">优选设置</h2><InfoTip label="优选设置说明" text="cron 每次只执行一个到期任务，两次执行至少间隔设定分钟数。写入操作单次最多 5 个，超出部分会在下一次继续。" /></div><span className="panel-meta">IP 数据源与执行间隔</span></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取设置…</div>
        : <form className="dns-form" onSubmit={save}>
          <label className="form-field"><span>IP 数据源</span><select value={api} onChange={(event) => setApi(event.target.value as '0' | '1' | '2')}>
            {(Object.keys(apiNames) as ('0' | '1' | '2')[]).map((value) => <option key={value} value={value}>{apiNames[value]}</option>)}
          </select></label>
          <label className="form-field"><span>接口密钥</span><input type="password" value={key} onChange={(event) => setKey(event.target.value)} maxLength={200} autoComplete="new-password" placeholder={keyConfigured ? '已配置，留空保留' : api === '2' ? '当前数据源无需密钥' : '填写接口密钥'} /></label>
          <label className="form-field"><span>执行间隔（分钟）</span><input type="number" inputMode="numeric" min={10} max={1440} value={minMinutes} onChange={(event) => setMinMinutes(event.target.value)} required /></label>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button></div>
        </form>}
    </section>
  </>;
}

export function OptimizeIpTasks({ session, onExpired }: Props) {
  const [tasks, setTasks] = useState<OptimizeTask[]>([]);
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [lines, setLines] = useState<DnsLine[]>([]);
  const [domainId, setDomainId] = useState('');
  const [rr, setRr] = useState('');
  const [recordType, setRecordType] = useState<'A' | 'AAAA'>('A');
  const [ipGroup, setIpGroup] = useState<'DEF' | 'CT' | 'CU' | 'CM'>('CT');
  const [cdnType, setCdnType] = useState('1');
  const [recordCount, setRecordCount] = useState('2');
  const [ttl, setTtl] = useState('600');
  const [line, setLine] = useState('0');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired('会话已失效，请重新登录。');
    else setError(errorMessage(failure));
  }, [onExpired]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const [taskResult, zoneResult] = await Promise.all([
        request<{ code: 0; items: OptimizeTask[] }>('/api/v1/optimize/tasks', { signal }),
        request<{ code: 0; items: DnsZone[] }>('/api/v1/dns/domains?page=1&pageSize=100', { signal }),
      ]);
      if (signal.aborted) return;
      setTasks(taskResult.items);
      setZones(zoneResult.items.filter((zone) => zone.thirdId));
      setDomainId((current) => current || String(zoneResult.items.find((zone) => zone.thirdId)?.id ?? ''));
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!domainId) return;
    const controller = new AbortController();
    request<{ code: 0; lines: DnsLine[] }>(`/api/v1/optimize/lines?domainId=${domainId}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setLines(result.lines);
        if (result.lines[0] && !result.lines.some((entry) => entry.id === line)) setLine(result.lines[0].id);
      })
      .catch((failure) => { if (!controller.signal.aborted) handle(failure); });
    return () => controller.abort();
  }, [domainId, handle, line]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send('/api/v1/optimize/tasks', 'POST', {
        domainId, rr: rr.trim(), recordType, ipGroup, cdnType: Number(cdnType),
        recordCount: Number(recordCount), ttl: Number(ttl), line,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setRr('');
      setFormOpen(false);
      setNotice('优选任务已创建；由 cron 按间隔自动执行，也可立即运行一次。');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function patch(task: OptimizeTask, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/optimize/tasks/${task.id}`, 'PATCH', body, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function run(task: OptimizeTask) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; ok: boolean; detail: string }>(`/api/v1/optimize/tasks/${task.id}/run`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`优选任务 ${task.id}：${result.detail}`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(task: OptimizeTask) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/optimize/tasks/${task.id}`, 'DELETE', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`优选任务 ${task.id} 已删除。`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="optimize-list-title">
      <div className="panel-heading"><div><h2 id="optimize-list-title">任务管理</h2><InfoTip label="优选任务说明" text="任务把远端接口返回的 IP 写入指定域名的主机记录，只修改同域名、同主机记录、同线路与同类型的记录，不会触碰其他解析。" /></div><div className="panel-heading-actions"><span className="panel-meta">共 {tasks.length} 条</span><button className="button button-primary" type="button" disabled={loading || zones.length === 0} onClick={() => { setError(''); setNotice(''); setFormOpen(true); }}><Icon name="plus" />新建任务</button></div></div>
      {tasks.length === 0 ? <div className="panel-empty">还没有优选任务。</div>
        : <div className="table-wrap"><table className="data-table certificate-table">
          <thead><tr><th>域名</th><th>记录</th><th>分组 / 线路</th><th>数量</th><th>最近运行</th><th>操作</th></tr></thead>
          <tbody>{tasks.map((task) => <tr key={task.id}>
            <td><strong className="mono">{task.rr}.{task.domainName}</strong><span className="value-detail">{task.remark ?? `任务 #${task.id}`}</span></td>
            <td>{task.recordType}<span className="value-detail">TTL {task.ttl}</span></td>
            <td>{task.ipGroup} · {cdnNames[task.cdnType] ?? task.cdnType}<span className="value-detail">DNS 线路 {task.line}</span></td>
            <td>{task.recordCount}</td>
            <td><span>{task.lastStatus ?? '未运行'}</span><span className="value-detail">{date(task.lastRunAt)}</span>{task.lastError && <span className="value-detail certificate-order-error">{task.lastError}</span>}</td>
            <td className="certificate-order-actions">
              <label className="certificate-confirm"><input type="checkbox" checked={task.enabled} disabled={busy} onChange={(event) => void patch(task, { enabled: event.target.checked })} />启用</label>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => void run(task)}>立即运行</button>
              <button className="button button-quiet" type="button" disabled={busy} onClick={() => void remove(task)}>删除</button>
            </td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    {formOpen && <Modal title="新建优选任务" wide onClose={() => { if (!busy) setFormOpen(false); }}>
      <form className="dns-form certificate-setup-form" onSubmit={create}>
        <label className="form-field"><span>域名</span><select value={domainId} onChange={(event) => setDomainId(event.target.value)} required>
          {zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
        </select></label>
        <label className="form-field"><span>主机记录</span><input value={rr} onChange={(event) => setRr(event.target.value)} required maxLength={63} placeholder="cf" /></label>
        <label className="form-field"><span>记录类型</span><select value={recordType} onChange={(event) => setRecordType(event.target.value as 'A' | 'AAAA')}>
          <option value="A">A（IPv4）</option><option value="AAAA">AAAA（IPv6）</option>
        </select></label>
        <label className="form-field"><span>线路分组</span><select value={ipGroup} onChange={(event) => setIpGroup(event.target.value as 'DEF' | 'CT' | 'CU' | 'CM')}>
          <option value="DEF">默认</option><option value="CT">电信 CT</option><option value="CU">联通 CU</option><option value="CM">移动 CM</option>
        </select></label>
        <label className="form-field"><span>数据源线路</span><select value={cdnType} onChange={(event) => setCdnType(event.target.value)}>
          {(Object.keys(cdnNames) as string[]).map((value) => <option key={value} value={value}>{cdnNames[Number(value)]}</option>)}
        </select></label>
        <label className="form-field"><span>DNS 线路</span><select value={line} onChange={(event) => setLine(event.target.value)}>
          {lines.length === 0 ? <option value="0">默认</option> : lines.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select></label>
        <label className="form-field"><span>记录数量</span><input type="number" inputMode="numeric" min={1} max={50} value={recordCount} onChange={(event) => setRecordCount(event.target.value)} required /></label>
        <label className="form-field"><span>TTL（秒）</span><input type="number" inputMode="numeric" min={1} max={86400} value={ttl} onChange={(event) => setTtl(event.target.value)} required /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !rr.trim() || !domainId}>{busy ? '正在保存…' : '创建优选任务'}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
