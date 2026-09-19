import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LOGO_ON_RAIL } from '../assets/logo';
import { hrefOf, NAV, TABBAR } from '../nav';
import { useNavBadges } from './badges';
import { ORG } from '../data/org';
import { useApp } from '../state/AppContext';
import { Avatar } from '../components/ui';
import { Icon } from '../components/icons';
import { TopBar } from './TopBar';
import { PageActionsTarget } from './PageActions';
import { NavFlyout, placeFlyout } from './NavFlyout';
import type { FlyoutState } from './NavFlyout';
import type { ReactNode } from 'react';

const isMobile = () => window.matchMedia('(max-width: 860px)').matches;

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const { pathname, search } = useLocation();
  const route = pathname.replace(/^\//, '') || 'dashboard';
  const [navOpen, setNavOpen] = useState(false);
  /*
   * Collapsed to a rail of icons. Remembered per browser, like the open
   * sections are — somebody who works narrow wants it narrow tomorrow too.
   */
  const [tight, setTight] = useState<boolean>(() => {
    try { return localStorage.getItem('nav.tight') === '1'; } catch { return false; }
  });
  /*
   * The section whose views are open beside the collapsed rail. Only ever set
   * while the rail is collapsed — expanded, the views open inline where there
   * is room for them.
   */
  const [flyout, setFlyout] = useState<FlyoutState | null>(null);

  const toggleTight = () => setTight((t) => {
    try { localStorage.setItem('nav.tight', t ? '0' : '1'); } catch { /* fine */ }
    setFlyout(null);
    return !t;
  });
  /* Where a page's primary action lands. Held in state, not a ref, so the
     portal re-renders once the header's element actually exists. */
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);

  /*
   * Which sections are expanded. Remembered per browser so the sidebar is
   * where you left it, and the section holding the current route is always
   * open — landing on a page whose section is shut leaves nothing highlighted
   * and no way to see where you are.
   */
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();

  const [shut, setShut] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('nav.shut');
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch { /* a private window has no storage; everything starts as it comes */ }
    return new Set(NAV.filter((g) => g.items.length && !g.open).map((g) => g.group));
  });

  /*
   * A section holding the current route is always open — landing on a page
   * whose section is shut leaves nothing highlighted and no way to see where
   * you are. A page in two sections opens both; that is honest about where it
   * can be reached from.
   */
  const holdsRoute = (group: string) => {
    const g = NAV.find((x) => x.group === group);
    return !!g && (g.k === route || g.items.some((i) => i.k === route));
  };
  const isOpen = (group: string) => holdsRoute(group) || !shut.has(group);
  const toggle = (group: string) => setShut((s) => {
    const next = new Set(s);
    if (next.has(group)) next.delete(group); else next.add(group);
    try { localStorage.setItem('nav.shut', JSON.stringify([...next])); } catch { /* fine */ }
    return next;
  });
  const [mobile, setMobile] = useState(isMobile);

  useEffect(() => {
    const onResize = () => setMobile(isMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /*
   * The nav is an overlay on a phone, so it closes when the route changes.
   * Adjusted during render rather than in an effect — an effect would paint
   * the open overlay once on the new route before closing it.
   */
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    if (navOpen) setNavOpen(false);
    if (flyout) setFlyout(null);
  }

  const badges = useNavBadges();

  return (
    <div id="app">
      <aside className={'sidebar' + (navOpen ? ' open' : '') + (tight && !mobile ? ' tight' : '')}>
        <div className="brand">
          <img src={LOGO_ON_RAIL} alt={ORG.name + ' — ' + ORG.tagline} />
          <span className="cap">{ORG.philosophy}</span>
          {!mobile && (
            <button
              className="rail-tight"
              onClick={toggleTight}
              aria-label={tight ? 'Expand the menu' : 'Collapse the menu'}
              aria-expanded={!tight}
              title={tight ? 'Expand the menu' : 'Collapse the menu'}
            >
              <Icon n="next" size="sm" />
            </button>
          )}
        </div>

        {/*
          * Filtering the menu, not the app. Typing narrows to the sections and
          * views whose names match and opens them, so finding "disbursal"
          * does not require knowing it lives under Payroll.
          */}
        <div className="nav-find" hidden={tight && !mobile}>
          <input
            id="nav-find"
            className="nav-find-in"
            type="search"
            value={find}
            placeholder="Search menu…"
            aria-label="Search the menu"
            onChange={(e) => setFind(e.target.value)}
          />
        </div>

        <nav className="nav">
          {NAV.map((g) => {
            if (g.roles && !g.roles.includes(app.role)) return null;
            if (!app.can(g.k)) return null;

            const items = g.items.filter((i) =>
              app.can(i.k) && (!i.roles || i.roles.includes(app.role)));

            /* While searching, a section shows only what matched. */
            const hit = (t: string) => t.toLowerCase().includes(needle);
            const sectionHit = !needle || hit(g.group);
            const shown = needle && !sectionHit ? items.filter((i) => hit(i.n)) : items;
            if (needle && !sectionHit && !shown.length) return null;

            const badge = badges[g.k] || 0;

            /* A module with no sub-views is a plain link to itself. */
            if (!shown.length) {
              return (
                <Link key={g.group} to={'/' + g.k}
                  className={'nav-top' + (route === g.k ? ' on' : '')}
                  /* The label is the tooltip once it is no longer on screen. */
                  title={tight ? g.group : undefined}>
                  <span className="ic"><Icon n={g.ic} size="lg" /></span>
                  <span className="nav-label">{g.group}</span>
                  {badge > 0 && <span className="pill">{badge}</span>}
                </Link>
              );
            }

            /* Searching opens what it found; otherwise the saved state wins. */
            const open = needle ? true : isOpen(g.group);
            const inside = shown.reduce((n, i) => n + (badges[i.k] || 0), 0);
            const here = shown.some((i) => i.k === route);

            return (
              <div className={'nav-sec' + (open ? ' open' : '')} key={g.group}>
                <button
                  className={'nav-top' + (here && !open ? ' here' : '')}
                  onClick={(e) => {
                    if (!(tight && !mobile)) { toggle(g.group); return; }
                    /* Clicking the open section again closes it. */
                    if (flyout?.group.group === g.group) { setFlyout(null); return; }
                    setFlyout({
                      group: g,
                      items: shown,
                      top: placeFlyout(
                        e.currentTarget.getBoundingClientRect(),
                        shown.length,
                        window.innerHeight,
                      ),
                    });
                  }}
                  aria-expanded={open}
                  title={tight ? g.group : undefined}
                >
                  <span className="ic"><Icon n={g.ic} size="lg" /></span>
                  <span className="nav-label" style={{ textAlign: 'left' }}>{g.group}</span>
                  {!open && inside > 0 && <span className="pill">{inside}</span>}
                  <span className="nav-caret" aria-hidden="true">
                    <Icon n="next" size="sm" />
                  </span>
                </button>

                {open && !(tight && !mobile) && (
                  <div className="nav-subs">
                    {shown.map((i) => {
                      const b = badges[i.k] || 0;
                      /*
                        * A sub-item is current when its own href matches the
                        * location, tab and all. Items without a tab match on
                        * the route alone, so Directory does not light up just
                        * because some other view of Employees is open.
                        */
                      const on = i.to
                        ? hrefOf(i) === pathname + search
                        : route === i.k && !search;
                      return (
                        <Link key={hrefOf(i)} to={hrefOf(i)}
                          className={'nav-sub' + (on ? ' on' : '')}>
                          <i className="nav-dot" aria-hidden="true" />
                          <span style={{ flex: 1 }}>{i.n}</span>
                          {b > 0 && <span className="pill">{b}</span>}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="rail-foot">
          <div className="row" style={{ gap: 9 }}>
            <Avatar name={app.me.name} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="nm">{app.me.name}</div>
              <div className="mt">{app.me.designation}</div>
            </div>
            <button className="btn ghost icon sm" onClick={app.toggleTheme}
              title="Toggle theme" aria-label="Toggle theme">
              {app.theme === 'light' ? '☾' : '☀'}
            </button>
          </div>
        </div>
      </aside>

      {flyout && tight && !mobile && (
        <NavFlyout
          state={flyout}
          badges={badges}
          isCurrent={(i) => (i.to ? hrefOf(i) === pathname + search : route === i.k && !search)}
          onClose={() => setFlyout(null)}
        />
      )}

      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <div className="main">
        <TopBar mobile={mobile} onMenu={() => setNavOpen((o) => !o)} actionRef={setActionSlot} />

        {/*
          * The page renders after the header, so the header's action element
          * exists in the DOM by the time a `<PageActions>` inside `children`
          * looks for it.
          */}
        <PageActionsTarget value={actionSlot}>
          <main className="content">{children}</main>
        </PageActionsTarget>
      </div>

      <nav className="tabbar">
        {TABBAR.filter((k) => app.can(k)).map((k) => {
          /*
           * The icon belongs to the section now, and a route may be a section
           * itself (Dashboard) or a view inside one (Leave). Look for the
           * section that owns it either way, and fall back to the route's own
           * name rather than crashing on a tab that has moved.
           */
          const g = NAV.find((x) => x.k === k) ?? NAV.find((x) => x.items.some((i) => i.k === k));
          const label = NAV.find((x) => x.k === k)?.group
            ?? g?.items.find((i) => i.k === k)?.n
            ?? k;
          const badge = badges[k] || 0;
          return (
            <Link key={k} to={'/' + k} className={route === k ? 'on' : ''}>
              <span className="ic">{g ? <Icon n={g.ic} size="lg" /> : null}</span>
              {label.split(' ')[0]}
              {badge > 0 && <span className="pill">{badge}</span>}
            </Link>
          );
        })}
      </nav>

      <div id="toasts">
        {app.toasts.map((t) => (
          <div key={t.id} className={'toast' + (t.kind ? ' ' + t.kind : '')}>
            {t.kind === 'ok' && <Icon n="ok" />}
            {t.kind === 'err' && <Icon n="warn" />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
