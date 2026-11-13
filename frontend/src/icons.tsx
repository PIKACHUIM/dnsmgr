type IconName = 'grid' | 'dns' | 'shield' | 'menu' | 'close' | 'arrow' | 'logout' | 'server' | 'lock' | 'sun' | 'moon' | 'globe' | 'plus' | 'panel' | 'panel-expand' | 'info' | 'alert' | 'key' | 'sliders' | 'palette';

const paths: Record<IconName, string[]> = {
  grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  dns: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01', 'M12 7h5', 'M12 17h5'],
  shield: ['M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z', 'm8 12 3 3 5-6'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  logout: ['M9 4H4v16h5', 'M9 12h12', 'm16 7 5 5-5 5'],
  server: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M7 7h.01', 'M7 17h.01'],
  lock: ['M6 10h12v11H6z', 'M8 10V7a4 4 0 0 1 8 0v3', 'M12 14v3'],
  sun: ['M12 4v2', 'M12 18v2', 'M4 12H2', 'M22 12h-2', 'm5.6 5.6 1.4 1.4', 'm17 17 1.4 1.4', 'm18.4 5.6-1.4 1.4', 'm7 17-1.4 1.4', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8'],
  moon: ['M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M3 12h18', 'M12 3c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3'],
  plus: ['M12 5v14', 'M5 12h14'],
  panel: ['M4 4h16v16H4z', 'M9 4v16', 'm15 9-3 3 3 3'],
  'panel-expand': ['M4 4h16v16H4z', 'M9 4v16', 'm13 9 3 3-3 3'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v6', 'M12 7.5h.01'],
  alert: ['m12 4 9 16H3z', 'M12 10v4', 'M12 17h.01'],
  key: ['M15 7a4 4 0 1 1-3.2 6.4L4 21H2v-3l8-5.6A4 4 0 0 1 15 7', 'M16.5 7.5h.01'],
  sliders: ['M4 7h6', 'M14 7h6', 'M12 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4', 'M4 17h10', 'M18 17h2', 'M16 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4'],
  palette: ['M12 21a9 9 0 1 1 0-18c5 0 9 3.5 9 7.5 0 2.5-2 4.5-4.5 4.5H14a2 2 0 0 0 0 4c0 1.1-.9 2-2 2', 'M13.5 7h.01', 'M17 10h.01', 'M7.5 9h.01', 'M6.5 13h.01'],
};

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name].map((path) => <path d={path} key={path} />)}
  </svg>;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}>
    <span className="brand-mark"><Icon name="dns" /></span>
    <span><strong>聚合 DNS</strong><small>管理系统 / CONTROL</small></span>
  </div>;
}
