import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LOGO_ON_RAIL } from '../assets/logo';
import { ALL_VIEWS, hrefOf, NAV, TABBAR } from '../nav';
import type { NavItem } from '../nav';
import { useNavBadges } from './badges';
import { ORG } from '../data/org';
import { useApp } from '../state/AppContext';
import { Avatar } from '../components/ui';
import { Icon } from '../components/icons';
import { TopBar } from './TopBar';
import { PageActionsTarget } from './PageActions';
import { NavFlyout, placeFlyout } from './NavFlyout';
import type { FlyoutState } from './NavFlyout';
import { useFavourites } from './favourites';
import type { ReactNode } from 'react';

const isMobile = () => window.matchMedia('(max-width: 860px)').matches;

/**
 * The application shell.
 *
 * **The rail holds top-level items only.** Sections used to expand inside it,
 * which cost twice: the sidebar grew as you opened things, and everything
 * below an open section slid down the screen — so the item somebody was
 * reaching for moved while they reached for it. Views open in a panel beside
 * the rail now, floating over the content, and neither the rail nor the page
 * moves when one appears.
 */
export function Shell({ children }: { children: ReactNode }) {
  const app = useApp();
  const { pathname, search } = useLocation();
  const route = pathname.replace(/^\//, '') || 'dashboard';
  const here = pathname + search;

  const [navOpen, setNavOpen] = useState(false);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const [find, setFind] = useState('');
  const needle = find.trim().toLowerCase();

  /** The one section whose views are open. Only ever one. */
  const [flyout, setFlyout] = useState<FlyoutState | null>(null);

  const [mobile, setMobile] = useState(isMobile);
  useEffect(() => {
    const onResize = () => setMobile(isMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const { favourites, isFavourite, toggleFavourite } = useFavourites();

  /*
   * Navigating closes the overlay and the panel. Adjusted during render rather
   * than in an effect — an effect would paint them open once on the new page
   * before closing them.
   */
  const [shownPath, setShownPath] = useState(here);
  if (shownPath !== here) {
    setShownPath(here);
    if (navOpen) setNavOpen(false);
    if (flyout) setFlyout(null);
  }

  const badges = useNavBadges();

  /** Whether a view is the one currently open, tab and all. */
  const isCurrent = (i: NavItem) =>
    (i.to ? hrefOf(i) === here : route === i.k && !search);

  /** The sections this role may open, with the views it may reach inside them. */
  const sections = NAV
    .filter((g) => (!g.roles || g.roles.includes(app.role)) && app.can(g.k))
    .map((g) => ({
      g,
      items: g.items.filter((i) => app.can(i.k) && (!i.roles || i.roles.includes(app.role))),
    }));

  /*
   * Search runs over every view, not the section names — somebody searching
   * "disbursal" has already failed to know it lives under Payroll, which is
   * why they are searching.
   */
  const hits = needle
    ? ALL_VIEWS.filter(({ groupKey, item }) => {
      if (!app.can(groupKey) || !app.can(item.k)) return false;
      if (item.roles && !item.roles.includes(app.role)) return false;
      const g = NAV.find((x) => x.k === groupKey);
      if (g?.roles && !g.roles.includes(app.role)) return false;
      return `${item.n} ${item.d ?? ''} ${g?.group ?? ''}`.toLowerCase().includes(needle);
    }).slice(0, 12)
    : [];

  const openSection = (
    e: React.MouseEvent<HTMLButtonElement>,
    g: (typeof sections)[number],
  ) => {
    /* Clicking the open section again closes it. */
    if (flyout?.group.group === g.g.group) { setFlyout(null); return; }
    setFlyout({
      group: g.g,
      items: g.items,
      top: placeFlyout(
        e.currentTarget.getBoundingClientRect(),
        g.items.length,
        window.innerHeight,
      ),
    });
  };

  return (
    <div id="app">
      <aside className={'sidebar' + (navOpen ? ' open' : '')}>
        <div className="brand">
          <img src={LOGO_ON_RAIL} alt={ORG.name + ' — ' + ORG.tagline} />
          <span className="cap">{ORG.philosophy}</span>
        </div>

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
          {needle ? (
            /* While searching, the rail is a list of views rather than sections. */
            hits.length ? hits.map(({ group, groupIcon, item, href }) => (
              <Link
                key={href + item.n}
                to={href}
                className={'nav-hit' + (isCurrent(item) ? ' on' : '')}
                onClick={() => setFind('')}
              >
                <span className="ic"><Icon n={item.ic ?? groupIcon} size="lg" /></span>
                <span className="nav-hit-t">
                  <b>{item.n}</b>
                  <i>{group}</i>
                </span>
              </Link>
            )) : (
              <div className="nav-none">Nothing matches “{find.trim()}”.</div>
            )
          ) : (
            sections.map(({ g, items }) => {
              const badge = badges[g.k] || 0;
              const inside = items.reduce((n, i) => n + (badges[i.k] || 0), 0);

              /* A section with no sub-views is a plain link to itself. */
              if (!items.length) {
                return (
                  <Link
                    key={g.group}
                    to={'/' + g.k}
                    className={'nav-top' + (route === g.k ? ' on' : '')}
                  >
                    <span className="ic"><Icon n={g.ic} size="lg" /></span>
                    <span className="nav-label">{g.group}</span>
                    {badge > 0 && <span className="pill">{badge}</span>}
                  </Link>
                );
              }

              /* Inside this section, but not on the section itself. */
              const within = g.k === route || items.some((i) => i.k === route);
              const open = flyout?.group.group === g.group;

              return (
                <button
                  key={g.group}
                  type="button"
                  className={'nav-top' + (within ? ' here' : '') + (open ? ' open' : '')}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={(e) => openSection(e, { g, items })}
                >
                  <span className="ic"><Icon n={g.ic} size="lg" /></span>
                  <span className="nav-label">{g.group}</span>
                  {inside > 0 && <span className="pill">{inside}</span>}
                  <span className="nav-caret" aria-hidden="true">
                    <Icon n="next" size="sm" />
                  </span>
                </button>
              );
            })
          )}
        </nav>

        {/*
          * Pinned views, kept small on purpose. This is a shortcut, not a
          * second navigation — at more than a handful it stops being faster
          * than the menu it is shortcutting.
          */}
        {!needle && favourites.length > 0 && (
          <div className="nav-fav">
            <div className="nav-fav-h">Favourites</div>
            {favourites.map((f) => (
              <Link
                key={f.href}
                to={f.href}
                className={'nav-fav-i' + (f.href === here ? ' on' : '')}
              >
                <Icon n="star" size="sm" />
                <span>{f.n}</span>
                <button
                  type="button"
                  className="nav-fav-x"
                  aria-label={`Remove ${f.n} from favourites`}
                  onClick={(e) => { e.preventDefault(); toggleFavourite(f); }}
                >
                  <Icon n="close" size="sm" />
                </button>
              </Link>
            ))}
          </div>
        )}

        <div className="rail-foot">
          <div className="row" style={{ gap: 9 }}>
            <Avatar name={app.me.name} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="nm">{app.me.name}</div>
              <div className="mt">{app.me.designation}</div>
            </div>
            <button className="btn ghost icon sm" onClick={app.toggleTheme}
              title="Toggle theme" aria-label="Toggle theme">
              <Icon n="sparkle" size="lg" />
            </button>
          </div>
        </div>
      </aside>

      {flyout && (
        <NavFlyout
          state={flyout}
          badges={badges}
          isCurrent={isCurrent}
          mobile={mobile}
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
          <main className="content">
            <FavouriteToggle
              here={here}
              isFavourite={isFavourite}
              toggle={toggleFavourite}
            />
            {children}
          </main>
        </PageActionsTarget>
      </div>

      <nav className="tabbar">
        {TABBAR.filter((k) => app.can(k)).map((k) => {
          /*
           * The icon belongs to the section, and a route may be a section
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

/**
 * The star that pins the page you are on.
 *
 * In the content rather than the rail, because it is about *this* page — a
 * control in the menu that acted on something outside the menu would be the
 * wrong place to look for it.
 */
function FavouriteToggle({
  here, isFavourite, toggle,
}: {
  here: string;
  isFavourite: (href: string) => boolean;
  toggle: (f: { href: string; n: string }) => void;
}) {
  /* Only views the menu knows about can be pinned — a pin needs a name. */
  const known = ALL_VIEWS.find((v) => v.href === here);
  if (!known) return null;
  const on = isFavourite(here);

  return (
    <button
      type="button"
      className={'fav-pin' + (on ? ' on' : '')}
      aria-pressed={on}
      title={on ? 'Remove from favourites' : 'Add to favourites'}
      onClick={() => toggle({ href: here, n: known.item.n })}
    >
      <Icon n="star" size="sm" />
      {on ? 'Pinned' : 'Pin this page'}
    </button>
  );
}
