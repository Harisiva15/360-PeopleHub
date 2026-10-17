/**
 * A saved report is a question, not an answer.
 *
 * That is the one claim this module makes and the only one worth testing
 * hard: the same shared report, run by two different people, must return two
 * different sets of rows — theirs. If it ever returns the author's rows to a
 * reader, sharing a report becomes a way to hand somebody data they could not
 * otherwise reach, silently, with the permissions left behind.
 *
 * The second claim is arithmetic: a grouped report's counts have to add up to
 * the rows it grouped. A summary that quietly drops rows is the kind of wrong
 * that gets presented to a board.
 */

import { getServices } from '../src/services';
import { REPORT_DEFS } from '../src/data/reportdefs';
import { DATASETS } from '../src/data/exports';
import { EXPORT_LOG } from '../src/data/exports';
import { DEMO_EMP, DEMO_MGR, HRHEAD } from '../src/data/employees';
import { recordAudit } from '../src/data/audit';
import type { Caller, ReportDraft } from '../src/services';

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

const seeded = new Set(REPORT_DEFS.map((r) => r.id));

(async () => {
  console.log(`\n${REPORT_DEFS.length} saved reports over ${DATASETS.length} datasets\n`);

  /* ---- a report stores no rows ---- */

  /*
   * Checked on the shape rather than one instance. A field added later that
   * could hold a result set fails here, which is the point.
   */
  const def = REPORT_DEFS[0]!;
  check('a saved report has exactly these fields', Object.keys(def).sort(), [
    'columns', 'createdOn', 'datasetId', 'desc', 'filters', 'groupBy', 'id',
    'lastRunOn', 'measures', 'n', 'ownerId', 'runCount', 'shared', 'sort',
  ]);
  check('nothing in it holds rows',
    REPORT_DEFS.filter((r) => 'rows' in r || 'results' in r || 'data' in r).length, 0);
  check('every report names a dataset that exists',
    REPORT_DEFS.filter((r) => !DATASETS.some((d) => d.id === r.datasetId)).length, 0);

  /* ---- the load-bearing rule ---- */

  const shared = REPORT_DEFS.find((r) => r.shared && r.datasetId === 'employees')
    ?? REPORT_DEFS.find((r) => r.shared)!;
  check('there is a shared report to test with', !!shared, true);

  const asAdmin = await s.reports.run(ADMIN, shared.id);
  const asManager = await s.reports.run(MANAGER, shared.id);

  /*
   * The same definition, two readers, two answers. Equal totals would mean the
   * report had resolved once and been handed round.
   */
  check('the same shared report returns fewer rows to a manager',
    asManager.total < asAdmin.total, true);
  check('and it is the same definition being run',
    asManager.report.id, asAdmin.report.id);

  /*
   * And the narrowing is exactly the export centre's, not a second rule that
   * happens to be tighter today.
   */
  const mgrExport = await s.exports.run(MANAGER, { datasetId: shared.datasetId });
  check("a manager's report totals match a manager's export",
    asManager.total, mgrExport.rows.length);

  /* ---- the arithmetic ---- */

  const grouped = REPORT_DEFS.find((r) => r.groupBy && r.measures.some((m) => m.col === '*'))!;
  check('there is a grouped report to check', !!grouped, true);
  if (grouped) {
    const res = await s.reports.run(ADMIN, grouped.id);
    check('it came back grouped', res.grouped, true);
    const counted = res.rows.reduce((n, row) => n + Number(row[1] ?? 0), 0);
    /*
     * Every row lands in exactly one group. A summary that drops rows or
     * double-counts them is the failure worth catching, and it is invisible on
     * screen because each number looks plausible on its own.
     */
    check('the group counts add up to the rows grouped', counted, res.total);
    check('no group is empty', res.rows.filter((row) => Number(row[1] ?? 0) === 0).length, 0);
    check('a group key appears once',
      new Set(res.rows.map((row) => row[0])).size, res.rows.length);
  }

  const flat = REPORT_DEFS.find((r) => !r.groupBy)!;
  if (flat) {
    const res = await s.reports.run(ADMIN, flat.id);
    check('a flat report returns rows, not groups', res.grouped, false);
    check('every row is as wide as the header',
      res.rows.filter((row) => row.length !== res.header.length).length, 0);
  }

  /* ---- filters ---- */

  const filtered = REPORT_DEFS.find((r) => r.filters.length > 0)!;
  if (filtered) {
    const res = await s.reports.run(ADMIN, filtered.id);
    const unfiltered = await s.exports.run(ADMIN, { datasetId: filtered.datasetId });
    check('a filtered report returns no more than the dataset',
      res.total <= unfiltered.rows.length, true);
  }

  /* ---- who may do what ---- */

  await refused('an employee cannot list reports', () => s.reports.list(EMPLOYEE));
  await refused('nor build one', () => s.reports.create(EMPLOYEE, {
    n: 'Check report', datasetId: 'employees',
  }));

  const mgrList = await s.reports.list(MANAGER);
  check('a manager sees shared reports and their own',
    mgrList.filter((r) => !r.report.shared && !r.mine).length, 0);

  const privateOther = REPORT_DEFS.find((r) => !r.shared && r.ownerId !== DEMO_MGR.id);
  if (privateOther) {
    await refused("a manager cannot run somebody else's private report",
      () => s.reports.run(MANAGER, privateOther.id));
  }

  /*
   * There is no `get`. The list carries every field a report has, so a
   * single-report read would have been surface nothing called — which is what
   * checks/reachable.ts said about it. Running an id that does not exist is
   * still worth asserting, through the method that does exist.
   */
  await refused('running a report that does not exist is refused',
    () => s.reports.run(ADMIN, 'RPT-does-not-exist'));

  /* ---- building one ---- */

  const base = (over: Partial<ReportDraft> = {}): ReportDraft => ({
    n: `Check report ${Math.random().toString(36).slice(2, 7)}`,
    datasetId: 'employees',
    ...over,
  });

  await refused('a report with no name is refused', () => s.reports.create(ADMIN, base({ n: ' ' })));
  await refused('a report on nothing is refused',
    () => s.reports.create(ADMIN, base({ datasetId: '' })));
  await refused('a column the dataset does not have is refused',
    () => s.reports.create(ADMIN, base({ columns: ['nope'] })));
  await refused('grouping by a column it does not have is refused',
    () => s.reports.create(ADMIN, base({ groupBy: 'nope' })));
  await refused('summarising without grouping is refused',
    () => s.reports.create(ADMIN, base({ measures: [{ col: '*', agg: 'count' }] })));
  await refused('an unknown way to summarise is refused',
    () => s.reports.create(ADMIN, base({
      groupBy: 'dept', measures: [{ col: '*', agg: 'median' as never }],
    })));
  await refused('a filter on a column it does not have is refused',
    () => s.reports.create(ADMIN, base({
      filters: [{ col: 'nope', op: 'is', value: 'x' }],
    })));

  /*
   * A manager cannot build a report on a dataset their role cannot export.
   * Without this the builder would be a way around the export catalogue.
   */
  const adminOnlyDs = DATASETS.find((d) => d.roles.length === 1 && d.roles[0] === 'admin')!;
  await refused('a manager cannot report on an administrators-only dataset',
    () => s.reports.create(MANAGER, base({ datasetId: adminOnlyDs.id })));

  const made = await s.reports.create(ADMIN, base({ groupBy: 'dept' }));
  check('a new report starts private', made.shared, false);
  check('and unrun', made.runCount, 0);
  check('and belongs to whoever wrote it', made.ownerId, HRHEAD.id);

  await s.reports.run(ADMIN, made.id);
  check('running it counts the run',
    REPORT_DEFS.find((r) => r.id === made.id)!.runCount, 1);
  check('and dates it', REPORT_DEFS.find((r) => r.id === made.id)!.lastRunOn !== null, true);

  /*
   * Running a report is an export underneath, so the export register records
   * it. That is deliberate: a report is not a side door around the audit.
   */
  check('running a report leaves a trace in the export register',
    EXPORT_LOG.some((e) => e.datasetId === made.datasetId && e.byId === HRHEAD.id), true);

  /* ---- editing and duplicating ---- */

  await refused("a manager cannot edit somebody else's report",
    () => s.reports.update(MANAGER, made.id, { n: 'Not theirs' }));
  await allowed('the owner can', () => s.reports.update(ADMIN, made.id, { desc: 'Set by the check' }));

  const copy = await s.reports.duplicate(MANAGER, shared.id);
  check('duplicating gives the copy to whoever copied it', copy.ownerId, DEMO_MGR.id);
  check('and the copy is private', copy.shared, false);
  check('and it has not been run', copy.runCount, 0);
  check('the original is untouched',
    REPORT_DEFS.find((r) => r.id === shared.id)!.ownerId, shared.ownerId);

  await refused("a manager cannot delete somebody else's report",
    () => s.reports.remove(MANAGER, made.id));
  await allowed('but can delete their own copy', () => s.reports.remove(MANAGER, copy.id));
  await allowed('and an administrator can delete any', () => s.reports.remove(ADMIN, made.id));

  /* ---- clean up ---- */

  for (const r of REPORT_DEFS.filter((x) => !seeded.has(x.id))) {
    REPORT_DEFS.splice(REPORT_DEFS.indexOf(r), 1);
  }
  check('the check left no reports behind', REPORT_DEFS.length, seeded.size);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} report checks failed`);
    process.exit(1);
  }
  console.log('a report answers whoever asks it');
})();
