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
 *
 * **The panel is a portal, positioned in viewport coordinates.** It used to be
 * `position:absolute` inside the trigger's wrapper, which works until the
 * wrapper sits in something that clips. In User management it sits in a `<td>`
 * that is `position:sticky` inside a `.tbl-wrap` that is `overflow-x:auto`, and
 * `overflow` on one axis computes to `auto` on both — so the menu was cut off
 * at the cell's edge and its items read "Require t…", "Reset pa…",
 * "Deactiva…". No amount of `z-index` fixes that: a clipped box is clipped by
 * its ancestor's padding box, whatever it is stacked above.
 *
 * Portalling to `document.body` takes the panel out of every clipping and
 * stacking context on the page, which is the only reliable fix. The cost is
 * that position has to be computed rather than inherited, and kept current
 * while the page scrolls — both below.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

/** Clear of the viewport edge, so a flipped panel never sits flush against it. */
const EDGE = 8;
/** Between the trigger and the panel. */
const GAP = 6;
/** Below this, opening downwards is not worth it and the panel flips up. */
const MIN_ROOM = 180;

type Placement = {
  left: number;
  /** One of these two is set: `top` opens downwards, `bottom` opens upwards. */
  top?: number;
  bottom?: number;
  maxHeight: number;
};

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
  const [at, setAt] = useState<Placement | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
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

  /**
   * Where the panel goes, in viewport coordinates.
   *
   * Flips above the trigger when there is not enough room below, which is the
   * case for the last rows of any table — the reason a row menu near the
   * bottom edge used to open off-screen. `maxHeight` is whatever room the
   * chosen side actually has, so a long menu scrolls inside itself instead of
   * running past the viewport.
   */
  const place = useCallback(() => {
    const btn = wrap.current?.querySelector('button');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const w = width ?? panel.current?.offsetWidth ?? 226;
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    const roomBelow = vh - r.bottom - GAP - EDGE;
    const roomAbove = r.top - GAP - EDGE;
    const flip = roomBelow < MIN_ROOM && roomAbove > roomBelow;

    /*
     * `align: 'end'` means the panel's right edge meets the trigger's, which
     * is what keeps a row menu inside the table rather than pushing the page
     * wider. Then clamped to the viewport, because a trigger near the left
     * edge would otherwise place it off-screen.
     */
    const wanted = align === 'end' ? r.right - w : r.left;
    const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, vw - w - EDGE));

    setAt(flip
      ? { left, bottom: vh - r.top + GAP, maxHeight: Math.max(120, roomAbove) }
      : { left, top: r.bottom + GAP, maxHeight: Math.max(120, roomBelow) });
  }, [align, width]);

  /* Placed before paint, so the panel never shows at 0,0 for a frame. */
  useLayoutEffect(() => {
    if (open) place();
    else setAt(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      /*
       * The panel is no longer inside `wrap`, so it has to be tested
       * separately — without this, clicking an item in the portal counts as
       * clicking outside and the menu closes before the item acts.
       */
      if (wrap.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      /* Focus goes back to the trigger, not to the top of the document. */
      wrap.current?.querySelector<HTMLElement>('button')?.focus();
    };
    /*
     * Capture, so scrolling the table's own overflow container repositions the
     * panel too — a scroll inside `.tbl-wrap` never reaches window in the
     * bubble phase, and the panel would hang where the row used to be.
     */
    const onScroll = () => place();

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

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

      {open && at && createPortal(
        <div
          id={panelId}
          role="menu"
          ref={panel}
          /* Marks the node as a menu surface, for anything auditing overlays. */
          data-menu-portal=""
          className="menu-panel menu-fixed"
          style={{
            left: at.left,
            top: at.top,
            bottom: at.bottom,
            width,
            maxHeight: at.maxHeight,
          }}
        >
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </div>
  );
}
