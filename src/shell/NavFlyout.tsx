/**
 * A section's views, opened beside the rail.
 *
 * This is the only way a submenu appears. The rail used to expand sections
 * inside itself, which cost twice: the sidebar grew taller as you opened
 * things, and everything below the open section slid down the screen — so the
 * item somebody was reaching for moved while they reached for it.
 *
 * **It floats.** Fixed position, above the content, which therefore does not
 * shift by a pixel when one opens. The rail does not widen either. Both of
 * those were the point of moving away from the accordion.
 *
 * **It is sized by its contents.** Height comes from the items, so a section
 * with four views is a short panel rather than a tall one with a blank bottom.
 * Past `MAX_VH` it stops growing and scrolls, and only then does the sticky
 * heading earn its keep — which is exactly when knowing which section you are
 * inside stops being obvious.
 *
 * **Positioned before it paints, not after.** The top is computed from the
 * trigger's own rectangle and clamped to the viewport in the click handler.
 * Measuring after mount and correcting would show one frame in the wrong
 * place, which reads as a flicker.
 */

import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { hrefOf } from '../nav';
import type { NavGroup, NavItem } from '../nav';
import { Icon } from '../components/icons';

/** The tallest the panel may grow before it scrolls instead. */
export const MAX_VH = 0.72;

/** Matches the CSS, and used to place the panel before it renders. */
const HEADER_H = 76;
const ITEM_H = 52;
const ITEM_GAP = 2;
const BODY_PAD = 20;
const EDGE = 16;

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
  state, badges, isCurrent, onClose, mobile,
}: {
  state: FlyoutState;
  badges: Record<string, number>;
  isCurrent: (i: NavItem) => boolean;
  onClose: () => void;
  /** On a phone the panel is a full-height drawer, not a floating card. */
  mobile: boolean;
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
       * whose own handler then opens the next panel. Only one is ever open.
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
    <>
      {mobile && <div className="nav-fly-scrim" onClick={onClose} />}
      <div
        className={'nav-fly' + (mobile ? ' sheet' : '')}
        style={mobile ? undefined : { top: state.top, maxHeight: `${MAX_VH * 100}vh` }}
        ref={panel}
        tabIndex={-1}
        role="menu"
        aria-label={state.group.group}
      >
        <div className="nav-fly-h">
          <span className="nav-fly-ic" aria-hidden="true">
            <Icon n={state.group.ic} size="lg" />
          </span>
          <span className="nav-fly-t">
            <b>{state.group.group}</b>
            {state.group.desc && <i>{state.group.desc}</i>}
          </span>
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
                <span className="nav-fly-i-ic" aria-hidden="true">
                  <Icon n={i.ic ?? 'next'} size="lg" />
                </span>
                <span className="nav-fly-i-t">
                  <b>{i.n}</b>
                  {i.d && <i>{i.d}</i>}
                </span>
                {b > 0 && <span className="pill">{b}</span>}
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
