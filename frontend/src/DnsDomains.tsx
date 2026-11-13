import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, request, send, type Session } from './api';
import { Icon } from './icons';
import { Modal } from './Modal';
import { languageTag, usePreferences, type Preferences } from './preferences';

interface Domain {
  id: number; name: string; accountId: number; accountName: string; accountType: string;
  remark: string | null; recordCount: number; hidden: boolean; notice: boolean;
  categoryId: number | null; categoryName: string | null; expiresAt: number | null; checkStatus: number;
}
interface Account { id: number; name: string; type: string }
interface Category { id: number; name: string; sort: number; domainCount: number }

interface Props {
  session: Session;
  navigate: (path: string) => void;
  onExpired: (message: string) => void;
}

type Translate = Preferences['t'];

const PAGE_SIZE = 20;

function expirationText(domain: Domain, t: Translate, tag: string): string {
  if (domain.expiresAt === null || !Number.isFinite(domain.expiresAt)) {
    if (domain.checkStatus === 3) return t('查询中');
    if (domain.checkStatus === 2) return t('查询失败');
    return domain.checkStatus === 0 ? t('待查询') : t('未记录');
  }
  const date = new Date(domain.expiresAt * 1000);
  const label = date.toLocaleDateString(tag, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const suffix = domain.checkStatus === 0 ? t('（待刷新）') : domain.checkStatus === 3 ? t('（查询中）') : '';
  const head = domain.expiresAt < Date.now() / 1000 ? t('已过期 {date}', { date: label }) : t('到期 {date}', { date: label });
  return `${head}${suffix}`;
}

export function DnsDomains({ session, navigate, onExpired }: Props) {
  const { t, language } = usePreferences();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [hiddenFilter, setHiddenFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [name, setName] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [batchAction, setBatchAction] = useState('category');
  const [batchCategory, setBatchCategory] = useState('');
  const [batchFlag, setBatchFlag] = useState('1');
  const [batchRemark, setBatchRemark] = useState('');
  const [refresh, setRefresh] = useState(0);
  const admin = session.user.level === 2;
  const locale = languageTag(language);

  const handle = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) onExpired(t('会话已失效，请重新登录。'));
    else setError(errorMessage(failure));
  }, [onExpired, t]);

  const load = useCallback(async (signal: AbortSignal, currentPage: number) => {
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(currentPage), pageSize: String(PAGE_SIZE) });
    if (applied) query.set('keyword', applied);
    if (categoryFilter) query.set('categoryId', categoryFilter);
    if (hiddenFilter) query.set('hidden', hiddenFilter);
    try {
      const [list, categoryList, accountList] = await Promise.all([
        request<{ code: 0; total: number; items: Domain[] }>(`/api/v1/dns/domains?${query}`, { signal }),
        request<{ code: 0; items: Category[] }>('/api/v1/dns/categories', { signal }),
        admin ? request<{ code: 0; items: Account[] }>('/api/v1/dns/accounts', { signal }) : Promise.resolve({ code: 0 as const, items: [] as Account[] }),
      ]);
      if (signal.aborted) return;
      setDomains(list.items);
      setTotal(list.total);
      setCategories(categoryList.items);
      setAccounts(accountList.items);
      setAccountId((value) => value || String(accountList.items[0]?.id ?? ''));
      setSelected((current) => current.filter((id) => list.items.some((domain) => domain.id === id)));
    } catch (failure) {
      if (!signal.aborted) handle(failure);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [admin, applied, categoryFilter, hiddenFilter, handle]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, page);
    return () => controller.abort();
  }, [load, page, refresh]);

  function search(event: React.FormEvent) {
    event.preventDefault();
    setPage(1);
    setApplied(keyword.trim());
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    try {
      const result = await send<{ code: 0; name: string }>('/api/v1/dns/domains', 'POST', { accountId: Number(accountId), name }, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(t('域名「{name}」已添加', { name: result.name }));
      setName('');
      setFormOpen(false);
      setRefresh((value) => value + 1);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  async function patch(domain: Domain, body: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    try {
      await send(`/api/v1/dns/domains/${domain.id}`, 'PATCH', body, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setRefresh((value) => value + 1);
      return true;
    } catch (failure) { handle(failure); return false; }
    finally { setBusy(false); }
  }

  async function setCategory(domain: Domain, value: string) {
    if (await patch(domain, { categoryId: value ? Number(value) : 0 })) setNotice(t('分类已更新'));
  }

  async function refreshExpiration(domain: Domain) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    try {
      await send(`/api/v1/dns/domains/${domain.id}/expiration/refresh`, 'POST', undefined, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(t('「{name}」到期时间已更新', { name: domain.name }));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) handle(failure);
      else setNotice(t('「{name}」到期信息刷新失败：{message}', { name: domain.name, message: errorMessage(failure) }));
    } finally {
      setBusy(false);
      setRefresh((value) => value + 1);
    }
  }

  async function toggleHidden(domain: Domain) {
    if (await patch(domain, { hidden: !domain.hidden })) setNotice(domain.hidden ? t('域名已显示') : t('域名已隐藏'));
  }

  async function remove(domain: Domain) {
    if (busy || !window.confirm(t('确认从面板移除「{name}」？平台上的域名不会被删除。', { name: domain.name }))) return;
    setBusy(true);
    setError('');
    const signal = new AbortController();
    try {
      await send(`/api/v1/dns/domains/${domain.id}`, 'DELETE', undefined, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(t('已移除「{name}」', { name: domain.name }));
      setRefresh((value) => value + 1);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  function toggleSelected(domainId: number) {
    setSelected((current) => current.includes(domainId) ? current.filter((id) => id !== domainId) : [...current, domainId]);
  }

  async function applyBatch() {
    if (busy || selected.length === 0) return;
    if (batchAction === 'delete' && !window.confirm(t('确认移除选中的 {count} 个域名？平台上的域名不会被删除。', { count: selected.length }))) return;
    setBusy(true);
    setError('');
    setNotice('');
    const signal = new AbortController();
    const body: Record<string, unknown> = { ids: selected, action: batchAction };
    if (batchAction === 'category') body.categoryId = batchCategory ? Number(batchCategory) : 0;
    if (batchAction === 'hidden' || batchAction === 'notice') body.value = batchFlag === '1';
    if (batchAction === 'remark') body.remark = batchRemark;
    try {
      const result = await send<{ code: 0; affected: number; requested: number }>('/api/v1/dns/domains/batch', 'POST', body, signal.signal, { 'X-CSRF-Token': session.csrfToken });
      setNotice(batchAction === 'expiration-refresh'
        ? t('已将 {affected}/{requested} 个请求项加入到期查询队列；cron 每次最多处理 1 个，正在查询中的项目不会被重置', { affected: result.affected, requested: result.requested })
        : t('已处理 {count} 个域名', { count: result.affected }));
      setSelected([]);
      setRefresh((value) => value + 1);
    } catch (failure) { handle(failure); }
    finally { setBusy(false); }
  }

  const allSelected = domains.length > 0 && domains.every((domain) => selected.includes(domain.id));

  return <>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    <section className="panel" aria-labelledby="domain-list-title">
      <div className="panel-heading"><div><h2 id="domain-list-title">{t('域名列表')}</h2></div><div className="panel-heading-actions"><span className="panel-meta">{t('共 {count} 个', { count: total })}</span>{admin && <button className="button button-primary" type="button" disabled={loading} onClick={() => { setName(''); setError(''); setNotice(''); setFormOpen(true); }}><Icon name="plus" />{t('添加域名')}</button>}</div></div>
      <form className="dns-search" onSubmit={search}>
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t('按域名搜索')} maxLength={64} aria-label={t('按域名搜索')} />
        <select value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); setPage(1); }} aria-label={t('按分类筛选')}>
          <option value="">{t('全部分类')}</option>
          <option value="0">{t('未分类')}</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        {admin && <select value={hiddenFilter} onChange={(event) => { setHiddenFilter(event.target.value); setPage(1); }} aria-label={t('按隐藏状态筛选')}>
          <option value="">{t('全部状态')}</option>
          <option value="0">{t('正常')}</option>
          <option value="1">{t('已隐藏')}</option>
        </select>}
        <button className="button button-secondary" type="submit">{t('搜索')}</button>
      </form>
      {selected.length > 0 && <div className="dns-batch">
        <span className="mono">{t('已选 {count} 项', { count: selected.length })}</span>
        <select value={batchAction} onChange={(event) => setBatchAction(event.target.value)} aria-label={t('批量操作')}>
          <option value="category">{t('设置分类')}</option>
          <option value="hidden">{t('隐藏/显示')}</option>
          <option value="notice">{t('到期提醒')}</option>
          <option value="expiration-refresh">{t('排队刷新到期时间')}</option>
          <option value="remark">{t('设置备注')}</option>
          <option value="delete">{t('移除域名')}</option>
        </select>
        {batchAction === 'category' && <select value={batchCategory} onChange={(event) => setBatchCategory(event.target.value)} aria-label={t('目标分类')}>
          <option value="">{t('未分类')}</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>}
        {(batchAction === 'hidden' || batchAction === 'notice') && <select value={batchFlag} onChange={(event) => setBatchFlag(event.target.value)} aria-label={t('目标状态')}>
          <option value="1">{t('开启')}</option>
          <option value="0">{t('禁用')}</option>
        </select>}
        {batchAction === 'remark' && <input value={batchRemark} onChange={(event) => setBatchRemark(event.target.value)} maxLength={100} placeholder={t('备注')} aria-label={t('批量备注')} />}
        <button className="button button-primary" type="button" disabled={busy} onClick={() => void applyBatch()}>{t('应用')}</button>
        <button className="button button-quiet" type="button" disabled={busy} onClick={() => setSelected([])}>{t('取消')}</button>
      </div>}
      {loading ? <div className="panel-loading" role="status"><span className="spinner" />{t('正在读取域名…')}</div>
        : domains.length === 0 ? <div className="panel-empty">{t('没有匹配的域名。')}</div>
          : <div className="table-wrap"><table className="data-table">
            <thead><tr>
              <th><input type="checkbox" checked={allSelected} aria-label={t('全选')} onChange={() => setSelected(allSelected ? [] : domains.map((domain) => domain.id))} /></th>
              <th>{t('域名')}</th><th>{t('账户')}</th><th>{t('分类')}</th><th>{t('记录数')}</th><th>{t('到期时间')}</th><th>{t('状态')}</th><th>{t('操作')}</th>
            </tr></thead>
            <tbody>{domains.map((domain) => <tr key={domain.id}>
              <td><input type="checkbox" checked={selected.includes(domain.id)} aria-label={t('选择 {name}', { name: domain.name })} onChange={() => toggleSelected(domain.id)} /></td>
              <td><a href={`/record/${domain.id}`} onClick={(event) => { event.preventDefault(); navigate(`/record/${domain.id}`); }}>{domain.name}</a></td>
              <td>{domain.accountName}<span className="value-detail mono">{domain.accountType}</span></td>
              <td>{admin
                ? <select value={domain.categoryId ?? ''} disabled={busy} aria-label={t('{name} 分类', { name: domain.name })}
                  onChange={(event) => void setCategory(domain, event.target.value)}>
                  <option value="">{t('未分类')}</option>
                  {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
                : domain.categoryName || t('未分类')}</td>
              <td>{domain.recordCount}</td>
              <td>{expirationText(domain, t, locale)}</td>
              <td>{domain.hidden ? t('已隐藏') : t('正常')}{domain.notice ? <span className="value-detail">{t('到期提醒')}</span> : null}</td>
              <td className="row-actions">
                <a className="button button-secondary" href={`/record/${domain.id}`} onClick={(event) => { event.preventDefault(); navigate(`/record/${domain.id}`); }}>{t('解析记录')}</a>
                <button className="button button-quiet" disabled={busy} onClick={() => void refreshExpiration(domain)}>{t('刷新到期时间')}</button>
                {admin && <button className="button button-quiet" disabled={busy} onClick={() => void toggleHidden(domain)}>{domain.hidden ? t('显示') : t('隐藏')}</button>}
                {admin && <button className="button button-quiet" disabled={busy} onClick={() => void remove(domain)}>{t('移除')}</button>}
              </td>
            </tr>)}</tbody>
          </table></div>}
      <div className="pagination">
        <button className="button button-secondary" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t('上一页')}</button>
        <span className="mono">{t('第 {page} 页', { page })}</span>
        <button className="button button-secondary" disabled={page * PAGE_SIZE >= total || loading} onClick={() => setPage((value) => value + 1)}>{t('下一页')}</button>
      </div>
    </section>
    {admin && formOpen && <Modal title={t('添加域名')} onClose={() => { if (!busy) setFormOpen(false); }}>
      {accounts.length === 0
        ? <div className="panel-empty">{t('请先在「域名账户」添加 DNS 账户。')}</div>
        : <form className="dns-form" onSubmit={submit}>
          <label className="form-field"><span>{t('所属账户')}</span>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)} required>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name} ({account.type})</option>)}
            </select>
          </label>
          <label className="form-field"><span>{t('域名')}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="example.com" required maxLength={253} /></label>
          <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? t('正在提交…') : t('添加域名')}</button><button className="button button-quiet" type="button" disabled={busy} onClick={() => setFormOpen(false)}>{t('取消')}</button></div>
        </form>}
    </Modal>}
  </>;
}
