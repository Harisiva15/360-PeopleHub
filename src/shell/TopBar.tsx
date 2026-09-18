/**
 * The application header.
 *
 * Breadcrumb, page title and description on the left; the things that are the
 * same on every page on the right — search, notifications, quick actions, the
 * module launcher and the profile menu.
 *
 * **Everything here is derived, never listed twice.** The breadcrumb, the
 * launcher, the quick actions and half of what search finds all come out of
 * `NAV`, and the notification counts come out of the same `approvals.navBadges`
 * call the sidebar pills use. A header with its own copy of the menu is a
 * header that goes stale the first time somebody adds a module.
 *
 * **Nothing here widens what a role may reach.** Every destination is filtered
 * through the same `can(role, key)` the sidebar uses, plus the item's own
 * `roles` — a quick action to a page the server refuses is a worse affordance
 * than no quick action at all.
 */

import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { hrefOf, NAV, QUICK_ACTIONS } from '../nav';
import type { NavGroup, NavItem } from '../nav';
import { TITLES } from '../modules/titles';
import { SUBTITLES } from '../modules/subtitles';
import { useNavBadges } from './badges';
import { ACCOUNTS, can, ROLE_LABEL } from '../state/rbac';
import { useApp } from '../state/AppContext';
import { useAuth } from '../auth/AuthContext';
import { useVisiblePeople } from '../services/people';
import { Avatar } from '../components/ui';
import { Menu } from '../components/Menu';
import { WorldClocks } from './WorldClocks';

/* ---------------- what the header can reach ---------------- */

interface Dest {
  /** Route key — the permission, and the badge key. */
  k: string;
  /** What to call it in a list: "Leave · Approvals". */
  label: string;
  href: string;
  ic: string;
}

/**
 * Every view the signed-in person may open, flattened out of NAV.
 *
 * Gated with `can(role, k)` from the policy rather than `app.can`, which is a
 * fresh closure on every render and would defeat the memo — the answer depends
 * on the role and on nothing else.
 */
function useDestinations(): { groups: NavGroup[]; dests: Dest[] } {
  const { role } = useApp();
  return useMemo(() => {
    const groups = NAV.filter((g) => (!g.roles || g.roles.includes(role)) && can(role, g.k));

    const allowed = (i: NavItem) =>
      can(role, i.k) && (!i.roles || i.roles.includes(role));

    const dests: Dest[] = [];
    groups.forEach((g) => {
      if (!g.items.length) {
        dests.push({ k: g.k, label: g.group, href: '/' + g.k, ic: g.ic });
        return;
      }
      g.items.filter(allowed).forEach((i) => {
        dests.push({ k: i.k, label: `${g.group} · ${i.n}`, href: hrefOf(i), ic: g.ic });
      });
    });
    return { groups, dests };
  }, [role]);
}

/* ---------------- breadcrumb ---------------- */

function Crumbs({ route, search }: { route: string; search: string }) {
  const g = NAV.find((x) => x.k === route) ?? NAV.find((x) => x.items.some((i) => i.k === route));
  const here = g?.items.find((i) => hrefOf(i) === '/' + route + search);

  /* Dashboard is Home; it does not appear twice. */
  if (route === 'dashboard') return <nav className="crumbs" aria-label="Breadcrumb">Home</nav>;

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to="/dashboard">Home</Link>
      {g && (
        <>
          <span aria-hidden="true">›</span>
          {here ? <Link to={'/' + g.k}>{g.group}</Link> : <span>{g.group}</span>}
        </>
      )}
      {here && (
        <>
          <span aria-hidden="true">›</span>
          <span>{here.n}</span>
        </>
      )}
    </nav>
  );
}

