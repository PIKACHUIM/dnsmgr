import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, errorMessage, readSession, request, type Session } from './api';
import { Auth } from './Auth';
import { Console } from './Console';
import { Brand } from './icons';
import { PreferencesProvider } from './preferences';
import './styles.css';

type AppState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'install' }
  | { kind: 'login'; notice?: string }
  | { kind: 'session'; session: Session };

function App() {
  const [state, setState] = useState<AppState>({ kind: 'loading' });
  const [retry, setRetry] = useState(0);
  const [path, setPath] = useState(window.location.pathname);

  const navigate = useCallback((destination: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', destination);
    else if (window.location.pathname !== destination) window.history.pushState(null, '', destination);
    setPath(destination);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  useEffect(() => {
    const changed = () => setPath(window.location.pathname);
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    async function restore() {
      try {
        const status = await request<{ code: 0; initialized: boolean }>('/api/v1/install/status', { signal: controller.signal });
        if (typeof status.initialized !== 'boolean') throw new ApiError('安装状态响应不完整，请检查后端服务。', 502);
        if (!status.initialized) {
          if (!controller.signal.aborted) {
            setState({ kind: 'install' });
            navigate('/install', true);
          }
          return;
        }
        try {
          const session = readSession(await request<Session>('/api/v1/session', { signal: controller.signal }));
          if (!controller.signal.aborted) {
            setState({ kind: 'session', session });
            if (['/login', '/install', '/logout'].includes(window.location.pathname)) navigate('/', true);
          }
        } catch (failure) {
          if (controller.signal.aborted) return;
          if (failure instanceof ApiError && failure.status === 401) {
            setState({ kind: 'login' });
            if (window.location.pathname === '/install' || window.location.pathname === '/logout') navigate('/login', true);
          } else throw failure;
        }
      } catch (failure) {
        if (!controller.signal.aborted) setState({ kind: 'error', message: errorMessage(failure) });
      }
    }
    void restore();
    return () => controller.abort();
  }, [retry, navigate]);

  const onExpired = useCallback((notice: string) => setState({ kind: 'login', notice }), []);
  const onLoggedOut = useCallback((notice = '已退出登录，服务端会话已清除。') => {
    setState({ kind: 'login', notice });
    navigate('/login', true);
  }, [navigate]);
  const onInstalled = useCallback((notice: string) => {
    setState({ kind: 'login', notice });
    navigate('/login', true);
  }, [navigate]);
  const onSignedIn = useCallback((session: Session) => {
    setState({ kind: 'session', session });
    if (['/login', '/install', '/logout', '/auth/totp'].includes(window.location.pathname)) navigate('/', true);
  }, [navigate]);

  useEffect(() => {
    if (state.kind === 'session') document.title = `${path === '/' ? '后台首页' : '功能模块'} · 聚合 DNS 管理系统`;
    else document.title = `${state.kind === 'install' ? '初始化系统' : state.kind === 'login' ? '登录' : '连接服务'} · 聚合 DNS 管理系统`;
  }, [state.kind, path]);

  if (state.kind === 'loading' || state.kind === 'error') return <main className="connection-page"><div className="connection-panel"><Brand /><div className="section-kicker">服务连接 / CONNECTION</div><h1>{state.kind === 'loading' ? '正在连接管理系统' : '无法加载管理系统'}</h1>{state.kind === 'loading' ? <p role="status"><span className="spinner" />正在检查安装状态与当前会话…</p> : <><div className="notice notice-error" role="alert">{state.message}</div><button className="button button-primary" onClick={() => setRetry((value) => value + 1)}>重新连接</button><p className="connection-hint">开发环境请确认后端监听 127.0.0.1:8787。</p></>}</div></main>;
  if (state.kind === 'session') return <Console session={state.session} path={path} navigate={navigate} onExpired={onExpired} onLoggedOut={onLoggedOut} />;
  return <Auth key={state.kind} mode={state.kind} notice={state.kind === 'login' ? state.notice : undefined} onInstalled={onInstalled} onSignedIn={onSignedIn} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><PreferencesProvider><App /></PreferencesProvider></StrictMode>);
