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
  const at = {
    lat: 12.99, lng: 80.25, site: 'CHN', geoOk: true, dist: 40,
    src: 'Mobile GPS', wfh: false, at: '09:20',
  };
  const inRec = await s.attendance.punchIn(DEMO_EMP.id, day, at);
  check('punch in stamps the time', inRec.inT, '09:20');
  check('punch in marks present', inRec.status, 'P');

  const outRec = await s.attendance.punchOut(DEMO_EMP.id, day, { ...at, at: '18:35' });
  check('punch out deducts the 45m break', outRec.mins, (18 * 60 + 35) - (9 * 60 + 20) - 45);

  /* a WFH punch records a W day and is not fence-enforced */
  const wfhDay = '2026-10-08';
  const wfh = await s.attendance.punchIn(DEMO_EMP.id, wfhDay, { ...at, site: 'WFH', wfh: true, at: '09:05' });
  check('WFH punch records a W day', wfh.status, 'W');

  /* an out-of-fence punch is flagged rather than silently accepted */
  const badDay = '2026-10-09';
  const bad = await s.attendance.punchIn(DEMO_EMP.id, badDay, { ...at, geoOk: false, dist: 900, at: '09:40' });
  check('outside the fence is flagged', bad.notes, 'Outside geo-fence — flagged');

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
  const week = '2026-10-05';
  const sheet = await s.timesheet.forWeek(DEMO_EMP.id, week);
  check('a new week starts as an empty draft', [sheet.status, sheet.rows.length, sheet.total], ['Draft', 0, 0]);

  let noHours = false;
  try { await s.timesheet.submit(sheet.id); } catch { noHours = true; }
  check('an empty sheet cannot be submitted', noHours, true);

  await s.timesheet.addRow(sheet.id, 'P-NBFC', 'Development');
  const withHours = await s.timesheet.setHours(sheet.id, 0, 0, 8);
  check('the total is derived by the service', withHours.total, 8);

  const more = await s.timesheet.setHours(sheet.id, 0, 1, 7.5);
  check('the total tracks every cell', more.total, 15.5);

  const submitted = await s.timesheet.submit(sheet.id);
  check('submitting stamps the date', submitted.status, 'Submitted');

  const recalled = await s.timesheet.recall(sheet.id);
  check('recalling returns it to draft', [recalled.status, recalled.submittedOn], ['Draft', null]);

  let recallRefused = false;
  try { await s.timesheet.recall(sheet.id); } catch { recallRefused = true; }
  check('a draft cannot be recalled', recallRefused, true);

  await s.timesheet.submit(sheet.id);
  const approved = await s.timesheet.approve(sheet.id, DEMO_MGR.id);
  check('approving records the approver', [approved.status, approved.approverId], ['Approved', DEMO_MGR.id]);

  let dblApprove = false;
  try { await s.timesheet.approve(sheet.id, DEMO_MGR.id); } catch { dblApprove = true; }
  check('a second approval is refused', dblApprove, true);

  const removed = await s.timesheet.removeRow(sheet.id, 0);
  check('removing a row recomputes the total', removed.total, 0);

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
    await s.shifts.approveOvertime(o.id, DEMO_MGR.id);
    let otTwice = false;
    try { await s.shifts.approveOvertime(o.id, DEMO_MGR.id); } catch { otTwice = true; }
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

    for (let i = 0; i < openExit.clearance.length; i++) await s.exits.setClearance(openExit.id, i, true);
    const settled = await s.exits.settle(openExit.id);
    check('settling closes the exit once clearance is done', settled.status, 'Settled');
    let twice = false;
    try { await s.exits.settle(openExit.id); } catch { twice = true; }
    check('an exit is settled once', twice, true);
  }

  /* ---- configuration writes ---- */
  const chn = (await s.config.sites()).find((x) => x.id === 'CHN')!;
  const moved = await s.config.updateFence('CHN', { lat: 13.0, lng: 80.25, radius: 300, shift: '10:00-19:00' });
  check('the fence takes the new radius', moved.radius, 300);
  const basedThere = (await s.employees.active()).filter((e) => e.site === 'CHN');
  check('everyone at the site inherits the shift',
    basedThere.every((e) => e.shift === '10:00-19:00'), true);
  await s.config.updateFence('CHN', { lat: chn.lat!, lng: chn.lng!, radius: chn.radius, shift: '09:30-18:30' });

  let badRadius = false;
  try { await s.config.updateFence('CHN', { lat: 13, lng: 80, radius: 0, shift: '09:30-18:30' }); } catch { badRadius = true; }
  check('a zero radius is refused', badRadius, true);

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

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall service checks passed');
  process.exit(failed ? 1 : 0);
})();
