/**
 * A page's primary action, rendered in the header beside its title.
 *
 * The spec's page block is breadcrumb, title, description, primary action —
 * one object. Three of those four are already derived in the header from
 * `NAV`, `TITLES` and `SUBTITLES`, and only the fourth is something a module
 * knows. Rather than split the block in half and have each page redraw its own
 * title under the real one, a module hands its buttons up:
 *
 *     <PageActions><button className="btn primary">Add employee</button></PageActions>
 *
 * **A portal, not a slot register.** The first version of this kept the
 * handed-up element in state, which goes stale the moment the page re-renders
 * with a different label — a button reading "Approve 4" would still say 3. A
 * portal re-renders with its owner, because it *is* its owner's output; it
 * merely lands somewhere else in the DOM.
 *
 * **It renders nothing where it is written**, so a module can put it anywhere
 * convenient — including inside the tab that owns the action, which is how a
 * tabbed module gives each tab its own button without the tabs knowing about
 * each other.
 */

import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/** The header's own element, handed down so pages can render into it. */
const Ctx = createContext<HTMLElement | null>(null);

export const PageActionsTarget = Ctx.Provider;

export function PageActions({ children }: { children: ReactNode }) {
  const target = useContext(Ctx);
  /*
   * Null on the very first paint, before the header's callback ref has fired.
   * Rendering nothing for one frame is the right answer — the alternative is
   * an effect, and an effect would put the buttons in one frame later anyway.
   */
  return target ? createPortal(children, target) : null;
}
