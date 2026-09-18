/*
 * The hybrid Services merge.
 *
 * createHttpServices replaces named methods and leaves the rest alone. If that
 * merge were wrong the failure would be silent — a screen quietly showing mock
 * data while believing it is live — so it is worth asserting directly.
 */
import { mockServices } from '../src/services/mock';
import { createHttpServices, liveMethodCount } from '../src/services/http';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) console.log(`  ok    ${label}`);
  else { failed += 1; console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const merged = createHttpServices(mockServices);
const { live, services } = liveMethodCount();

check('every service still present',
  Object.keys(merged).length === Object.keys(mockServices).length,
  `${Object.keys(merged).length} vs ${Object.keys(mockServices).length}`);

check('a mapped method is replaced',
  merged.employees.visible !== mockServices.employees.visible);

// `profile` is deliberately not mapped — its contract shape carries payroll
// data the server does not hold yet — which makes it the right probe for
// "the merge left everything else alone".
check('an unmapped method on the same service is untouched',
  merged.employees.profile === mockServices.employees.profile);

/*
 * This probe has to name a service that is still entirely mock, or it passes
 * for the wrong reason. It has already had to move twice — payroll, then
 * staffing — so it now finds one rather than naming one, and says so when
 * there is none left to find.
 *
 * When that day comes the assertion is not "fix the check": every service
 * being live is the goal, and at that point the merge has nothing left to
 * leave alone. Delete it then.
 */
const stillMock = (Object.keys(mockServices) as (keyof typeof mockServices)[])
  .filter((k) => merged[k] === mockServices[k]);

check('some service is still entirely mock, so this probe means something',
  stillMock.length > 0,
  'every service is live — this check has done its job and can go');

if (stillMock.length) {
  check(`an untouched service is the same object (${stillMock[0]})`,
    merged[stillMock[0]!] === mockServices[stillMock[0]!]);
}

check('the mock is not mutated',
  mockServices.employees.visible !== merged.employees.visible);

console.log(`\n${live} method(s) across ${services} service(s) are live`);
console.log(failed ? `${failed} check(s) failed` : 'http service checks passed');
process.exit(failed ? 1 : 0);
