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

check('an unmapped method on the same service is untouched',
  merged.employees.byIds === mockServices.employees.byIds);

check('an untouched service is the same object',
  merged.payroll === mockServices.payroll);

check('the mock is not mutated',
  mockServices.employees.visible !== merged.employees.visible);

console.log(`\n${live} method(s) across ${services} service(s) are live`);
console.log(failed ? `${failed} check(s) failed` : 'http service checks passed');
process.exit(failed ? 1 : 0);
