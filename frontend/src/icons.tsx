type IconName = 'grid' | 'dns' | 'shield' | 'menu' | 'close' | 'arrow' | 'logout' | 'server' | 'lock';

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
