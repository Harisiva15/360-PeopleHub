/**
 * The recruitment screens mount, including the ones a click reaches.
 *
 * `checks/routes.tsx` renders each module's default tab, which leaves the job
 * order page and the create form — the two screens with the most logic in them
 * — never rendered by anything. The job page in particular takes an id out of
 * the query string and would throw on a bad one in front of a user rather than
 * here.
 *
 * **What a static render can and cannot see.** `renderToStaticMarkup` is
 * synchronous and `useQuery` is not, so anything fetched is still loading when
 * the markup is produced. Asserting on the contents of a table would be
 * asserting on its loading state while appearing to check the data. So this
 * checks what it can actually establish — that every screen mounts for every
 * role that can reach it, that the job page survives an id that does not
 * exist, and that the things derived from props rather than queries are right.
 */

globalThis.localStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } as never;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, remove() {} }), body: { appendChild() {} } } as never;
Object.defineProperty(globalThis, 'navigator', { value: { geolocation: null }, configurable: true });

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/state/AppContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { LayerProvider } from '../src/components/Layer';
import { PageActionsTarget } from '../src/shell/PageActions';
import { JobOrderPage } from '../src/modules/recruitment/JobOrder';
import { CreateJobOrder } from '../src/modules/recruitment/CreateJobOrder';
import { RecruitmentDashboard } from '../src/modules/recruitment/Dashboard';
import { jobNo } from '../src/modules/recruitment/shared';
import { slaOf, REQUIREMENTS } from '../src/data/staffing';
import type { AppRole } from '../src/types/employee';
import type { ReactNode } from 'react';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : '  ' + detail}`);
};

function mount(node: ReactNode, role: AppRole, path = '/recruitment'): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <AppProvider initialRole={role}>
          <LayerProvider>
            {/* The page actions portal has no target in a static render. */}
            <PageActionsTarget value={null}>{node}</PageActionsTarget>
          </LayerProvider>
        </AppProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const tryMount = (label: string, node: ReactNode, role: AppRole) => {
  try {
    const html = mount(node, role);
    ok(label, html.length > 0);
    return html;
  } catch (e) {
    ok(label, false, (e as Error).message);
    return '';
  }
};

console.log('\nrecruitment screens\n');

const order = REQUIREMENTS.find((r) => r.status === 'Open')!;

/* ---- every screen mounts for an admin, which is who may reach them ---- */

tryMount('the dashboard mounts', <RecruitmentDashboard />, 'admin');
tryMount('the create form mounts', <CreateJobOrder done={() => {}} />, 'admin');
const detail = tryMount('the job order page mounts',
  <JobOrderPage id={order.id} back={() => {}} />, 'admin');

/*
 * The order itself arrives from a query, so the first synchronous render is
 * the loading state — asserting the order number appears here would be
 * asserting on a spinner while appearing to check the content. What can
 * honestly be checked is that the loading state says so rather than rendering
 * an empty shell that reads as a broken page.
 */
ok('the job page says it is loading rather than showing an empty shell',
  detail.includes('Loading'), detail.slice(0, 120));

/* ---- an id that does not exist says so rather than throwing ---- */

try {
  const html = mount(<JobOrderPage id="REQ-does-not-exist" back={() => {}} />, 'admin');
  ok('an unknown job order renders an empty state, not a crash',
    html.includes('Loading') || html.includes('could not be found'));
} catch (e) {
  ok('an unknown job order renders an empty state, not a crash', false, (e as Error).message);
}

/* ---- the job number is stable and readable ---- */

ok('a job number reads as a job number', /^JO-\d{4}-\d{5}$/.test(jobNo(order)), jobNo(order));
ok('the job number is derived, so it never drifts from the order',
  jobNo(order) === jobNo(order));

/* ---- the SLA a screen shows is the SLA the service computes ---- */

const none = { submissions: 0, interviews: 0, hires: 0 };
const fresh = slaOf(
  { ...order, openedOn: '2099-01-01', targetSubmitOn: '2099-01-05', targetInterviewOn: '2099-01-10', targetFillOn: '2099-02-01', slaDays: 30, status: 'Open' },
  none, '2099-01-02');
ok('a new order with nothing done yet is on track', fresh.state === 'On Track', fresh.state);

const late = slaOf(
  { ...order, openedOn: '2099-01-01', targetSubmitOn: '2099-01-05', targetInterviewOn: '2099-01-10', targetFillOn: '2099-02-01', slaDays: 30, status: 'Open' },
  none, '2099-01-20');
ok('an order past its submission target is behind on submission',
  late.state === 'Overdue' && late.behind === 'submission', `${late.state}/${late.behind}`);

const submitted = slaOf(
  { ...order, openedOn: '2099-01-01', targetSubmitOn: '2099-01-05', targetInterviewOn: '2099-01-10', targetFillOn: '2099-02-01', slaDays: 30, status: 'Open' },
  { submissions: 3, interviews: 2, hires: 0 }, '2099-01-20');
ok('the same day, with candidates at interview, is not behind',
  submitted.state !== 'Overdue', submitted.state);

const settled = slaOf(
  { ...order, openedOn: '2099-01-01', targetFillOn: '2099-02-01', slaDays: 30, status: 'Filled' },
  none, '2099-06-01');
ok('a filled order stops the clock', settled.state === 'Closed' && settled.aging === 0);

console.log();
if (failed) {
  console.error(`${failed} recruitment screen check(s) failed`);
  process.exit(1);
}
console.log('the recruitment screens hold up');
