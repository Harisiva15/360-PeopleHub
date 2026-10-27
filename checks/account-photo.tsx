/**
 * The photo card is on the account screen for everybody, always.
 *
 * ## What happened
 *
 * `ProfilePhoto` is the only control in the product that can upload a photo,
 * and the account screen rendered it as `{me && <ProfilePhoto …>}` where `me`
 * is `useVisiblePeople().byId(app.meId)` — a lookup for yourself in the list
 * of everyone. In production that list came back without the signed-in
 * company administrator, so the card never rendered and there was no way to
 * upload a photo anywhere in the app. The "Signed in as" tile went blank from
 * the same cause.
 *
 * ## Why this is a render check and not an e2e
 *
 * The Playwright suite drives the demo build, where the directory contains
 * the demo people and the lookup succeeds — so an e2e asserting "the card is
 * there" passes whether or not the bug exists. The thing worth asserting is
 * that the card survives a directory that answers *nothing*, which is a state
 * the demo cannot produce. So the directory is emptied here, deliberately,
 * and the card has to still be there.
 *
 * There is an e2e as well, for both roles, because it proves the whole screen
 * renders rather than just this fragment. The two tests catch different
 * things: that one would have passed through the outage.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/state/AppContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { LayerProvider } from '../src/components/Layer';
import { setServices, getServices } from '../src/services';
import type { AppRole } from '../src/types/employee';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
};

const { loadAllRoutes } = await import('../src/modules');
await loadAllRoutes();
const { getModule } = await import('../src/modules/registry');

const accountModule = getModule('account');
ok('0. the account route is registered', Boolean(accountModule?.Component));
const Account = accountModule?.Component ?? null;

const render = (role: AppRole) => renderToStaticMarkup(
  <MemoryRouter initialEntries={['/account']}>
    <AuthProvider>
      <AppProvider initialRole={role}>
        <LayerProvider>{Account ? <Account /> : null}</LayerProvider>
      </AppProvider>
    </AuthProvider>
  </MemoryRouter>,
);

console.log(`${NL}the card is there for every role${NL}`);

for (const role of ['company_admin', 'hr_admin', 'finance_admin', 'employee'] as AppRole[]) {
  const html = render(role);
  ok(`1. ${role.padEnd(14)} sees the photo card`, /Your photo/.test(html),
    html.slice(0, 200));
}

/* ===========================================================================
 * The case the e2e cannot reach: a directory that answers nothing
 * ======================================================================== */

console.log(`${NL}and when the directory cannot find you at all${NL}`);

const real = getServices();
/*
 * Every employee read answers empty, which is the production state that broke
 * this: `/employees` came back without the caller. Nothing else is stubbed —
 * the identity still resolves, because that is the point: the screen knows who
 * you are from `/me` and must not need the directory to agree.
 */
setServices({
  ...real,
  employees: {
    ...real.employees,
    visible: () => Promise.resolve([]),
    active: () => Promise.resolve([]),
    byIds: () => Promise.resolve([]),
  },
});

try {
  const blind = render('company_admin');
  ok('2. the photo card is still rendered', /Your photo/.test(blind),
    'gating it on a directory lookup for yourself is what removed it');
  ok('3.  with an upload control', /Upload|Replace/.test(blind), blind.slice(0, 300));
  ok('4.  and the screen does not fall over', blind.length > 400, `${blind.length} chars`);
} finally {
  setServices(real);
}

/* ===========================================================================
 * The source rule, so the indirection cannot come back
 * ======================================================================== */

const { readFileSync } = await import('node:fs');
const src = readFileSync('src/modules/account/index.tsx', 'utf8');

ok('5. the card is gated on app.meId', /\{app\.meId &&/.test(src));
ok('6.  and not on a directory lookup',
  !/\{me &&\s*<ProfilePhoto/.test(src),
  'finding yourself in a list of everyone is not how you identify yourself');
ok('7. the identity tile prefers the server\'s answer to the directory',
  /app\.identity\?\.name \?\? me\?\.name/.test(src));

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`everybody can reach their own photo${NL}`);
process.exit(0);
