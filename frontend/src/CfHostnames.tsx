import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { Modal } from './Modal';

interface Hostname {
  id: string; hostname: string; customOriginServer: string | null;
  sslMethod: string; minTlsVersion: string; sslStatus: string; sslValidationStatus: string;
  verificationStatus: string; errors: string[];
  ownership: { type: string; name: string; value: string; status: string };
  validationRecords: { status: string; txtName: string | null; txtValue: string | null; cnameTarget: string | null }[];
}
interface Props {
  session: Session;
  domainId: number;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

export function CfHostnames({ session, domainId, navigate, onExpired }: Props) {
  const [items, setItems] = useState<Hostname[]>([]);
  const [fallback, setFallback] = useState('');
  const [uuid, setUuid] = useState('');
  const [hostname, setHostname] = useState('');
  const [origin, setOrigin] = useState('');
  const [sslMethod, setSslMethod] = useState('txt');
  const [minTls, setMinTls] = useState('1.2');
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
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
      const [list, originInfo, dcv] = await Promise.all([
        request<{ code: 0; total: number; items: Hostname[] }>(`/api/v1/cloudflare/domains/${domainId}/hostnames`, { signal }),
        request<{ code: 0; origin: string }>(`/api/v1/cloudflare/domains/${domainId}/fallback-origin`, { signal }),
        request<{ code: 0; uuid: string }>(`/api/v1/cloudflare/domains/${domainId}/dcv-uuid`, { signal }),
      ]);
      if (signal.aborted) return;
      setItems(list.items);
      setFallback(originInfo.origin);
      setUuid(dcv.uuid);
    } catch (failure) { if (!signal.aborted) handle(failure); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [domainId, handle]);

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
      await send(`/api/v1/cloudflare/domains/${domainId}/hostnames`, 'POST', {
        hostname: hostname.trim(), customOriginServer: origin.trim(), sslMethod, minTlsVersion: minTls,
      }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setHostname(''); setOrigin('');
      setFormOpen(false);
      setNotice('自定义主机名已创建');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function saveFallback() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/domains/${domainId}/fallback-origin`, 'PUT', { origin: fallback.trim() }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('Fallback Origin 已保存');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function clearFallback() {
    if (busy || !window.confirm('确认清空 Fallback Origin？')) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/domains/${domainId}/fallback-origin`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setFallback('');
      setNotice('Fallback Origin 已清空');
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function refresh(item: Hostname) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/domains/${domainId}/hostnames/${item.id}/refresh`, 'POST', {}, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(`已重新发起 ${item.hostname} 的验证`);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function edit(item: Hostname) {
    const value = window.prompt(`自定义源站（留空表示清空）\n${item.hostname}`, item.customOriginServer ?? '');
    if (value === null) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/domains/${domainId}/hostnames/${item.id}`, 'PATCH', { customOriginServer: value.trim() }, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('自定义源站已更新');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(item: Hostname) {
    if (busy || !window.confirm(`确认删除自定义主机名「${item.hostname}」？`)) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      await send(`/api/v1/cloudflare/domains/${domainId}/hostnames/${item.id}`, 'DELETE', undefined, controller.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice('自定义主机名已删除');
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function batchDelete() {
    if (busy || selected.length === 0 || !window.confirm(`确认删除选中的 ${selected.length} 个主机名？`)) return;
    setBusy(true); setError(''); setNotice('');
    const controller = new AbortController();
    try {
      const result = await send<{ code: 0; deleted: number; failed: number }>(
        `/api/v1/cloudflare/domains/${domainId}/hostnames/batch-delete`, 'POST', { ids: selected },
        controller.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(`已删除 ${result.deleted} 个${result.failed ? `，失败 ${result.failed} 个` : ''}`);
      setSelected([]);
      await load(controller.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    <div className="page-tools">
      <a className="button button-secondary" href={`/record/${domainId}`} onClick={(event) => { event.preventDefault(); navigate(`/record/${domainId}`); }}>返回解析记录</a>
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="fallback-title">
      <div className="panel-heading"><div><h2 id="fallback-title">Fallback Origin</h2></div><span className="panel-meta">SaaS 回退源站</span></div>
      <div className="dns-form">
        <label className="form-field"><span>源站域名</span><input value={fallback} onChange={(event) => setFallback(event.target.value)} placeholder="fallback.example.com" maxLength={253} /></label>
        <div className="form-actions">
          <button className="button button-primary" type="button" disabled={busy} onClick={() => void saveFallback()}>保存</button>
          <button className="button button-quiet" type="button" disabled={busy} onClick={() => void clearFallback()}>清空</button>
        </div>
      </div>
    </section>
    <section className="panel" aria-labelledby="dcv-title">
      <div className="panel-heading"><div><h2 id="dcv-title">DCV 委派</h2></div><span className="panel-meta">CNAME 目标后缀</span></div>
      <div className="dns-form">
        <label className="form-field"><span>Delegation UUID</span><input readOnly value={uuid || '未开通或权限不足'} className="mono" /></label>
        <dl className="data-list">
          <div><dt>记录名</dt><dd className="mono">_acme-challenge.主机名</dd></div>
          <div><dt>目标</dt><dd className="mono">主机名.{uuid || 'uuid'}.dcv.cloudflare.com</dd></div>
        </dl>
      </div>
    </section>
    <section className="panel" aria-labelledby="hostname-list-title">
      <div className="panel-heading"><div><h2 id="hostname-list-title">自定义主机名</h2></div><div className="panel-heading-actions"><span className="panel-meta">共 {items.length} 个</span><button className="button button-primary" type="button" disabled={loading} onClick={() => { setHostname(''); setOrigin(''); setError(''); setNotice(''); setFormOpen(true); }}><Icon name="plus" />创建主机名</button></div></div>
      {selected.length > 0 && <div className="dns-batch">
        <span className="mono">已选 {selected.length} 项</span>
        <button className="button button-primary" type="button" disabled={busy} onClick={() => void batchDelete()}>批量删除</button>
        <button className="button button-quiet" type="button" onClick={() => setSelected([])}>取消</button>
      </div>}
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />正在读取主机名…</div>
        : items.length === 0 ? <div className="panel-empty">还没有自定义主机名。</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr>
              <th><input type="checkbox" aria-label="全选" checked={items.length > 0 && items.every((item) => selected.includes(item.id))}
                onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])} /></th>
              <th>主机名</th><th>源站</th><th>验证</th><th>证书</th><th>主机名验证</th><th>操作</th>
            </tr></thead>
            <tbody>{items.map((item) => <tr key={item.id}>
              <td><input type="checkbox" checked={selected.includes(item.id)} aria-label={`选择 ${item.hostname}`}
                onChange={() => setSelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /></td>
              <td className="mono">{item.hostname}</td>
              <td>{item.customOriginServer || '—'}</td>
              <td>{item.sslMethod}<span className="value-detail">TLS {item.minTlsVersion}</span></td>
              <td>{item.sslStatus || '—'}{item.sslValidationStatus ? <span className="value-detail">{item.sslValidationStatus}</span> : null}</td>
              <td>{item.ownership.status || item.verificationStatus || '—'}
                {item.ownership.name ? <span className="value-detail mono">{item.ownership.name} = {item.ownership.value}</span> : null}
              </td>
              <td className="row-actions">
                <button className="button button-secondary" disabled={busy} onClick={() => void refresh(item)}>验证</button>
                <button className="button button-secondary" disabled={busy} onClick={() => void edit(item)}>源站</button>
                <button className="button button-quiet" disabled={busy} onClick={() => void remove(item)}>删除</button>
              </td>
            </tr>)}</tbody>
          </table></div>}
    </section>
    {formOpen && <Modal title="创建自定义主机名" onClose={() => { if (!busy) setFormOpen(false); }}>
      <form className="dns-form" onSubmit={create}>
        <label className="form-field"><span>主机名</span><input value={hostname} onChange={(event) => setHostname(event.target.value)} required maxLength={253} placeholder="app.example.com" /></label>
        <label className="form-field"><span>自定义源站</span><input value={origin} onChange={(event) => setOrigin(event.target.value)} maxLength={253} placeholder="可留空" /></label>
        <label className="form-field"><span>验证方式</span><select value={sslMethod} onChange={(event) => setSslMethod(event.target.value)}><option value="txt">TXT</option><option value="http">HTTP</option></select></label>
        <label className="form-field"><span>最低 TLS</span><select value={minTls} onChange={(event) => setMinTls(event.target.value)}>{['1.0', '1.1', '1.2', '1.3'].map((version) => <option key={version} value={version}>{version}</option>)}</select></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>创建</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>取消</button></div>
      </form>
    </Modal>}
  </>;
}
