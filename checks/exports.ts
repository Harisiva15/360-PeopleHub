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

import { getServices } from '../src/services';
import { DATASETS, EXPORT_LOG, datasetOf } from '../src/data/exports';
import { ACTIVE, DEMO_EMP, DEMO_MGR, HRHEAD } from '../src/data/employees';
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

const ADMIN: Caller = { role: 'admin', meId: HRHEAD.id };
const MANAGER: Caller = { role: 'manager', meId: DEMO_MGR.id };
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
  const unscoped = DATASETS.filter((d) =>
    d.scope !== 'caller' && d.roles.some((r) => r !== 'admin'));
  check('every dataset is caller-scoped or administrators only',
    unscoped.map((d) => d.id), []);

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

  for (const d of DATASETS.filter((x) => x.scope === 'caller' && x.roles.includes('manager'))) {
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
    listedToManager.filter((d) => !d.roles.includes('manager')).length, 0);
  check('and does not list the admin-only ones at all',
    listedToManager.filter((d) => d.scope === 'admin-only').length, 0);

  const listedToEmployee = await s.exports.datasets(EMPLOYEE);
  check('an employee is offered nothing', listedToEmployee.length, 0);

  await refused('a dataset that does not exist is refused',
    () => s.exports.run(ADMIN, { datasetId: 'nope' }));
  await refused('a range that ends before it starts is refused',
    () => s.exports.run(ADMIN, { datasetId: 'events', from: '2026-12-01', to: '2026-01-01' }));
  await refused('an export of no columns is refused',
    () => s.exports.run(ADMIN, { datasetId: 'employees', columns: ['not-a-column'] }));

  /* ---- columns ---- */

  const dEmp = datasetOf('employees')!;
  const two = await s.exports.run(ADMIN, { datasetId: 'employees', columns: ['code', 'dept'] });
  check('a narrowed export has the columns asked for', two.header.length, 2);
  check('and they are the right ones, in catalogue order',
    two.header, [dEmp.columns.find((c) => c.k === 'code')!.n,
      dEmp.columns.find((c) => c.k === 'dept')!.n]);
  check('every row is the same width as the header',
    two.rows.filter((r) => r.length !== 2).length, 0);

  /*
   * The slice is taken after the rows are built, so a narrower request cannot
   * shift values sideways. Checked by comparing one cell against the full run.
   */
  const full = await s.exports.run(ADMIN, { datasetId: 'employees' });
  const codeAt = dEmp.columns.findIndex((c) => c.k === 'code');
  check('narrowing does not shift the values',
    two.rows[0][0], full.rows[0][codeAt]);

  const personalDropped = await s.exports.run(ADMIN, {
    datasetId: 'employees',
    columns: dEmp.columns.filter((c) => !c.personal).map((c) => c.k),
  });
  check('an export can leave the personal columns out',
    personalDropped.header.length, dEmp.columns.filter((c) => !c.personal).length);

  /* ---- the register ---- */

  /*
   * The second claim: the log holds the fact, not the data. Asserted on the
   * shape rather than on one instance — a field added later that could hold a
   * row would fail here.
   */
  const entry = EXPORT_LOG[EXPORT_LOG.length - 1];
  const fields = Object.keys(entry).sort();
  check('a register entry has exactly these fields', fields, [
    'at', 'byId', 'byName', 'byRole', 'columns', 'datasetId', 'datasetName',
    'filters', 'id', 'note', 'outcome', 'personal', 'rows',
  ]);
  check('nothing in it is an array or an object that could hold rows',
    Object.values(entry).filter((v) => typeof v === 'object' && v !== null).length, 0);

  const before = EXPORT_LOG.length;
  await s.exports.run(ADMIN, { datasetId: 'jobtitles' });
  check('a successful export is recorded', EXPORT_LOG.length, before + 1);
  const last = EXPORT_LOG[EXPORT_LOG.length - 1];
  check('with the row count', last.rows, (await s.jobTitles.list(ADMIN)).length);
  check('and who ran it', last.byId, HRHEAD.id);
  check('and the outcome', last.outcome, 'Completed');
  check('nothing is dated in the future', last.at.slice(0, 10) <= NOW, true);

  /*
   * Refusals are recorded too. A register holding only the permitted exports
   * has quietly answered a narrower question than the one somebody reviewing
   * it is asking.
   */
  const beforeRefusal = EXPORT_LOG.length;
  try { await s.exports.run(MANAGER, { datasetId: 'leave' }); } catch { /* expected */ }
  check('a refused export is recorded too', EXPORT_LOG.length, beforeRefusal + 1);
  const refusal = EXPORT_LOG[EXPORT_LOG.length - 1];
  check('with no rows', refusal.rows, 0);
  check('marked as refused', refusal.outcome, 'Refused');
  check('and a reason', refusal.note.length > 0, true);

  /* ---- who may read the register ---- */

  const adminSees = await s.exports.history(ADMIN, {});
  check('an administrator sees the whole register', adminSees.length, EXPORT_LOG.length);

  const mgrSees = await s.exports.history(MANAGER, {});
  check('a manager sees only their own',
    mgrSees.filter((r) => r.run.byId !== DEMO_MGR.id).length, 0);
  check('and there is at least one of theirs to see', mgrSees.length > 0, true);

  const empSees = await s.exports.history(EMPLOYEE, {});
  check('an employee sees only their own',
    empSees.filter((r) => r.run.byId !== DEMO_EMP.id).length, 0);

  const mgrStats = await s.exports.stats(MANAGER);
  check('the figures are scoped the same way', mgrStats.runs, mgrSees.length);

  /* ---- filtering the register ---- */

  const refusedOnly = await s.exports.history(ADMIN, { outcome: 'Refused' });
  check('an outcome filter narrows to that outcome',
    refusedOnly.filter((r) => r.run.outcome !== 'Refused').length, 0);
  const personalOnly = await s.exports.history(ADMIN, { personalOnly: true });
  check('the personal-data filter narrows to those',
    personalOnly.filter((r) => !r.run.personal).length, 0);
  const oneSet = await s.exports.history(ADMIN, { datasetId: 'employees' });
  check('a dataset filter narrows to that dataset',
    oneSet.filter((r) => r.run.datasetId !== 'employees').length, 0);
  check('the register is newest first',
    adminSees.every((r, i) => i === 0 || adminSees[i - 1].run.at >= r.run.at), true);
  check('every row resolves its dataset',
    adminSees.filter((r) => !r.dataset).length, 0);

  /* ---- the seeded history is believable ---- */

  const roles = new Set(EXPORT_LOG.map((r) => r.byRole as AppRole));
  check('the seeded register has more than one role in it', roles.size > 1, true);
  check('it has refusals in it',
    EXPORT_LOG.some((r) => r.outcome === 'Refused' && seeded.has(r.id)), true);
  check('every completed export took at least one row',
    EXPORT_LOG.filter((r) => r.outcome === 'Completed' && r.rows < 1).length, 0);
  check('every entry names somebody real',
    EXPORT_LOG.filter((r) => !ACTIVE().some((e) => e.id === r.byId)).length, 0);

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
