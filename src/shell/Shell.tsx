import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { logoFor } from '../assets/logo';
import { NAV, TABBAR } from '../nav';
import { getModule } from '../modules/registry';
import { ORG } from '../data/org';
import { ACCOUNTS } from '../state/rbac';
import { useApp } from '../state/AppContext';
import { Avatar } from '../components/ui';
import type { ReactNode } from 'react';

const isMobile = () => window.matchMedia('(max-width: 860px)').matches;

export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const { pathname } = useLocation();
  const route = pathname.replace(/^\//, '') || 'dashboard';
  const [navOpen, setNavOpen] = useState(false);
  const [mobile, setMobile] = useState(isMobile);

  useEffect(() => {
    const onResize = () => setMobile(isMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* the nav is an overlay on a phone — close it whenever the route changes */
  useEffect(() => setNavOpen(false), [pathname]);

  const mod = getModule(route);
  const accounts = ACCOUNTS();
  const ctx = { role: app.role, meId: app.meId, me: app.me };

  return (
    <div id="app">
      <aside className={'sidebar' + (navOpen ? ' open' : '')}>
        <div className="brand">
          <img src={logoFor(app.theme)} alt={ORG.name + ' — ' + ORG.tagline} />
          <span className="cap">
            {ORG.product} · {ORG.fy}
          </span>
        </div>

        <nav className="nav">
          {NAV.map((g) => {
            const items = g.items.filter((i) => app.can(i.k));
            if (!items.length) return null;
            return (
              <div className="nav-group" key={g.group}>
                <h6>{g.group}</h6>
                {items.map((i) => {
                  const badge = getModule(i.k)?.badge?.(ctx) || 0;
                  return (
                    <Link key={i.k} to={'/' + i.k} className={route === i.k ? 'on' : ''}>
                      <span className="ic">{i.ic}</span>
                      {i.n}
                      {badge > 0 && <span className="pill">{badge}</span>}
                    </Link>
                  );
                })}
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
            <h1>{mod?.title || '—'}</h1>
            <div className="sub">{mod?.subtitle?.(ctx)}</div>
          </div>
          <div className="spacer" />
          <div className="seg" id="roleSeg" title="Switch the signed-in role">
            {accounts.map((a) => (
              <button key={a.role} className={app.role === a.role ? 'on' : ''} onClick={() => app.signInAs(a.role)}>
                {a.role === 'admin' ? 'Admin' : a.role === 'manager' ? 'Manager' : 'Employee'}
              </button>
            ))}
          </div>
        </header>

        <main className="content">{children}</main>
      </div>

      <nav className="tabbar">
        {TABBAR.filter((k) => app.can(k)).map((k) => {
          const item = NAV.flatMap((g) => g.items).find((i) => i.k === k)!;
          const badge = getModule(k)?.badge?.(ctx) || 0;
          return (
            <Link key={k} to={'/' + k} className={route === k ? 'on' : ''}>
              <span className="ic">{item.ic}</span>
              {item.n.split(' ')[0]}
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
