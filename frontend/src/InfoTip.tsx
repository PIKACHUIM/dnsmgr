import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

interface InfoTipProps {
  /** 无障碍名称，例如「随机密码规则说明」 */
  label: string;
  text: string;
}

/** 说明文字只在悬停 / 聚焦时提示，点击展开完整内容，避免正文堆砌。 */
export function InfoTip({ label, text }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return <span className="info-tip" ref={root}>
    <button
      type="button" className="info-tip-button" aria-label={label} aria-expanded={open}
      data-tip={text} onClick={() => setOpen((value) => !value)}
    >
      <Icon name="info" />
    </button>
    {open && <span className="info-tip-panel" role="dialog" aria-label={label}>{text}</span>}
  </span>;
}
