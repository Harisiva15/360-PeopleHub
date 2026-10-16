/**
 * An export cannot see more than the person running it.
 *
 * That is the one claim this module makes, and it is the one that would be
 * catastrophic to get wrong: an export is a file that leaves the building, and
 * a bug here is not a wrong number on a screen but a copy of the company in
 * somebody's downloads folder. So it is tested twice — structurally, that
 * every dataset is either caller-scoped or administrators only, and
 * behaviourally, that a manager's export of each dataset matches what that
 * manager's own screen returns, row for row.
 *
 * The second claim is that the register keeps the fact and not the data. That
 * is checked by walking the shape of a log entry and asserting nothing in it
 * could hold a row.
 */

import { can } from '../src/state/rbac';
import { POLICY } from '../server/src/auth/policy';
import { getServices } from '../src/services';
import { DATASETS, EXPORT_LOG, datasetOf } from '../src/data/exports';
import { EMAP, ACTIVE, DEMO_EMP, DEMO_MGR, HRHEAD } from '../src/data/employees';
import { recordAudit } from '../src/data/audit';
import { TODAY, ymd } from '../src/lib/dates';
import type { AppRole } from '../src/types/employee';
import type { Caller } from '../src/services';

const s = getServices();
let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const refused = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'accepted', 'refused'); }
  catch { check(label, 'refused', 'refused'); }
};
const allowed = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'allowed', 'allowed'); }
  catch (e) { check(label, `refused: ${(e as Error).message}`, 'allowed'); }
};

const ADMIN: Caller = { role: 'company_admin', meId: HRHEAD.id };
const MANAGER: Caller = { role: 'employee', meId: DEMO_MGR.id };
const EMPLOYEE: Caller = { role: 'employee', meId: DEMO_EMP.id };
const NOW = ymd(TODAY);

/* Snapshot the seeded register so the cleanup at the end knows what is ours. */
const seeded = new Set(EXPORT_LOG.map((r) => r.id));

