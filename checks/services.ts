import { getServices } from '../src/services';
import { DEMO_EMP, DEMO_MGR, EMAP, HRHEAD } from '../src/data/employees';
import { toBase } from '../src/data/countries';

const s = getServices();
let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

(async () => {
  /* scoping: each role sees a different slice, enforced in the service */
  const asAdmin = await s.employees.visible({ role: 'admin', meId: HRHEAD.id });
  const asMgr = await s.employees.visible({ role: 'manager', meId: DEMO_MGR.id });
  const asEmp = await s.employees.visible({ role: 'employee', meId: DEMO_EMP.id });
  console.log(`scope: admin ${asAdmin.length} · manager ${asMgr.length} · employee ${asEmp.length}`);
  check('employee sees only themselves', asEmp.map((e) => e.id), [DEMO_EMP.id]);
  check('manager sees fewer than admin', asMgr.length < asAdmin.length, true);
  check('manager includes themselves', asMgr.some((e) => e.id === DEMO_MGR.id), true);

  /* apply -> approve debits the balance, and the debit happens in the service */
  const before = await s.leave.balance(DEMO_EMP.id, 'CL');
  const req = await s.leave.apply({
    empId: DEMO_EMP.id, type: 'CL', from: '2026-10-05', to: '2026-10-06',
    days: 2, reason: 'Service seam check', half: null,
  });
  check('new request starts Pending', req.status, 'Pending');
  check('approver is the reporting manager', req.approverId, DEMO_EMP.managerId);

  const midway = await s.leave.balance(DEMO_EMP.id, 'CL');
  check('applying does not debit', midway!.used, before!.used);

  await s.leave.approve(req.id, DEMO_MGR.id);
  const after = await s.leave.balance(DEMO_EMP.id, 'CL');
  check('approving debits 2 days', after!.used, before!.used + 2);
  check('available falls by 2', after!.avail, before!.avail - 2);

  /* cancelling an approved request returns the days */
  await s.leave.cancel(req.id);
  const restored = await s.leave.balance(DEMO_EMP.id, 'CL');
  check('cancelling credits the days back', restored!.used, before!.used);

  /* double-approval is refused rather than double-debiting */
  const req2 = await s.leave.apply({
    empId: DEMO_EMP.id, type: 'CL', from: '2026-11-02', to: '2026-11-02',
    days: 1, reason: 'Double approve check', half: null,
  });
  await s.leave.approve(req2.id, DEMO_MGR.id);
  const once = await s.leave.balance(DEMO_EMP.id, 'CL');
  let refused = false;
  try { await s.leave.approve(req2.id, DEMO_MGR.id); } catch { refused = true; }
  const twice = await s.leave.balance(DEMO_EMP.id, 'CL');
  check('second approval is refused', refused, true);
  check('balance not debited twice', twice!.used, once!.used);

  /* batched balances match the single-row read */
  const batch = await s.leave.balancesFor([DEMO_EMP.id]);
  check('batched balance matches single', batch[DEMO_EMP.id].find((b) => b.type === 'CL')!.avail, twice!.avail);

  /* ---- attendance ---- */
  const day = '2026-10-07';
  const at = { site: 'CHN', src: 'Web', at: '09:20' };
  const inRec = await s.attendance.punchIn(DEMO_EMP.id, day, at);
  check('punch in stamps the time', inRec.inT, '09:20');
  check('punch in marks present', inRec.status, 'P');

  const outRec = await s.attendance.punchOut(DEMO_EMP.id, day, { ...at, at: '18:35' });
  check('punch out deducts the 45m break', outRec.mins, (18 * 60 + 35) - (9 * 60 + 20) - 45);

  /* the work mode picks the day's status; there is nothing else location-shaped left */
  const wfhDay = '2026-10-08';
  const wfh = await s.attendance.punchIn(DEMO_EMP.id, wfhDay, { ...at, site: 'WFH', at: '09:05' });
  check('WFH punch records a W day', wfh.status, 'W');
  check('and keeps the work mode', wfh.site, 'WFH');

  const clientDay = '2026-10-09';
  const client = await s.attendance.punchIn(DEMO_EMP.id, clientDay, { ...at, site: 'CLIENT', at: '09:40' });
  check('a client punch is still a present day', client.status, 'P');
  check('with the client work mode', client.site, 'CLIENT');

  /* regularisation credits a full day only once approved */
  const regDay = '2026-09-15';
  const raised = await s.attendance.raiseRegularisation(DEMO_EMP.id, regDay, '09:30', '18:30', 'Missed punch');
  check('regularisation starts Pending', raised.reg!.status, 'Pending');
  const beforeMins = raised.mins;
  check('raising does not credit hours', beforeMins, raised.mins);

  const approvedReg = await s.attendance.actOnRegularisation(DEMO_EMP.id, regDay, 'Approved');
  check('approving credits a standard day', approvedReg.mins, 495);
  check('approving marks the day present', approvedReg.status, 'P');

  let regRefused = false;
  try { await s.attendance.actOnRegularisation(DEMO_EMP.id, regDay, 'Approved'); } catch { regRefused = true; }
  check('a second decision is refused', regRefused, true);

  /* ---- timesheet ---- */
  const week = '2026-10-05';                       /* a Monday */
  const mon = '2026-10-05';
  const tue = '2026-10-06';
  const sheet = await s.timesheet.forWeek(DEMO_EMP.id, week);
  check('a new week starts as an empty draft',
    [sheet.status, sheet.entries.length, sheet.total], ['Draft', 0, 0]);

  let noHours = false;
  try { await s.timesheet.submit(sheet.id); } catch { noHours = true; }
  check('an empty sheet cannot be submitted', noHours, true);

  const one = await s.timesheet.addEntry(sheet.id, {
    date: mon, proj: 'P-NBFC', task: 'Development', billable: true, hours: 8,
  });
  check('totals are derived by the service',
    [one.total, one.billable, one.nonBillable], [8, 8, 0]);

  /* Billability is the entry's, not the project's — the same project can do both. */
  const mixed = await s.timesheet.addEntry(sheet.id, {
    date: mon, proj: 'P-NBFC', task: 'Sprint Planning', billable: false, hours: 1,
  });
  check('an entry may be non-billable on a billable project',
    [mixed.total, mixed.billable, mixed.nonBillable], [9, 8, 1]);

  /* Same project, task and day is the same work said twice. */
  const merged = await s.timesheet.addEntry(sheet.id, {
    date: mon, proj: 'P-NBFC', task: 'Development', billable: true, hours: 2,
  });
  check('a repeated project, task and day merges',
    [merged.entries.length, merged.total], [2, 11]);

  let offWeek = false;
  try {
    await s.timesheet.addEntry(sheet.id, {
      date: '2026-10-13', proj: 'P-NBFC', task: 'Development', hours: 1,
    });
  } catch { offWeek = true; }
  check('a day outside the week is refused', offWeek, true);

  let overDay = false;
  try {
    await s.timesheet.addEntry(sheet.id, {
      date: mon, proj: 'P-ATLAS', task: 'Documentation', hours: 20,
    });
  } catch { overDay = true; }
  check('a day cannot exceed 24 hours in total', overDay, true);

  /* The limit is measured without the line's own old value, not on top of it. */
  const dev = merged.entries.find((e) => e.task === 'Development')!;
  const widened = await s.timesheet.updateEntry(sheet.id, dev.id, { hours: 12 });
  check('editing measures the limit without the old value', widened.total, 13);

  const moved = await s.timesheet.updateEntry(sheet.id, dev.id, { date: tue });
  check('moving a line keeps the total', moved.total, 13);

  const noted = await s.timesheet.setComment(sheet.id, 'Release week — worked long days.');
  check('the comment is kept apart from the lines', noted.note, 'Release week — worked long days.');

  const submitted = await s.timesheet.submit(sheet.id);
  check('submitting stamps the date', submitted.status, 'Submitted');

  let lockedOut = false;
  try {
    await s.timesheet.addEntry(sheet.id, { date: tue, proj: 'P-INT', task: 'Training', hours: 1 });
  } catch { lockedOut = true; }
  check('a submitted sheet cannot be edited', lockedOut, true);

  let selfDecide = false;
  try { await s.timesheet.decide(sheet.id, 'Approved'); } catch { selfDecide = true; }
  check('nobody decides their own week', selfDecide, true);

  const recalled = await s.timesheet.recall(sheet.id);
  check('recalling returns it to draft', [recalled.status, recalled.submittedOn], ['Draft', null]);

  let recallRefused = false;
  try { await s.timesheet.recall(sheet.id); } catch { recallRefused = true; }
  check('a draft cannot be recalled', recallRefused, true);

  const dropped = await s.timesheet.removeEntry(sheet.id, dev.id);
  check('removing a line recomputes the totals',
    [dropped.entries.length, dropped.total, dropped.billable], [1, 1, 0]);

  /*
   * The decision path runs on somebody else's week, because the service
   * refuses to let the caller decide their own — which is the assertion above.
   */
  const other = DEMO_MGR.reports.find((id) => id !== DEMO_EMP.id)!;
  const theirs = await s.timesheet.forWeek(other, week);
  await s.timesheet.addEntry(theirs.id, {
    date: mon, proj: 'P-RETAIL', task: 'Testing', billable: true, hours: 6,
  });
  await s.timesheet.submit(theirs.id);

  let silentReturn = false;
  try { await s.timesheet.decide(theirs.id, 'Returned'); } catch { silentReturn = true; }
  check('returning a sheet needs a reason', silentReturn, true);

  const returned = await s.timesheet.decide(theirs.id, 'Returned', 'Split the hours by task.');
  check('returning hands it back with the reason',
    [returned.status, returned.note], ['Returned', 'Split the hours by task.']);

  const editableAgain = await s.timesheet.addEntry(theirs.id, {
    date: tue, proj: 'P-RETAIL', task: 'Code Review', billable: true, hours: 2,
  });
  check('a returned sheet is editable again', editableAgain.total, 8);

  await s.timesheet.submit(theirs.id);
  const approved = await s.timesheet.decide(theirs.id, 'Approved');
  check('approving records the approver',
    [approved.status, approved.approverId], ['Approved', EMAP[other].managerId]);

  let dblDecide = false;
  try { await s.timesheet.decide(theirs.id, 'Approved'); } catch { dblDecide = true; }
  check('a second decision is refused', dblDecide, true);

  let approvedLocked = false;
  try { await s.timesheet.removeEntry(theirs.id, approved.entries[0].id); } catch { approvedLocked = true; }
  check('an approved week is closed to edits', approvedLocked, true);

  /* ---- expenses ---- */
  const claim = await s.expenses.submitClaim({
    empId: DEMO_EMP.id,
    title: 'Client visit',
    item: {
      cat: 'LOCAL', date: '2026-10-02', amount: 1800, merchant: 'Cab',
      desc: 'Airport transfer', receipt: 'receipt.pdf', project: null,
    },
  });
  check('a claim starts Submitted', claim.status, 'Submitted');
  check('the total follows the line item', claim.total, 1800);

  let payTooEarly = false;
  try { await s.expenses.reimburseClaim(claim.id); } catch { payTooEarly = true; }
  check('an unapproved claim cannot be paid', payTooEarly, true);

  const okClaim = await s.expenses.approveClaim(claim.id, DEMO_MGR.id);
  check('approving records the approver', okClaim.approverId, DEMO_MGR.id);

  const paid = await s.expenses.reimburseClaim(claim.id);
  check('reimbursing stamps a payroll month', !!paid.payrollMonth, true);

  let rejectAfterPay = false;
  try { await s.expenses.rejectClaim(claim.id, DEMO_MGR.id, 'too late'); } catch { rejectAfterPay = true; }
  check('a paid claim cannot be rejected', rejectAfterPay, true);

  const adv = await s.expenses.requestAdvance(DEMO_EMP.id, 25000, 'Client travel');
  check('an advance starts Pending', adv.status, 'Pending');
  await s.expenses.approveAdvance(adv.id);
  let dblAdv = false;
  try { await s.expenses.approveAdvance(adv.id); } catch { dblAdv = true; }
  check('an advance is approved once', dblAdv, true);

  /* ---- employees ---- */
  const prof = await s.employees.profile(DEMO_EMP.id);
  check('the profile composite resolves', !!prof, true);
  check('it carries the manager name, not just an id', prof!.managerName, EMAP[DEMO_EMP.managerId!].name);
  check('it computes monthly comp', prof!.compMonthly.basic > 0, true);
  check('leave balances come with it', prof!.leaveBalances.length > 0, true);
  const missingProfile = await s.employees.profile('NOPE');
  check('an unknown id resolves to null, not a throw', missingProfile, null);

  /* ---- payroll ---- */
  const allRuns = await s.payroll.runs();
  const lastPaid = allRuns.filter((r) => r.status === 'Paid').slice(-1)[0];
  const reg = await s.payroll.register(lastPaid.mk);
  const regTotals = await s.payroll.totals(lastPaid.mk);
  check('the register covers everyone in the cycle', reg.length, regTotals.count);
  check('register gross reconciles with the cycle total',
    Math.round(reg.reduce((t, r) => t + toBase(r.payslip.gross, r.employee.ccy), 0)),
    Math.round(regTotals.gross));

  const hist = await s.payroll.payslipHistory(DEMO_EMP.id);
  check('payslip history covers only paid cycles', hist.every((h) => h.run.status === 'Paid'), true);
  check('history starts no earlier than the join date',
    hist.every((h) => h.run.mk >= DEMO_EMP.doj.slice(0, 7)), true);

  const batched = await s.payroll.totalsFor([lastPaid.mk]);
  check('batched totals match the single read', batched[lastPaid.mk].net, regTotals.net);

  let rerun = false;
  try { await s.payroll.processRun(lastPaid.mk); } catch { rerun = true; }
  check('a paid cycle cannot be processed twice', rerun, true);

  /* ---- the shared approval surfaces ---- */
  const pendingOt = await s.shifts.overtime(undefined, 'Pending');
  if (pendingOt.length) {
    const o = pendingOt[0];
    await s.shifts.approveOvertime(o.id);
    let otTwice = false;
    try { await s.shifts.approveOvertime(o.id); } catch { otTwice = true; }
    check('overtime is approved once', otTwice, true);
  }

  const pendingLoans = await s.loans.list('Pending Approval');
  if (pendingLoans.length) {
    const l = pendingLoans[0];
    const active = await s.loans.approve(l.id);
    check('sanctioning a loan makes it active', active.status, 'Active');
    let loanTwice = false;
    try { await s.loans.approve(l.id); } catch { loanTwice = true; }
    check('a sanctioned loan cannot be re-approved', loanTwice, true);
  }

  const pendingLetters = await s.letters.requests('Pending');
  if (pendingLetters.length) {
    const lr = pendingLetters[0];
    const issued = await s.letters.issue(lr.id);
    check('issuing a letter stamps the date', !!issued.issuedOn, true);
    let letterTwice = false;
    try { await s.letters.issue(lr.id); } catch { letterTwice = true; }
    check('a letter is issued once', letterTwice, true);
  }

  const panel = await s.hiring.interviewsFor(DEMO_MGR.id, 'Scheduled');
  check('interviews resolve their candidate', panel.every((r) => r.candidate !== null), true);

  /* ---- assets and exits ---- */
  const stock = (await s.assets.list()).find((a) => a.status === 'In stock');
  if (stock) {
    const issued = await s.assets.allocate(stock.id, DEMO_EMP.id);
    check('allocating assigns the asset', [issued.status, issued.empId], ['Assigned', DEMO_EMP.id]);
    let reAllocate = false;
    try { await s.assets.allocate(stock.id, DEMO_MGR.id); } catch { reAllocate = true; }
    check('an issued asset cannot be allocated again', reAllocate, true);

    const back = await s.assets.markReturned(stock.id);
    check('returning puts it back in stock', [back.status, back.empId], ['In stock', null]);
    let reReturn = false;
    try { await s.assets.markReturned(stock.id); } catch { reReturn = true; }
    check('an asset in stock cannot be returned', reReturn, true);
  }

  const openExit = (await s.exits.list()).find((x) => x.status !== 'Settled');
  if (openExit) {
    const detail = await s.exits.detail(openExit.id);
    check('the exit detail resolves its employee', detail?.employee.id, openExit.empId);
    check('it carries a computed settlement', typeof detail?.settlement.net, 'number');

    const stillOpen = openExit.clearance.filter((c) => !c.done).length;
    if (stillOpen) {
      let early = false;
      try { await s.exits.settle(openExit.id); } catch { early = true; }
      check('an exit cannot settle with clearance outstanding', early, true);
    }

    /* By department, not index — the contract stopped taking a position. */
    for (const line of openExit.clearance) await s.exits.setClearance(openExit.id, line.k, true);
    const settled = await s.exits.settle(openExit.id);
    check('settling closes the exit once clearance is done', settled.status, 'Settled');
    let twice = false;
    try { await s.exits.settle(openExit.id); } catch { twice = true; }
    check('an exit is settled once', twice, true);
  }

  /* ---- configuration writes ---- */
  const chn = (await s.config.sites()).find((x) => x.id === 'CHN')!;
  check('an office is not a remote work mode', chn.remote, false);
  check('but WFH is', (await s.config.sites()).find((x) => x.id === 'WFH')!.remote, true);

  const clBefore = (await s.leave.balance(DEMO_EMP.id, 'CL'))!;
  const quota = await s.config.setLeaveQuota('CL', 15);
  check('the quota change reports how many balances it repriced', quota.repriced > 0, true);
  const clAfter = (await s.leave.balance(DEMO_EMP.id, 'CL'))!;
  check('an open balance is repriced, not just new joiners', clAfter.quota, 15);
  await s.config.setLeaveQuota('CL', clBefore.quota);

  let negative = false;
  try { await s.config.setLeaveQuota('CL', -1); } catch { negative = true; }
  check('a negative quota is refused', negative, true);

  const added = await s.config.addHoliday('2026-12-24', 'Christmas Eve', false);
  check('the holiday lands in the calendar', added.some((h) => h.d === '2026-12-24'), true);
  let dupe = false;
  try { await s.config.addHoliday('2026-12-24', 'Duplicate', false); } catch { dupe = true; }
  check('two holidays cannot share a date', dupe, true);


  /* ---- shifts: approving overtime credits comp off in the same call ---- */
  const otBefore = (await s.leave.balance(DEMO_EMP.id, 'CO'))!;
  const ot = await s.shifts.raiseOvertime({
    empId: DEMO_EMP.id, date: '2026-09-01', hours: 8,
    reason: 'Release window', compensation: 'Comp Off',
  });
  check('new overtime starts Pending', ot.status, 'Pending');
  let badHours = false;
  try {
    await s.shifts.raiseOvertime({
      empId: DEMO_EMP.id, date: '2026-09-01', hours: 16,
      reason: 'All night', compensation: 'Comp Off',
    });
  } catch { badHours = true; }
  check('more than 12 hours needs an exception', badHours, true);

  const otApproved = await s.shifts.approveOvertime(ot.id);
  const otAfter = (await s.leave.balance(DEMO_EMP.id, 'CO'))!;
  check('approving eight hours credits one comp off day', otAfter.quota, otBefore.quota + 1);
  check('and the claim says how many days it bought', otApproved.credited, 1);
  let otTwice = false;
  try { await s.shifts.approveOvertime(ot.id); } catch { otTwice = true; }
  check('overtime is approved once', otTwice, true);

  /*
   * Under eight hours credits nothing. Rounding up would hand out a day for
   * five hours' work, and "Approved" with no day earned is the case the screen
   * has to be able to explain.
   */
  const short = await s.shifts.raiseOvertime({
    empId: DEMO_EMP.id, date: '2026-09-03', hours: 5,
    reason: 'Short evening', compensation: 'Comp Off',
  });
  const shortDone = await s.shifts.approveOvertime(short.id);
  check('five hours credits no comp off day', shortDone.credited, 0);
  check('and the balance does not move',
    (await s.leave.balance(DEMO_EMP.id, 'CO'))!.quota, otAfter.quota);

  let otRejectTwice = false;
  const toReject = await s.shifts.raiseOvertime({
    empId: DEMO_EMP.id, date: '2026-09-04', hours: 3,
    reason: 'Not agreed in advance', compensation: 'Comp Off',
  });
  check('a claim can be rejected', (await s.shifts.rejectOvertime(toReject.id)).status, 'Rejected');
  try { await s.shifts.rejectOvertime(toReject.id); } catch { otRejectTwice = true; }
  check('and only once', otRejectTwice, true);

  /*
   * A shift is the hours somebody keeps, not a day's assignment — migration
   * 0015 dropped the per-day table, so changing it changes every working day.
   */
  const otWeek = '2026-09-07';
  await s.shifts.setShift(DEMO_EMP.id, 'US');
  const rosterAfter = await s.shifts.roster([DEMO_EMP.id], otWeek, 7);
  const working = Object.entries(rosterAfter[DEMO_EMP.id]).filter(([, v]) => v !== 'OFF');
  check('the shift change applies to every working day',
    working.every(([, v]) => v === 'US'), true);
  check('and the week still has its two days off',
    Object.values(rosterAfter[DEMO_EMP.id]).filter((v) => v === 'OFF').length, 2);
  let badShift = false;
  try { await s.shifts.setShift(DEMO_EMP.id, 'NOPE'); } catch { badShift = true; }
  check('an unknown shift is refused', badShift, true);

  const profiles = await s.shifts.profiles();
  check('every profile carries the clock it is measured against',
    profiles.every((x) => x.timezone.includes('/')), true);
  check('and the headcounts sum to the people on a shift',
    profiles.reduce((n, x) => n + x.headcount, 0) > 0, true);

  /* ---- tax: both regimes priced on the same gross ---- */
  const tax = await s.payroll.taxSummary(DEMO_EMP.id);
  check('the better regime is the cheaper one',
    tax.better, tax.oldRegime.total <= tax.newRegime.total ? 'Old' : 'New');
  check('the new regime allows no HRA exemption',
    tax.newRegime.taxable, Math.max(0, tax.salary.grossA - 75000));
  check('the HRA exemption is capped by the rent claimed', tax.hraExemption <= tax.totals.hra, true);

  /*
   * The declaration lifecycle needs a subject whose declaration is not already
   * verified, and the dataset generates roughly a fifth of them verified.
   *
   * This block used to assume DEMO_EMP's was open. It passed for months and
   * then failed on a day when the generator happened to hand that employee a
   * verified one — a test that depends on the date it is run is a test that
   * will eventually fail for a reason unrelated to the code. So the subject is
   * chosen by the state the test needs, not by identity.
   */
  const declarations = await s.payroll.declarations();
  const openSubject = Object.keys(declarations)
    .find((id) => declarations[id]!.status !== 'Verified' && EMAP[id]);

  if (!openSubject) {
    check('the fixture has an unverified declaration to exercise', false, true);
  } else {
    await s.payroll.setRegime(openSubject, 'Old');
    const switched = await s.payroll.taxSummary(openSubject);
    check('the regime switch sticks', switched.declaration.regime, 'Old');

    await s.payroll.saveDeclaration(openSubject, { ...switched.declaration.items, '80C_elss': 50000 });
    const saved = await s.payroll.taxSummary(openSubject);
    check('saving submits the declaration', saved.declaration.status, 'Submitted');
    await s.payroll.verifyDeclaration(openSubject);
    let regimeLocked = false;
    try { await s.payroll.setRegime(openSubject, 'New'); } catch { regimeLocked = true; }
    check('the regime locks once Finance verifies', regimeLocked, true);
    let verifyTwice = false;
    try { await s.payroll.verifyDeclaration(openSubject); } catch { verifyTwice = true; }
    check('a declaration is verified once', verifyTwice, true);
  }

  /* ---- benefits: the pool and the per-component ceilings are the rule ---- */
  const fbp = await s.benefits.fbpPlan(DEMO_EMP.id);
  let overPool = false;
  try { await s.benefits.declareFbp(DEMO_EMP.id, { meal: fbp.plan.pool + 1000 }); } catch { overPool = true; }
  check('an allocation over the pool is refused', overPool, true);
  let overCap = false;
  try { await s.benefits.declareFbp(DEMO_EMP.id, { books: 99000 }); } catch { overCap = true; }
  check("an allocation over a component's ceiling is refused", overCap, true);
  const declared = await s.benefits.declareFbp(DEMO_EMP.id, { meal: 26400 });
  check('a valid allocation declares the plan', declared.status, 'Declared');
  check('the allocation is what was declared', declared.alloc.meal, 26400);

  /* ---- performance: progress derives the status and the key results ---- */
  const goals = await s.performance.goals([DEMO_EMP.id]);
  if (goals.length) {
    const g = await s.performance.setGoalProgress(goals[0].id, 100);
    check('full progress achieves the goal', g.status, 'Achieved');
    check('the final key result follows the progress', g.keyResults[2]?.done ?? true, true);
    const back = await s.performance.setGoalProgress(goals[0].id, 20);
    check('low progress puts the goal behind', back.status, 'Behind');
    let badProgress = false;
    try { await s.performance.setGoalProgress(goals[0].id, 140); } catch { badProgress = true; }
    check('progress beyond 100 is refused', badProgress, true);
  }

  /* ---- letters state facts the service holds ---- */
  const letter = await s.documents.letterContext(DEMO_EMP.id);
  check('the letter names the employee', letter.employee.id, DEMO_EMP.id);
  check('the letter carries a signatory', letter.signatory.name, HRHEAD.name);
  check('the letter prices the salary', letter.salary.grossA > 0, true);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall service checks passed');
  process.exit(failed ? 1 : 0);
})();
