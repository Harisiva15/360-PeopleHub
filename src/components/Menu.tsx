/**
 * A button that opens a panel beneath itself.
 *
 * Every header widget — notifications, quick actions, the app grid, the
 * profile menu — is this same object with different contents, which is the
 * point: four hand-rolled popovers would be four different answers to
 * click-outside, Escape, focus and z-index.
 *
 * **It closes on route change.** A menu is a way to go somewhere; leaving it
 * open over the page you just opened is the most common popover bug there is.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

export function Menu({
  label, icon, badge, align = 'end', width, className, children, trigger,
}: {
  /** The accessible name. Shown as text unless `icon` or `trigger` replaces it. */
  label: string;
  icon?: ReactNode;
  /** A count on the trigger. Zero is not rendered — an empty badge is noise. */
  badge?: number;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  /** Receives `close` so an item can dismiss the menu as it acts. */
  children: (close: () => void) => ReactNode;
  /** Replaces the default button face entirely — for the profile chip. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { pathname, search } = useLocation();

  /*
   * Going somewhere closes the menu that took you there. Adjusted during
   * render rather than in an effect — the same reason the sidebar does it that
   * way: an effect paints the open panel once over the new page before
   * closing it.
   */
  const [shownAt, setShownAt] = useState(pathname + search);
  if (shownAt !== pathname + search) {
    setShownAt(pathname + search);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      /* Focus goes back to the trigger, not to the top of the document. */
      wrap.current?.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={'menu-wrap' + (className ? ' ' + className : '')} ref={wrap}>
      <button
        type="button"
        className={'menu-btn' + (open ? ' on' : '') + (trigger ? ' bare' : '')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger ?? icon ?? label}
        {!!badge && badge > 0 && <span className="menu-dot">{badge > 99 ? '99+' : badge}</span>}
      </button>

      {open && (
        <div id={panelId} role="menu" className={'menu-panel ' + align}
          style={width ? { width } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
