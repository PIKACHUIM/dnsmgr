import { useEffect, useRef, useState, type ReactNode } from 'react';

interface MenuProps {
  /** 触发按钮的无障碍名称 */
  label: string;
  trigger: ReactNode;
  align?: 'start' | 'end';
  className?: string;
  children: (close: () => void) => ReactNode;
}

/** 轻量下拉菜单：点击外部或 Esc 关闭，打开时把焦点交给第一项。 */
export function Menu({ label, trigger, align = 'end', className = '', children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('[role="menuitem"], button, a[href]')?.focus();
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return <div className={`menu ${className}`} ref={root}>
    <button
      ref={button} type="button" className="icon-button menu-trigger" aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}
    >
      {trigger}
    </button>
    {open && <div ref={panel} className={`menu-panel menu-${align}`} role="menu" aria-label={label}>
      {children(() => { setOpen(false); button.current?.focus(); })}
    </div>}
  </div>;
}
