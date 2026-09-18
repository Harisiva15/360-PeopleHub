import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { logoFor } from '../assets/logo';
import { hrefOf, NAV, TABBAR } from '../nav';
import { TITLES } from '../modules/titles';
import { SUBTITLES } from '../modules/subtitles';
import { useNavBadges } from './badges';
import { ORG } from '../data/org';
import { ACCOUNTS } from '../state/rbac';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthContext';
import { Avatar } from '../components/ui';
import { WorldClocks } from './WorldClocks';
import type { ReactNode } from 'react';

const isMobile = () => window.matchMedia('(max-width: 860px)').matches;

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const { pathname, search } = useLocation();
  const route = pathname.replace(/^\//, '') || 'dashboard';
  const [navOpen, setNavOpen] = useState(false);

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
  }

  const accounts = ACCOUNTS();
  const auth = useAuth();
  const ctx = { role: app.role, meId: app.meId, me: app.me };
  const badges = useNavBadges();

  return (
    <div id="app">
      <aside className={'sidebar' + (navOpen ? ' open' : '')}>
        <div className="brand">
          <img src={logoFor(app.theme)} alt={ORG.name + ' — ' + ORG.tagline} />
          <span className="cap">
            {ORG.product} · {ORG.fy}
          </span>
        </div>

        {/*
          * Filtering the menu, not the app. Typing narrows to the sections and
          * views whose names match and opens them, so finding "disbursal"
          * does not require knowing it lives under Payroll.
          */}
        <div className="nav-find">
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
                  className={'nav-top' + (route === g.k ? ' on' : '')}>
                  <span className="ic">{g.ic}</span>
                  <span style={{ flex: 1 }}>{g.group}</span>
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
                  onClick={() => toggle(g.group)}
                  aria-expanded={open}
                >
                  <span className="ic">{g.ic}</span>
                  <span style={{ flex: 1, textAlign: 'left' }}>{g.group}</span>
                  {!open && inside > 0 && <span className="pill">{inside}</span>}
                  <span className="nav-caret" aria-hidden="true">›</span>
                </button>

                {open && (
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

        <div style={{ padding: 11, borderTop: '1px solid var(--line)' }}>
          <div className="row" style={{ gap: 9 }}>
            <Avatar name={app.me.name} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                className="nm"
                style={{ fontWeight: 650, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {app.me.name}
              </div>
              <div className="mt" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {app.me.designation}
              </div>
            </div>
            <button className="btn ghost icon sm" onClick={app.toggleTheme} title="Toggle theme">
              {app.theme === 'light' ? '☾' : '☀'}
            </button>
          </div>
        </div>
      </aside>

      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}

      <div className="main">
        <header className="topbar">
          {mobile && (
            <button className="btn ghost icon no-print" onClick={() => setNavOpen((o) => !o)}>
              ☰
            </button>
          )}
          <div>
            <h1>{TITLES[route] || '—'}</h1>
            <div className="sub">{SUBTITLES[route]?.(ctx)}</div>
          </div>
          <div className="spacer" />
          <WorldClocks />
          {/*
            * The role switcher exists only when there is no sign-in. It is the
            * honest signal that a build is a demo — and it must never appear
            * beside a real session, where changing your own role by clicking
            * would be the whole authorisation model defeated.
            */}
          {!auth.configured ? (
            <>
              <span
                className="demo-tag no-print"
                title="Sample data, no sign-in — anyone can switch role. Not a live HR system."
              >
                Demo
              </span>
              <div className="seg" id="roleSeg" title="Switch the signed-in role">
                {accounts.map((a) => (
                  <button key={a.role} className={app.role === a.role ? 'on' : ''} onClick={() => app.signInAs(a.role)}>
                    {a.role === 'admin' ? 'Admin' : a.role === 'manager' ? 'Manager' : 'Employee'}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="row no-print" style={{ gap: 9 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>{auth.displayName}</span>
              <button className="btn sm" onClick={() => void auth.signOut()}>Sign out</button>
            </div>
          )}
        </header>

        <main className="content">{children}</main>
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
              <span className="ic">{g?.ic ?? '•'}</span>
              {label.split(' ')[0]}
              {badge > 0 && <span className="pill">{badge}</span>}
            </Link>
          );
        })}
      </nav>

      <div id="toasts">
        {app.toasts.map((t) => (
          <div key={t.id} className={'toast' + (t.kind ? ' ' + t.kind : '')}>
            {t.kind === 'ok' ? '✓ ' : t.kind === 'err' ? '⚠ ' : ''}
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