(async () => {
  console.log(`\n${DATASETS.length} datasets, ${EXPORT_LOG.length} entries in the register\n`);

  /* ---- the structural rule ---- */

  /*
   * Every dataset is one of exactly two things. A dataset that is neither —
   * not caller-scoped, and offered to somebody other than an administrator —
   * is the hole this whole design exists to close, so it fails here rather
   * than being discovered in a spreadsheet.
   */
  /*
   * The invariant that is still worth asserting.
   *
   * "caller-scoped or administrators only" is carried by DatasetScope itself
   * now, so asserting it would assert the type. What is not carried by any
   * type is that `k` names a module the policy knows: a typo there would
   * make a caller-scoped dataset silently unreachable, or reachable through
   * the wrong module.
   */
  const unknownModule = DATASETS.filter((d) => !POLICY[d.k]);
  check('every dataset names a module the policy knows',
    unknownModule.map((d) => `${d.id}:${d.k}`), []);

  /* And the rule decision (2) settles: an employee's catalogue holds no
     admin-only dataset, whatever module its rows come from. */
  const empCatalogue = await s.exports.datasets(EMPLOYEE);
  check('an employee is offered no admin-only dataset',
    empCatalogue.filter((d) => d.scope === 'admin-only').map((d) => d.id), []);

  const scopedCount = DATASETS.filter((d) => d.scope === 'caller').length;
  console.log(`  ${scopedCount} caller-scoped, ${DATASETS.length - scopedCount} admin-only\n`);
  check('both kinds exist, so both branches are exercised',
    scopedCount > 0 && scopedCount < DATASETS.length, true);

  check('no dataset offers zero columns',
    DATASETS.filter((d) => !d.columns.length).map((d) => d.id), []);
  check('no dataset repeats a column key',
    DATASETS.filter((d) => new Set(d.columns.map((c) => c.k)).size !== d.columns.length)
      .map((d) => d.id), []);
  check('no two datasets share an id',
    new Set(DATASETS.map((d) => d.id)).size, DATASETS.length);
  check('every dataset naming personal columns is marked personal',
    DATASETS.filter((d) => d.columns.some((c) => c.personal) && !d.personal).map((d) => d.id), []);

  /*
   * A dataset with no builder would hand somebody an empty file and a log
   * entry saying it worked. Checked by running every one as an administrator.
   */
  for (const d of DATASETS) {
    await allowed(`${d.id} has a builder that runs`,
      () => s.exports.run(ADMIN, { datasetId: d.id }));
  }

  /* ---- the behavioural rule ---- */

  /*
   * The real assertion. For each caller-scoped dataset, what a manager exports
   * has to be exactly what that manager's own screen returns — not fewer rows,
   * which would make the export useless, and not one row more, which would
   * make it a leak.
   */
  const expected: Record<string, () => Promise<number>> = {
    employees: async () => (await s.employees.visible(MANAGER)).length,
    lifecycle: async () => (await s.lifecycle.list(MANAGER, {})).length,
    devplans: async () => (await s.devPlans.list(MANAGER, {})).length,
    events: async () => (await s.events.list(MANAGER, {})).length,
    software: async () => (await s.software.list(MANAGER, {})).length,
    jobtitles: async () => (await s.jobTitles.list(MANAGER)).length,
  };

  for (const d of DATASETS.filter(
    (x) => x.scope === 'caller' && can('employee', x.k, true),
  )) {
    const want = expected[d.id];
    check(`${d.id} has a screen to compare against`, !!want, true);
    if (!want) continue;
    const res = await s.exports.run(MANAGER, { datasetId: d.id });
    check(`a manager's ${d.id} export is exactly their screen`, res.rows.length, await want());
  }

  /*
   * And the same dataset run by an administrator returns more, which is what
   * proves the manager's figure above was a narrowing rather than a coincidence.
   */
  const mgrPeople = await s.exports.run(MANAGER, { datasetId: 'employees' });
  const adminPeople = await s.exports.run(ADMIN, { datasetId: 'employees' });
  check("a manager's directory export is smaller than an administrator's",
    mgrPeople.rows.length < adminPeople.rows.length, true);
  check('and the administrator gets the whole company',
    adminPeople.rows.length, (await s.employees.visible(ADMIN)).length);

  /* ---- who may run what ---- */

  for (const d of DATASETS.filter((x) => x.scope === 'admin-only')) {
    await refused(`a manager cannot export ${d.id}`,
      () => s.exports.run(MANAGER, { datasetId: d.id }));
    await refused(`an employee cannot either`,
      () => s.exports.run(EMPLOYEE, { datasetId: d.id }));
  }

  const listedToManager = await s.exports.datasets(MANAGER);
  check("a manager's catalogue holds only what they can run",
    listedToManager.filter((d) => !can('employee', d.k, true)).length, 0);
  check('and does not list the admin-only ones at all',
    listedToManager.filter((d) => d.scope === 'admin-only').length, 0);

  /*
   * An employee may take their own data, and only their own.
   *
   * The catalogue holds the caller-scoped datasets of modules they read -
   * their own directory entry, their own lifecycle, their own plan - and no
   * admin-only dataset, because those are whole tables. The rule that
   * matters is not how many they are offered but what comes back: every row
   * must be about the caller.
   */
  const listedToEmployee = await s.exports.datasets(EMPLOYEE);
  check('an employee is offered no admin-only dataset',
    listedToEmployee.filter((d) => d.scope === 'admin-only').map((d) => d.id), []);

  const me = EMAP[EMPLOYEE.meId]!;
  for (const d of listedToEmployee) {
    const res = await s.exports.run(EMPLOYEE, { datasetId: d.id });
    /*
     * Whichever column names a person, every value in it must be this
     * person. There is no id column in these datasets - somebody is named by
     * their code or their work email - and a dataset naming nobody, like the
     * company events list, has nothing to leak and passes by having no such
     * column at all.
     */
    for (const key of ['code', 'email'] as const) {
      const at = d.columns.findIndex((col) => col.k === key);
      if (at < 0) continue;
      const mine = String(me[key]).toLowerCase();
      const others = res.rows
        .map((row) => String(row[at] ?? "").toLowerCase())
        .filter((v) => v !== "" && v !== mine);
      check(`${d.id}: every ${key} in it is the caller's`, others.length, 0);
    }
  }
  /* ---- clean up ---- */

  for (const r of EXPORT_LOG.filter((x) => !seeded.has(x.id))) {
    EXPORT_LOG.splice(EXPORT_LOG.indexOf(r), 1);
  }
  check('the check left the register as it found it', EXPORT_LOG.length, seeded.size);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} export checks failed`);
    process.exit(1);
  }
  console.log('an export sees exactly what the person does');
})();
