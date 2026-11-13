import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { Modal } from './Modal';
import { DnsCategories } from './DnsCategories';
import { usePreferences } from './preferences';

interface ProviderField { key: string; label: string; required: boolean; secret?: boolean }
interface Provider {
  type: string; name: string; supported: boolean; fields: ProviderField[];
  capabilities: { status: boolean; remark: boolean; weight: boolean; lines: boolean; addDomain: boolean };
}
interface Account { id: number; type: string; name: string; remark: string | null; domainCount: number }

interface Props { session: Session; onExpired: (message: string) => void }

export function DnsAccounts({ session, onExpired }: Props) {
  const { t } = usePreferences();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [unported, setUnported] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [type, setType] = useState('');
  const [name, setName] = useState('');
  const [remark, setRemark] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired(t('会话已失效，请重新登录。'));
    else setError(errorMessage(failure));
  }, [onExpired, t]);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const [catalog, list] = await Promise.all([
        request<{ code: 0; providers: Provider[]; unported: string[] }>('/api/v1/dns/providers', { signal }),
        request<{ code: 0; items: Account[] }>('/api/v1/dns/accounts', { signal }),
      ]);
      if (signal.aborted) return;
      setProviders(catalog.providers);
      setUnported(catalog.unported);
      setAccounts(list.items);
      setType((current) => current || catalog.providers.find((provider) => provider.supported)?.type || '');
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const selected = providers.find((provider) => provider.type === type);

  function openForm() {
    setName('');
    setRemark('');
    setConfig({});
    setType(providers.find((provider) => provider.supported)?.type ?? '');
    setError('');
    setNotice('');
    setFormOpen(true);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    controller.current = new AbortController();
    try {
      await send('/api/v1/dns/accounts', 'POST', { type, name, remark, config }, controller.current.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(t('账户「{name}」已添加', { name }));
      setName('');
      setRemark('');
      setConfig({});
      setFormOpen(false);
      await load(controller.current.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function sync(account: Account) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    try {
      const remote = await request<{ code: 0; items: { id: string; name: string; recordCount: number }[] }>(
        `/api/v1/dns/accounts/${account.id}/remote-domains?page=1&pageSize=50`, { signal: signal.signal },
      );
      const result = await send<{ code: 0; imported: number; skipped: number }>(
        `/api/v1/dns/accounts/${account.id}/sync`, 'POST',
        { domains: remote.items.map((item) => ({ id: item.id, name: item.name, recordCount: item.recordCount })) },
        signal.signal, { 'X-CSRF-Token': session.csrfToken },
      );
      setNotice(t('已同步 {name}：新增 {imported} 个域名，跳过 {skipped} 个', { name: account.name, imported: result.imported, skipped: result.skipped }));
      await load(signal.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function remove(account: Account) {
    if (busy || !window.confirm(t('确认删除账户「{name}」？', { name: account.name }))) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    try {
      await send(`/api/v1/dns/accounts/${account.id}`, 'DELETE', undefined, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(t('账户「{name}」已删除', { name: account.name }));
      await load(signal.signal);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="account-list-title">
      <div className="panel-heading"><div><h2 id="account-list-title">{t('已配置账户')}</h2></div><div className="panel-heading-actions"><span className="panel-meta">{accounts.length} {t('个')}</span><button className="button button-primary" type="button" onClick={openForm}><Icon name="plus" />{t('添加账户')}</button></div></div>
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />{t('正在读取账户…')}</div>
        : accounts.length === 0 ? <div className="panel-empty">{t('还没有 DNS 账户。添加后即可同步域名。')}</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('名称')}</th><th>{t('服务商')}</th><th>{t('域名')}</th><th>{t('备注')}</th><th>{t('操作')}</th></tr></thead>
            <tbody>{accounts.map((account) => <tr key={account.id}>
              <td>{account.name}</td>
              <td className="mono">{account.type}</td>
              <td>{account.domainCount}</td>
              <td>{account.remark ?? '—'}</td>
              <td className="row-actions">{account.type === 'cloudflare' && <a className="button button-secondary" href={`/cloudflare/tunnels/${account.id}`}>Tunnels</a>}<button className="button button-secondary" disabled={busy} onClick={() => void sync(account)}>{t('同步域名')}</button><button className="button button-quiet" disabled={busy} onClick={() => void remove(account)}>{t('删除')}</button></td>
            </tr>)}</tbody>
          </table></div>}
      {unported.length > 0 && <div className="panel-footnote">{t('尚未移植的驱动：{list}', { list: unported.join('、') })}</div>}
    </section>
    <DnsCategories session={session} onExpired={onExpired} />
    {formOpen && <Modal title={t('添加 DNS 账户')} description={t('凭据加密保存')} onClose={() => setFormOpen(false)}>
      <form className="dns-form" onSubmit={submit}>
        <label className="form-field"><span>{t('账户名称')}</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} required placeholder={t('例如 主账号')} autoComplete="off" /></label>
        <label className="form-field"><span>{t('服务商')}</span>
          <select value={type} onChange={(event) => { setType(event.target.value); setConfig({}); }} required>
            {providers.map((provider) => <option key={provider.type} value={provider.type} disabled={!provider.supported}>{provider.name}{provider.supported ? '' : `（${t('未移植')}）`}</option>)}
          </select>
        </label>
        {selected?.fields.map((field) => <label className="form-field" key={field.key}>
          <span>{t(field.label)}{field.required || field.label.includes('（') ? '' : `（${t('可选')}）`}</span>
          <input
            type={field.secret ? 'password' : 'text'} value={config[field.key] ?? ''} required={field.required}
            autoComplete="off" onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value }))}
          />
        </label>)}
        <label className="form-field"><span>{t('备注（可选）')}</span><input value={remark} maxLength={100} onChange={(event) => setRemark(event.target.value)} /></label>
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || !type}>{busy ? t('正在验证…') : t('验证并保存')}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>{t('取消')}</button></div>
      </form>
    </Modal>}
  </>;
}
