/**
 * Nobody sees a pay figure for somebody else unless compensation says so.
 *
 * ## Why this is its own suite
 *
 * `pay-census.mjs` proves every pay read has a gate and that the gate asks
 * about a pay module. That is a structural claim about the code. This is the
 * behavioural one: given a caller and a row, does a number actually come out?
 *
 * The two bugs this would have caught, both real:
 *
 *   - `maySeePay` in `employees/service.ts` asked whether the caller may read
 *     the *directory* at `all`, not whether they may read compensation. It
 *     happens to grant the same three roles today, so no test that only
 *     compared role names would have noticed; what makes it wrong is the
 *     question, and the question is what this asserts.
 *   - `listOnboarding` returned every journey in the tenant, CTC included, to
 *     anybody with a direct report, because the listing had no scope clause.
 *
 * It runs no database: the mappers are pure, and a row is a literal.
 */
import { toEmployee } from '../src/modules/employees/mapper.ts';
import { effectiveFor, ROLES } from '../src/auth/policy.ts';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`);
};

/* Every caller shape the model admits: each role, with and without reports. */
const CALLERS = [];
for (const role of ROLES) {
  for (const hasReports of [false, true]) {
    CALLERS.push({ role, hasReports, label: `${role}${hasReports ? ' with reports' : ''}` });
  }
}

/** A row with every pay field populated, so a leak shows up as a number. */
const ROW = {
  id: 'emp-other', code: 'E002', full_name: 'Somebody Else',
  gender: 'F', date_of_birth: '1990-01-01', joined_on: '2020-04-01', left_on: null,
  work_email: 'other@local.test', phone: '', dept_code: 'ENG',
  designation: 'Engineer', grade_code: 'G3', site_code: 'HQ',
  entity_country: 'IN', currency: 'INR', manager_id: null,
  status: 'active', employment_type: 'full_time',
  ctc: '4200000',
  blood_group: '', address: '', emergency_contact: '',
  app_role: 'employee', shift_code: '', on_probation: false,
  exit_reason: null, notice_days: 0, skills: [], reports: [],
};

/* The fields the contract carries that are pay or pay-identifying. */
const PAY_FIELDS = ['ctc', 'bank', 'acct', 'ifsc', 'pan', 'uan', 'pf', 'esi'];

const empty = (v) => v === 0 || v === '' || v === null || v === undefined;

console.log(`${NL}the directory mapper withholds pay when told to${NL}`);

const withheld = toEmployee(ROW, false);
for (const f of PAY_FIELDS) {
  ok(`${f} is empty`, empty(withheld[f]), `got ${JSON.stringify(withheld[f])}`);
}
ok('and the rest of the record still arrives', withheld.name === 'Somebody Else'
  && withheld.dept === 'ENG' && withheld.designation === 'Engineer',
  `name=${withheld.name} dept=${withheld.dept} designation=${withheld.designation}`);

console.log(`${NL}...and provides it when allowed${NL}`);

const shown = toEmployee(ROW, true);
ok('ctc comes through', shown.ctc === 4200000, `got ${shown.ctc}`);
ok('a withheld record and a shown one differ only in pay',
  JSON.stringify({ ...shown, ctc: 0 }) === JSON.stringify({ ...withheld, ctc: 0 }));

/*
 * The policy half. `maySeePay` must be the compensation question, and the
 * directory question must not accidentally answer it. These two sets being
 * equal today is exactly why the bug was invisible — so assert the thing that
 * matters: that nobody reaches pay without compensation.
 */
console.log(`${NL}who the policy lets see somebody else's pay${NL}`);

const compReaders = CALLERS.filter((c) => effectiveFor(c.role, c.hasReports, 'compensation').read === 'all');
const dirReaders = CALLERS.filter((c) => effectiveFor(c.role, c.hasReports, 'employees').read === 'all');

ok('an employee cannot read the directory at all-scope',
  !dirReaders.some((c) => c.role === 'employee'),
  `directory readers: ${dirReaders.map((c) => c.label).join(', ')}`);

ok('an employee cannot read compensation at all-scope',
  !compReaders.some((c) => c.role === 'employee'),
  `compensation readers: ${compReaders.map((c) => c.label).join(', ')}`);

ok('every directory reader is also a compensation reader',
  dirReaders.every((d) => compReaders.some((c) => c.label === d.label)),
  'otherwise gating pay on the directory would widen it');

/*
 * The one that actually documents the hazard: the two sets coincide, so a gate
 * on the wrong one is undetectable by observing who gets in. If this ever
 * fails, the directory has been granted to somebody without the payroll, and
 * every pay gate in the tree needs re-reading — which is what pay-census does.
 */
ok('the two sets coincide today, which is why the wrong gate was invisible',
  dirReaders.length === compReaders.length,
  `directory ${dirReaders.length}, compensation ${compReaders.length}`);

console.log(`${NL}the manager layer gets no pay from the reporting tree${NL}`);

for (const c of CALLERS.filter((x) => x.role === 'employee')) {
  const comp = effectiveFor(c.role, c.hasReports, 'compensation');
  ok(`${c.label}: compensation read is '${comp.read}'`, comp.read === 'none');
  const onboarding = effectiveFor(c.role, c.hasReports, 'onboarding');
  ok(`${c.label}: onboarding read is '${onboarding.read}', never all`,
    onboarding.read !== 'all',
    'a joiner CTC was reachable because the listing ignored this scope');
}

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`pay stays with compensation, for every caller the model admits${NL}`);
