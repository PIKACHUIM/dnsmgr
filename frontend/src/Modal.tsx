import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { Icon } from './icons';
import { usePreferences } from './preferences';

interface ModalProps {
  title: string;
  description?: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}

const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, description, wide = false, onClose, children }: ModalProps) {
  const { t } = usePreferences();
  const dialog = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previous.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const target = body.current?.querySelector<HTMLElement>(focusable);
    (target ?? dialog.current)?.focus();
    return () => {
      document.body.style.overflow = original;
      previous.current?.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>(focusable) ?? []);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function backdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return <div className="modal-backdrop" onMouseDown={backdrop}>
    <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialog} tabIndex={-1}>
      <div className="modal-heading">
        <div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div>
        <button type="button" className="icon-button" aria-label={t('关闭弹窗')} title={t('关闭弹窗')} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="modal-body" ref={body}>{children}</div>
    </div>
  </div>;
}
