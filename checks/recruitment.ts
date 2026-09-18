/**
 * The recruitment service — what it refuses, and what it keeps consistent.
 *
 * The rules here are the ones migration 0029 enforces in the database. The
 * point of asserting them against the mock too is that the screens are written
 * against the mock: a refusal the server makes and the mock does not is a bug
 * that only appears in production.
 */

import { getServices } from '../src/services';
import { CLIENTS, JOB_ACTIVITY, REQUIREMENTS } from '../src/data/staffing';
import { ACTIVE, DEMO_MGR } from '../src/data/employees';

const s = getServices();
let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const refused = async (label: string, run: () => Promise<unknown>) => {
  try {
    await run();
    check(label, 'accepted', 'refused');
  } catch {
    check(label, 'refused', 'refused');
  }
};

(async () => {
  const client = CLIENTS.find((c) => c.status === 'Active')!;
  const recruiters = ACTIVE().filter((e) => e.dept === 'HR');

  /* ---- creating ---- */

  const base = {
    clientId: client.id,
    title: 'Senior Data Engineer — Service check',
    role: 'Data Engineer',
    jobType: 'Contract' as const,
    employmentType: 'W2' as const,
    priority: 'High' as const,
    positions: 2,
    location: 'Dallas, TX',
    workMode: 'Hybrid' as const,
    billRate: 120,
    payRate: 90,
    slaDays: 30,
  };

  const made = await s.recruitment.createJobOrder(base);
  check('a new order starts as a draft', made.status, 'Draft');
  check('a draft has nobody on the desk', made.recruiterId, '');
  check('the markup is derived from the rates on creation', made.markupPct, 33.3);
  check('the SLA targets run in order',
    made.targetSubmitOn <= made.targetInterviewOn
      && made.targetInterviewOn <= made.targetFillOn, true);
  check('the fill target is the SLA out from opening',
    made.targetFillOn, made.closeBy);

  await refused('a pay rate above the bill rate is refused',
    () => s.recruitment.createJobOrder({ ...base, payRate: 130 }));
  await refused('an order with no title is refused',
    () => s.recruitment.createJobOrder({ ...base, title: '  ' }));
  await refused('an order for no positions is refused',
    () => s.recruitment.createJobOrder({ ...base, positions: 0 }));
  await refused('an unknown client is refused',
    () => s.recruitment.createJobOrder({ ...base, clientId: 'CL-nope' }));
  await refused('a salary band that runs backwards is refused',
    () => s.recruitment.createJobOrder({
      ...base, jobType: 'Full Time', payRate: null, salaryMin: 200000, salaryMax: 100000 }));

  const perm = await s.recruitment.createJobOrder({
    ...base, jobType: 'Full Time', employmentType: 'Direct Hire',
    payRate: null, salaryMin: 90000, salaryMax: 140000,
  });
  check('a permanent order carries a band and no rates',
    [perm.payRate, perm.markupPct, perm.salaryMin], [null, null, 90000]);

  /* ---- the desk ---- */

  const first = recruiters[0].id;
  const second = recruiters[1].id;

  let d = await s.recruitment.assign(made.id, {
    recruiterId: first, role: 'primary', targetSubmissions: 4, targetHires: 2,
  });
  check('assigning a primary puts one person on the desk',
    d.assignments.filter((a) => a.role === 'primary').length, 1);
  check("the order's named recruiter follows the primary",
    d.order.recruiterId, first);
  check('assigning writes a line to the history',
    d.activity[0].kind, 'assigned');

  await refused('a target above what the client will read is refused',
    () => s.recruitment.assign(made.id, {
      recruiterId: first, role: 'primary', targetSubmissions: 99 }));
  await refused('assigning an unknown employee is refused',
    () => s.recruitment.assign(made.id, { recruiterId: 'EMP-nope', role: 'backup' }));

  /* Re-assigning the same person is an edit, not a reassignment. */
  const before = d.activity.length;
  d = await s.recruitment.assign(made.id, {
    recruiterId: first, role: 'primary', targetSubmissions: 5,
  });
  check('re-targeting the same person is an edit, not a reassignment',
    d.activity.length, before);
  check('the new target stuck',
    d.assignments.find((a) => a.role === 'primary')!.targetSubmissions, 5);

  /* Replacing releases the incumbent rather than deleting them. */
  d = await s.recruitment.assign(made.id, { recruiterId: second, role: 'primary' });
  check('replacing the primary leaves exactly one live primary',
    d.assignments.filter((a) => a.role === 'primary').length, 1);
  check('the replacement is on the desk',
    d.assignments.find((a) => a.role === 'primary')!.recruiterId, second);
  check('the reassignment is recorded',
    d.activity.some((a) => a.kind === 'reassigned'), true);

  d = await s.recruitment.assign(made.id, { recruiterId: first, role: 'backup' });
  check('a backup sits alongside the primary',
    d.assignments.filter((a) => !a.releasedOn).length, 2);

  const backup = d.assignments.find((a) => a.role === 'backup')!;
  d = await s.recruitment.release(made.id, backup.id);
  check('releasing the backup leaves the primary alone',
    d.assignments.filter((a) => !a.releasedOn).map((a) => a.role), ['primary']);

  const primary = d.assignments.find((a) => a.role === 'primary')!;
  await refused('an order cannot be left without a primary',
    () => s.recruitment.release(made.id, primary.id));
  await refused('an assignment cannot be released twice',
    () => s.recruitment.release(made.id, backup.id));

  /* ---- the history ---- */

  const act = await s.recruitment.logActivity(made.id, 'sourced', '20 candidates sourced', 20);
  check('a sourcing line carries its count', act.qty, 20);
  await refused('an empty summary is refused',
    () => s.recruitment.logActivity(made.id, 'note', '   '));
  await refused('an unknown activity kind is refused',
    () => s.recruitment.logActivity(made.id, 'vibes' as never, 'something'));
  await refused('activity on an unknown order is refused',
    () => s.recruitment.logActivity('REQ-nope', 'note', 'hello'));

  const detail = (await s.recruitment.jobOrder(made.id))!;
  check('the history is newest first',
    detail.activity.every((a, i) => i === 0 || detail.activity[i - 1].at >= a.at), true);
  check('the sourced count reaches the order detail', detail.counts.sourced, 20);

  /* ---- status changes are recorded ---- */

  const opened = await s.recruitment.updateJobOrder(made.id, { status: 'Open' });
  check('the order opens', opened.status, 'Open');
  const afterOpen = (await s.recruitment.jobOrder(made.id))!;
  check('opening the order is recorded',
    afterOpen.activity.some((a) => a.kind === 'status_changed'), true);

  /*
   * Read the target before revising, not after: the mock hands back the live
   * row, so a reference captured earlier moves with it.
   */
  const fillBefore = opened.targetFillOn;
  await s.recruitment.updateJobOrder(made.id, { slaDays: 60 });
  const afterSla = (await s.recruitment.jobOrder(made.id))!;
  check('revising the SLA moves every target',
    afterSla.order.targetFillOn > fillBefore, true);
  check('revising the SLA is recorded',
    afterSla.activity.some((a) => a.kind === 'sla_changed'), true);
  check('the revised targets still run in order',
    afterSla.order.targetSubmitOn <= afterSla.order.targetInterviewOn
      && afterSla.order.targetInterviewOn <= afterSla.order.targetFillOn, true);

  /* ---- my jobs ---- */

  const mine = await s.recruitment.myJobs(second);
  check('an order I hold appears in my jobs',
    mine.some((x) => x.order.id === made.id), true);
  const notMine = await s.recruitment.myJobs(DEMO_MGR.id);
  check('an order I do not hold does not',
    notMine.some((x) => x.order.id === made.id), false);

  /* ---- the dashboard agrees with the funnel ---- */

  const kpi = await s.recruitment.kpi();
  const funnel = await s.recruitment.funnel();
  check('the tile and the funnel agree on open requirements',
    kpi.openJobs, funnel.openRequirements);
  check('the tile and the funnel agree on hires', kpi.hires, funnel.hired);

  /* A funnel that goes up between stages is not a funnel. */
  const stages = [funnel.submitted, funnel.clientReview, funnel.interview, funnel.offer, funnel.hired];
  check('the funnel never widens as it descends',
    stages.every((n, i) => i === 0 || n <= stages[i - 1]), true);
  check('nothing is screened that was not sourced', funnel.screened <= funnel.sourced, true);

  /* ---- a filter narrows the tiles and the funnel together ---- */

  const oneClient = { clientId: client.id };
  const kpiC = await s.recruitment.kpi(oneClient);
  const funnelC = await s.recruitment.funnel(oneClient);
  check('filtering narrows the tiles and the funnel the same way',
    kpiC.openJobs, funnelC.openRequirements);
  check('a client filter never widens the book', kpiC.openJobs <= kpi.openJobs, true);

  const listed = await s.recruitment.jobOrders(oneClient);
  check('every listed order belongs to the client filtered for',
    listed.filter((x) => x.order.clientId !== client.id).length, 0);
  check('the list is newest first',
    listed.every((x, i) => i === 0 || listed[i - 1].order.openedOn >= x.order.openedOn), true);
  check('every listed order carries its own standing',
    listed.filter((x) => !x.sla || !x.counts).length, 0);
  check('a listed standing matches the one the detail call gives',
    (await s.recruitment.jobOrder(listed[0].order.id))!.sla.state, listed[0].sla.state);

  /* ---- clean up after ourselves ---- */

  for (const id of [made.id, perm.id]) {
    const i = REQUIREMENTS.findIndex((r) => r.id === id);
    if (i >= 0) REQUIREMENTS.splice(i, 1);
  }
  for (let i = JOB_ACTIVITY.length - 1; i >= 0; i--) {
    if (JOB_ACTIVITY[i].reqId === made.id || JOB_ACTIVITY[i].reqId === perm.id) {
      JOB_ACTIVITY.splice(i, 1);
    }
  }
  check('the check left no orders behind',
    REQUIREMENTS.filter((r) => r.id === made.id || r.id === perm.id).length, 0);

  console.log();
  if (failed) {
    console.error(`${failed} recruitment checks failed`);
    process.exit(1);
  }
  console.log('the recruitment service holds its rules');
})();
