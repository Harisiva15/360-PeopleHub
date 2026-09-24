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

// The probe for "the merge left everything else alone" has to name a method
// that is genuinely unmapped, so it moves as the migration finishes. It was
// `employees.profile` until the server composite filled all eighteen contract
// fields and the drawer started reading it.
//
// `documents.letterContext` is what is left: it carries the salary a letter
// quotes, and printing one with a blank figure is worse than not offering it.
// When that goes live this assertion needs a new probe — and if none remains,
// the migration is done and this check can assert that instead.
check('an unmapped method on the same service is untouched',
  merged.documents.letterContext === mockServices.documents.letterContext);

/*
 * There used to be a third assertion here: that a service nobody had mapped
 * came through the merge as the same object. It had to name a service that
 * was still entirely mock, moved twice as that stopped being true — payroll,
 * then staffing — and was finally rewritten to find one rather than name one,
 * with a note saying to delete it when none was left.
 *
 * None is left. Every one of the 27 services has at least one live method, so
 * there is no whole-service case to test and the assertion above — an unmapped
 * *method* is untouched — is the one that still means something. It is
 * recorded rather than silently removed because "we used to check that" is
 * worth knowing when somebody wonders why nothing catches a merge that drops
 * a service.
 */

check('the mock is not mutated',
  mockServices.employees.visible !== merged.employees.visible);

console.log(`\n${live} method(s) across ${services} service(s) are live`);
console.log(failed ? `${failed} check(s) failed` : 'http service checks passed');
process.exit(failed ? 1 : 0);
