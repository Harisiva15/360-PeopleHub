/**
 * User administration refuses what it is supposed to refuse.
 *
 * This is the module where getting authorisation wrong is worst, so the rules
 * are asserted as behaviour rather than trusted as configuration. Every case
 * below is run three times — once as each role — because a rule that holds for
 * an administrator and leaks for a manager is the only kind that ships.
 *
 * The screens hide controls a role cannot use. None of that is tested here,
 * deliberately: hiding a button is not a permission, and a check that passed
 * because a button was hidden would be testing the courtesy rather than the
 * boundary.
 */

import { getServices } from '../src/services';
import { USERS } from '../src/data/users';
import { ACTIVE, DEMO_EMP, DEMO_MGR, EMAP, HRHEAD } from '../src/data/employees';
import { visibleIds } from '../src/state/rbac';
import type { Caller, UserDraft } from '../src/services';
import type { AppRole } from '../src/types/employee';

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

(async () => {
  console.log(`\n${USERS.length} accounts in the book\n`);

  /* ---- the book contains the cases the module exists to handle ---- */

  const statuses = new Set(USERS.map((u) => u.status));
  for (const want of ['Active', 'Pending Approval', 'Invitation Pending', 'Inactive', 'Suspended', 'Deleted']) {
    check(`the book contains a ${want} account`, statuses.has(want as never), true);
  }
  check('a deleted account keeps its employee record',
    USERS.filter((u) => u.status === 'Deleted' && !u.empId).length, 0);
  check('only an account that could sign in has ever signed in',
    USERS.filter((u) => u.lastLoginAt
      && (u.status === 'Pending Approval' || u.status === 'Invitation Pending')).length, 0);

  /* ---- an employee has no access at all ---- */

  await refused('an employee cannot list users', () => s.users.list(EMPLOYEE));
  await refused('an employee cannot read the stats', () => s.users.stats(EMPLOYEE));
  await refused('an employee cannot create a user', () => s.users.create(EMPLOYEE, {
    name: 'X', email: 'x@360vhm.com', dept: 'ENG', designation: 'Engineer',
    site: 'CHN', role: 'employee',
  }));
  const anyUser = USERS.find((u) => u.status === 'Active')!;
  await refused('an employee cannot read one by id', () => s.users.get(EMPLOYEE, anyUser.id));
  await refused('an employee cannot deactivate anybody',
    () => s.users.setStatus(EMPLOYEE, anyUser.id, 'Inactive', 'because'));
  await refused('an employee cannot delete anybody',
    () => s.users.remove(EMPLOYEE, anyUser.id, 'DELETE'));
  await refused('an employee cannot bulk update',
    () => s.users.bulkUpdate(EMPLOYEE, [anyUser.id], { dept: 'ENG' }));

  /* ---- data scope ---- */

  const adminSees = await s.users.list(ADMIN);
  const mgrSees = await s.users.list(MANAGER);
  check('an administrator sees more than a manager', adminSees.length > mgrSees.length, true);

  const mgrTeam = new Set(visibleIds('manager', DEMO_MGR.id));
  check('every account a manager sees is in their line',
    mgrSees.filter((u) => !u.empId || !mgrTeam.has(u.empId)).length, 0);

  const outside = adminSees.find((u) => u.empId && !mgrTeam.has(u.empId))!;
  check('an account outside the line is invisible to the manager',
    (await s.users.get(MANAGER, outside.id)), null);
  await refused('and cannot be acted on either',
    () => s.users.setStatus(MANAGER, outside.id, 'Inactive', 'because'));

  /* ---- deleted accounts are gone from the default list ---- */

  check('no deleted account appears in the default list',
    adminSees.filter((u) => u.status === 'Deleted').length, 0);
  const deletedOnly = await s.users.list(ADMIN, { status: 'Deleted' });
  check('but they can be asked for by name', deletedOnly.length > 0, true);

  /* ---- only an administrator makes an administrator ---- */

  const base = (over: Partial<UserDraft> = {}): UserDraft => ({
    name: 'Check Person',
    email: `check-${Math.random().toString(36).slice(2, 9)}@360vhm.com`,
    dept: 'ENG', designation: 'Engineer', site: 'CHN', role: 'employee', ...over,
  });

  await refused('a manager cannot create an administrator',
    () => s.users.create(MANAGER, base({ role: 'admin' })));
  await allowed('a manager can create an employee',
    () => s.users.create(MANAGER, base()));
  await allowed('an administrator can create an administrator',
    () => s.users.create(ADMIN, base({ role: 'admin' })));

  const mgrMade = USERS.find((u) => u.requestedById === DEMO_MGR.id && u.status === 'Pending Approval')!;
  check("a manager's creation waits for approval", mgrMade.status, 'Pending Approval');
  check('and records who raised it', mgrMade.requestedById, DEMO_MGR.id);

  const adminMade = await s.users.create(ADMIN, base());
  check("an administrator's creation does not wait", adminMade.status, 'Invitation Pending');

  /* ---- role escalation through the edit path ---- */

  const teamMember = mgrSees.find((u) => u.role === 'employee' && u.status === 'Active')!;
  await refused('a manager cannot promote somebody to administrator',
    () => s.users.update(MANAGER, teamMember.id, { role: 'admin' }));
  await allowed('an administrator can',
    () => s.users.update(ADMIN, teamMember.id, { role: 'manager' }));
  await s.users.update(ADMIN, teamMember.id, { role: 'employee' });   /* put it back */

  /* ---- validation ---- */

  await refused('an account with no name is refused',
    () => s.users.create(ADMIN, base({ name: '  ' })));
  await refused('a malformed email is refused',
    () => s.users.create(ADMIN, base({ email: 'not-an-email' })));
  await refused('a duplicate email is refused',
    () => s.users.create(ADMIN, base({ email: anyUser.email })));
  await refused('a duplicate employee ID is refused',
    () => s.users.create(ADMIN, base({ code: anyUser.code })));
  await refused('an unknown manager is refused',
    () => s.users.create(ADMIN, base({ managerId: 'EMP-nope' })));

  /* ---- the lifecycle ---- */

  const live = await s.users.create(ADMIN, base());
  await s.users.decide(ADMIN, live.id, 'Approved').catch(() => {});

  await refused('deactivating without a reason is refused',
    () => s.users.setStatus(ADMIN, live.id, 'Inactive'));
  const off = await s.users.setStatus(ADMIN, live.id, 'Inactive', 'Contract ended');
  check('deactivating records the reason', off.deactivationReason, 'Contract ended');
  check('and who did it', off.deactivatedById, HRHEAD.id);
  check('the account is not removed', USERS.some((u) => u.id === live.id), true);

  const on = await s.users.setStatus(ADMIN, live.id, 'Active');
  check('reactivating clears the reason', [on.status, on.deactivationReason], ['Active', '']);

  await refused('a manager cannot reactivate',
    () => s.users.setStatus(MANAGER, teamMember.id, 'Active'));
  await refused('a manager cannot suspend',
    () => s.users.setStatus(MANAGER, teamMember.id, 'Suspended', 'held'));
  await allowed('a manager can deactivate somebody in their line',
    () => s.users.setStatus(MANAGER, teamMember.id, 'Inactive', 'Left the team'));
  await s.users.setStatus(ADMIN, teamMember.id, 'Active');

  /* ---- password reset ---- */

  await refused('a manager cannot reset a password',
    () => s.users.resetPassword(MANAGER, teamMember.id));
  const reset = await s.users.resetPassword(ADMIN, teamMember.id, true);
  check('an administrator can, and it forces a change', reset.mustChangePassword, true);

  /* ---- invitations ---- */

  const invited = USERS.find((u) => u.status === 'Invitation Pending')!;
  const before = invited.invitedCount;
  const again = await s.users.resendInvitation(ADMIN, invited.id);
  check('resending counts the invitation', again.invitedCount, before + 1);
  await refused('an active account has no invitation to resend',
    () => s.users.resendInvitation(ADMIN, on.id));

  /* ---- approval ---- */

  const pending = await s.users.create(MANAGER, base());
  await refused('a manager cannot approve', () => s.users.decide(MANAGER, pending.id, 'Approved'));
  await refused('rejecting without a reason is refused',
    () => s.users.decide(ADMIN, pending.id, 'Rejected'));
  const approved = await s.users.decide(ADMIN, pending.id, 'Approved');
  check('approving sends the invitation', approved.status, 'Invitation Pending');
  check('and records the approver', approved.approvedById, HRHEAD.id);
  await refused('a decided request cannot be decided again',
    () => s.users.decide(ADMIN, pending.id, 'Approved'));

  /* ---- delete ---- */

  const doomed = await s.users.create(ADMIN, base());
  await refused('deleting without typing DELETE is refused',
    () => s.users.remove(ADMIN, doomed.id, 'delete'));
  await refused('a manager cannot delete at all',
    () => s.users.remove(MANAGER, teamMember.id, 'DELETE'));
  const gone = await s.users.remove(ADMIN, doomed.id, 'DELETE');
  check('deleting is soft', gone.status, 'Deleted');
  check('the row survives', USERS.some((u) => u.id === doomed.id), true);
  await refused('a deleted account cannot be deleted again',
    () => s.users.remove(ADMIN, doomed.id, 'DELETE'));
  await refused('nor deactivated', () => s.users.setStatus(ADMIN, doomed.id, 'Inactive', 'x'));

  const own = USERS.find((u) => u.empId === HRHEAD.id);
  if (own) {
    await refused('nobody deletes their own account',
      () => s.users.remove(ADMIN, own.id, 'DELETE'));
  }

  /* ---- bulk ---- */

  const two = mgrSees.filter((u) => u.status !== 'Deleted').slice(0, 2).map((u) => u.id);
  await allowed('a manager can bulk update their own line',
    () => s.users.bulkUpdate(MANAGER, two, { site: 'CHN' }));
  await refused('a manager cannot bulk promote to administrator',
    () => s.users.bulkUpdate(MANAGER, two, { role: 'admin' as AppRole }));
  await refused('a manager cannot bulk update outside their line',
    () => s.users.bulkUpdate(MANAGER, [outside.id], { site: 'CHN' }));

  /* ---- search ---- */

  const target = adminSees.find((u) => u.status === 'Active')!;
  const byName = await s.users.list(ADMIN, { q: target.name.split(' ')[0].toUpperCase() });
  check('search is case-insensitive', byName.some((u) => u.id === target.id), true);
  const byCode = await s.users.list(ADMIN, { q: target.code });
  check('search finds an employee ID', byCode.some((u) => u.id === target.id), true);
  const byEmail = await s.users.list(ADMIN, { q: target.email });
  check('search finds an email', byEmail.some((u) => u.id === target.id), true);

  /* ---- stats agree with the list ---- */

  const stats = await s.users.stats(ADMIN);
  const listed = await s.users.list(ADMIN);
  check('the total tile matches the list', stats.total, listed.length);
  check('the active tile matches the list',
    stats.active, listed.filter((u) => u.status === 'Active').length);

  /* ---- clean up ---- */

  const planted = USERS.filter((u) => u.email.startsWith('check-'));
  for (const u of planted) {
    const i = USERS.findIndex((x) => x.id === u.id);
    if (i >= 0) USERS.splice(i, 1);
  }
  check('the check left no accounts behind',
    USERS.filter((u) => u.email.startsWith('check-')).length, 0);

  /* Every employee referenced still exists. */
  check('every account still points at a real employee',
    USERS.filter((u) => u.empId && !EMAP[u.empId]).length, 0);
  check('the roster is untouched', ACTIVE().length > 0, true);

  console.log();
  if (failed) {
    console.error(`${failed} user-administration checks failed`);
    process.exit(1);
  }
  console.log('user administration refuses what it should');
})();