/* ---------------- global search ---------------- */

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { dests } = useDestinations();
  const dir = useVisiblePeople();

  const needle = q.trim().toLowerCase();
  const pages = needle
    ? dests.filter((d) => d.label.toLowerCase().includes(needle)).slice(0, 6)
    : [];
  /*
   * People come from the scoped directory, so an employee searching finds
   * themselves and a manager finds their line — the search box does not see
   * further than the pages behind it do.
   */
  const people = needle
    ? dir.list.filter((e) =>
      (e.name + ' ' + e.code + ' ' + e.designation).toLowerCase().includes(needle)).slice(0, 5)
    : [];

  const go = (href: string) => { setQ(''); setOpen(false); nav(href); };

  return (
    <div className="gsearch" onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
    }}>
      <span className="gsearch-ic" aria-hidden="true">⌕</span>
      <input
        className="gsearch-in"
        type="search"
        value={q}
        placeholder="Search people and pages…"
        aria-label="Search people and pages"
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setQ(''); setOpen(false); e.currentTarget.blur(); }
          if (e.key === 'Enter') {
            const first = pages[0] ?? (people[0] ? { href: '/employees' } : null);
            if (first) go(first.href);
          }
        }}
      />
      {open && needle.length > 0 && (
        <div className="gsearch-out">
          {!pages.length && !people.length && (
            <div className="gsearch-none">Nothing matches “{q.trim()}”.</div>
          )}
          {!!people.length && (
            <>
              <div className="gsearch-h">People</div>
              {people.map((e) => (
                <button key={e.id} className="gsearch-row" onClick={() => go('/employees')}>
                  <Avatar name={e.name} />
                  <span className="gs-t">
                    <b>{e.name}</b>
                    <i>{e.designation} · {e.code}</i>
                  </span>
                </button>
              ))}
            </>
          )}
          {!!pages.length && (
            <>
              <div className="gsearch-h">Pages</div>
              {pages.map((d) => (
                <button key={d.href} className="gsearch-row" onClick={() => go(d.href)}>
                  <span className="gs-ic" aria-hidden="true">{d.ic}</span>
                  <span className="gs-t"><b>{d.label}</b></span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- the header ---------------- */

export function TopBar({ mobile, onMenu, actionRef }: {
  mobile: boolean;
  onMenu: () => void;
  /** Receives the element a page's `<PageActions>` renders into. */
  actionRef: (el: HTMLElement | null) => void;
}) {
  const app = useApp();
  const auth = useAuth();
  const { pathname, search } = useLocation();
  const route = pathname.replace(/^\//, '') || 'dashboard';
  const badges = useNavBadges();
  const { groups, dests } = useDestinations();
  const accounts = ACCOUNTS();

  const ctx = { role: app.role, meId: app.meId, me: app.me };

  /* What is waiting on this person, module by module, heaviest first. */
  const waiting = dests
    .filter((d, i, all) => all.findIndex((x) => x.k === d.k) === i)
    .map((d) => ({ ...d, n: badges[d.k] || 0 }))
    .filter((d) => d.n > 0)
    .sort((a, b) => b.n - a.n);
  const waitingTotal = waiting.reduce((n, d) => n + d.n, 0);

  /* Named views, resolved out of NAV — see QUICK_ACTIONS for why. */
  const quick = QUICK_ACTIONS.slice()
    .map((n) => dests.find((d) => d.label.endsWith('· ' + n) || d.label === n))
    .filter((d): d is Dest => !!d);

  return (
    <header className="topbar">
      {mobile && (
        <button className="btn ghost icon no-print" aria-label="Open the menu" onClick={onMenu}>
          ☰
        </button>
      )}

      <div className="topbar-t">
        <Crumbs route={route} search={search} />
        <h1>{TITLES[route] || '—'}</h1>
        <div className="sub">{SUBTITLES[route]?.(ctx)}</div>
      </div>

      {/* Whatever the open page declares as its primary action. */}
      <div className="topbar-cta no-print" ref={actionRef} />

      <div className="spacer" />

      <GlobalSearch />
      <WorldClocks />

      <div className="topbar-acts no-print">
        <Menu label="Quick actions" icon="＋" width={244}>
          {(close) => (
            <>
              <div className="menu-h">Quick actions</div>
              {quick.length ? quick.map((d) => (
                <Link key={d.href} to={d.href} role="menuitem" className="menu-row" onClick={close}>
                  <span className="gs-ic" aria-hidden="true">{d.ic}</span>
                  {d.label.split(' · ').pop()}
                </Link>
              )) : <div className="menu-none">Nothing here is available to you.</div>}
            </>
          )}
        </Menu>

        <Menu label="Notifications" icon="◔" badge={waitingTotal} width={288}>
          {(close) => (
            <>
              <div className="menu-h">Waiting on you</div>
              {waiting.length ? waiting.map((d) => (
                <Link key={d.k} to={d.href} role="menuitem" className="menu-row" onClick={close}>
                  <span className="gs-ic" aria-hidden="true">{d.ic}</span>
                  <span style={{ flex: 1 }}>{d.label.split(' · ')[0]}</span>
                  <span className="menu-n">{d.n}</span>
                </Link>
              )) : <div className="menu-none">Nothing is waiting on you.</div>}
            </>
          )}
        </Menu>

        <Menu label="All modules" icon="⠿" width={310} className="appgrid-wrap">
          {(close) => (
            <>
              <div className="menu-h">All modules</div>
              <div className="appgrid">
                {groups.map((g) => (
                  <Link key={g.group} to={'/' + g.k} role="menuitem"
                    className="appgrid-i" onClick={close}>
                    <span className="gs-ic" aria-hidden="true">{g.ic}</span>
                    <span>{g.group}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </Menu>

        <Menu label="Your account" width={252} trigger={(
          <span className="who">
            <Avatar name={app.me.name} />
            <span className="who-t">
              <b>{app.me.name}</b>
              <i>{ROLE_LABEL[app.role]}</i>
            </span>
          </span>
        )}>
          {(close) => (
            <>
              <div className="menu-id">
                <Avatar name={app.me.name} size="lg" />
                <div style={{ minWidth: 0 }}>
                  <b>{app.me.name}</b>
                  <i>{app.me.designation}</i>
                  <i className="mono">{app.me.code}</i>
                </div>
              </div>

              <Link to="/employees" role="menuitem" className="menu-row" onClick={close}>
                <span className="gs-ic" aria-hidden="true">👤</span> My profile
              </Link>
              <button type="button" role="menuitem" className="menu-row"
                onClick={() => { app.toggleTheme(); close(); }}>
                <span className="gs-ic" aria-hidden="true">{app.theme === 'light' ? '☾' : '☀'}</span>
                {app.theme === 'light' ? 'Dark theme' : 'Light theme'}
              </button>

              {/*
                * The role switcher exists only when there is no sign-in. It is
                * the honest signal that a build is a demo — and it must never
                * appear beside a real session, where changing your own role by
                * clicking would be the whole authorisation model defeated.
                */}
              {!auth.configured ? (
                <>
                  <div className="menu-h">Demo · switch role</div>
                  {accounts.map((a) => (
                    <button key={a.role} type="button" role="menuitem"
                      className={'menu-row' + (app.role === a.role ? ' on' : '')}
                      onClick={() => { app.signInAs(a.role); close(); }}>
                      <span className="gs-ic" aria-hidden="true">
                        {app.role === a.role ? '✓' : ' '}
                      </span>
                      {ROLE_LABEL[a.role]}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  <div className="menu-sep" />
                  <button type="button" role="menuitem" className="menu-row"
                    onClick={() => { close(); void auth.signOut(); }}>
                    <span className="gs-ic" aria-hidden="true">⇥</span> Sign out
                  </button>
                </>
              )}
            </>
          )}
        </Menu>
      </div>

      {!auth.configured && (
        <span
          className="demo-tag no-print"
          title="Sample data, no sign-in — anyone can switch role. Not a live HR system."
        >
          Demo
        </span>
      )}
    </header>
  );
}
