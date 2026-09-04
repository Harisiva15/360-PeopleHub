import { getServices } from '../src/services';
import { DEMO_EMP, DEMO_MGR, HRHEAD } from '../src/data/employees';

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

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall service checks passed');
  process.exit(failed ? 1 : 0);
})();
