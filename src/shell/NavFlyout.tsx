/**
 * A section's views, opened beside the collapsed rail.
 *
 * With the rail at 68px there is nowhere to put a sub-item, so the rail used
 * to answer a click on a section by expanding itself back to 230px. That works
 * but it is the wrong trade: somebody who collapsed the rail wants the space,
 * and taking it back every time they navigate means they collapse it again a
 * moment later.
 *
 * **It is sized by its contents.** Height comes from the items, so a section
 * with three views is a short panel rather than a tall one with a blank
 * bottom. Only past `MAX_VH` does it stop growing and scroll, and only then
 * does the heading need to be sticky — which it is, so the section you are
 * inside stays named while you scroll its views.
 *
 * **Positioned before it paints, not after.** The top is computed from the
 * trigger's own rectangle and clamped to the viewport in the click handler, so
 * the panel appears where it belongs. Measuring after mount and correcting
 * would show one frame in the wrong place, which reads as a flicker.
 */

import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { hrefOf } from '../nav';
import type { NavGroup, NavItem } from '../nav';
import { Icon } from '../components/icons';

/** The tallest the panel may grow before it scrolls instead. */
export const MAX_VH = 0.72;

/** Matches the CSS, and used to place the panel before it renders. */
const HEADER_H = 44;
const ITEM_H = 40;
const ITEM_GAP = 3;
const BODY_PAD = 36;      /* 18 top + 18 bottom */
const EDGE = 12;          /* breathing room against the viewport edge */

/**
 * Where to put a panel opened from `trigger`, given how many views it holds.
 *
 * Derived rather than measured for the reason in the file comment, which means
 * the numbers above have to agree with the stylesheet — `checks/styles.ts`
 * asserts that they do.
 */
export function placeFlyout(trigger: DOMRect, itemCount: number, viewportH: number): number {
  const wanted = HEADER_H + BODY_PAD + itemCount * ITEM_H + Math.max(0, itemCount - 1) * ITEM_GAP;
  const height = Math.min(wanted, viewportH * MAX_VH);
  /* Aligned with the section that opened it, then pulled back inside the screen. */
  return Math.max(EDGE, Math.min(trigger.top, viewportH - height - EDGE));
}

export interface FlyoutState {
  group: NavGroup;
  items: NavItem[];
  top: number;
}

export function NavFlyout({
  state, badges, isCurrent, onClose,
}: {
  state: FlyoutState;
  badges: Record<string, number>;
  isCurrent: (i: NavItem) => boolean;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  /* Opening moves focus in, so the panel can be read and dismissed by keyboard. */
  useEffect(() => { panel.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      /*
       * A click on the rail closes it too — including on another section,
       * whose own handler then opens the next panel.
       */
      if (!panel.current?.contains(t)) onClose();
    };
    document.addEventListener('keydown', onKey);
    /* Capture, so this runs before a nav button's own click handler. */
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose]);

  return (
    <div
      className="nav-fly"
      style={{ top: state.top, maxHeight: `${MAX_VH * 100}vh` }}
      ref={panel}
      tabIndex={-1}
      role="menu"
      aria-label={state.group.group}
    >
      <div className="nav-fly-h">
        <Icon n={state.group.ic} size="lg" />
        <span className="nav-fly-t">{state.group.group}</span>
        <button type="button" className="nav-fly-x" onClick={onClose} aria-label="Close">
          <Icon n="close" size="sm" />
        </button>
      </div>

      <div className="nav-fly-b">
        {state.items.map((i) => {
          const b = badges[i.k] || 0;
          return (
            <Link
              key={hrefOf(i)}
              to={hrefOf(i)}
              role="menuitem"
              className={'nav-fly-i' + (isCurrent(i) ? ' on' : '')}
              onClick={onClose}
            >
              <i className="nav-dot" aria-hidden="true" />
              <span className="nav-fly-n">{i.n}</span>
              {b > 0 && <span className="pill">{b}</span>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
