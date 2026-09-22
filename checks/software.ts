/**
 * The software register agrees with the asset register, and with itself.
 *
 * The arithmetic assertions matter most here, because every figure on the
 * screen is money: a dormant count that is wrong by ten seats on a ₹74,000
 * product is a wrong recommendation, not a cosmetic bug. The rest run as all
 * three roles, because a rule that holds for an administrator and leaks for a
 * manager is the only kind that ships.
 */

import { getServices } from '../src/services';
import {
  DORMANT_DAYS, SEATS, SOFTWARE, annualCost, isDormant, seatsOf, wastedCost,
} from '../src/data/software';
import { ASSETS } from '../src/data/assets';
import { DEMO_EMP, DEMO_MGR, EMAP, HRHEAD } from '../src/data/employees';
import { recordAudit } from '../src/data/audit';
import { daysBetween, TODAY, ymd } from '../src/lib/dates';
import type { Caller, SoftwareDraft } from '../src/services';

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

(async () => {
  console.log(`\n${SOFTWARE.length} products, ${SEATS.length} seats\n`);

  /* ---- the two registers agree ---- */

  /*
   * The reason this module is not a filter over the asset list. Three products
   * live in both, and a person holding one in the asset register must hold the
   * same seat here — otherwise the company has two answers to "who has Figma".
   */
  const kitNames = ['Microsoft 365 E5', 'JetBrains All Products', 'Figma Organisation'];
  const licenceRows = ASSETS.filter((a) => a.cat === 'LICENCE');
  const issuedToSomebody = licenceRows.filter((a) => a.empId && a.status === 'Assigned');

  /*
   * Say the number out loud. Today it is zero — the asset register's licence
   * rows are all unallocated stock IT bought in boxes, so the reconciliation
   * below has nothing to reconcile and would pass while doing nothing. Printing
   * the count is what stops that from reading as a green tick, and the
   * assertion is still worth having: the moment somebody issues a licence to a
   * person, it starts biting.
   */
  console.log(`  ${licenceRows.length} licence rows in the asset register, `
    + `${issuedToSomebody.length} of them issued to a person\n`);

  for (const name of kitNames) {
    const p = SOFTWARE.find((x) => x.n === name);
    check(`${name} is in the software register`, !!p, true);
    if (!p) continue;
    const holders = new Set(seatsOf(p.id).map((x) => x.empId));
    const missing = issuedToSomebody
      .filter((a) => a.type === name && !holders.has(a.empId!));
    check(`everybody issued ${name} as an asset holds a seat`, missing.length, 0);
  }

  /*
   * And the converse, which is the one that actually has rows: a seat claiming
   * to mirror an asset must name an asset that exists and is held by the same
   * person. A dangling `assetId` would make `revokeSeat` refuse forever and
   * strand the seat.
   */
  const dangling = SEATS.filter((x) => {
    if (!x.assetId) return false;
    const a = ASSETS.find((y) => y.id === x.assetId);
    return !a || a.empId !== x.empId;
  });
  check('a seat that mirrors an asset names that asset correctly', dangling.length, 0);

  const orphanSeats = SEATS.filter((x) => !SOFTWARE.some((p) => p.id === x.productId));
  check('no seat points at a product that does not exist', orphanSeats.length, 0);
  check('no seat belongs to somebody who is not an employee',
    SEATS.filter((x) => !EMAP[x.empId]).length, 0);
  check('nobody holds the same product twice',
    SEATS.length, new Set(SEATS.map((x) => `${x.productId}:${x.empId}`)).size);
  check('no seat was used before it was assigned',
    SEATS.filter((x) => x.lastUsedOn && x.lastUsedOn < x.assignedOn).length, 0);
  check('no seat was used in the future',
    SEATS.filter((x) => x.lastUsedOn && x.lastUsedOn > NOW).length, 0);

  /* ---- the arithmetic ---- */

  const rows = await s.software.list(ADMIN);
  check('an administrator sees every product', rows.length, SOFTWARE.length);

  check('assigned is the seat count',
    rows.filter((r) => r.assigned !== seatsOf(r.product.id).length).length, 0);
  check('free never goes negative', rows.filter((r) => r.free < 0).length, 0);
  check('free plus assigned is the purchase, except where over-allocated',
    rows.filter((r) => !r.overAllocated && r.free + r.assigned !== r.product.seats).length, 0);
  check('over-allocated means more holders than seats',
    rows.filter((r) => r.overAllocated !== (r.assigned > r.product.seats)).length, 0);
  check('annual cost is seats times unit cost',
    rows.filter((r) => r.annualCost !== r.product.seats * r.product.unitCost).length, 0);
  check('idle spend never exceeds the annual commitment',
    rows.filter((r) => r.wastedCost > r.annualCost).length, 0);

  /*
   * The dormant definition, checked against the dates rather than against
   * itself — the figure drives a "reclaim this" recommendation, so an
   * off-by-one here is a wrong instruction to a person.
   */
  const handCounted = SEATS.filter((x) =>
    !x.lastUsedOn || daysBetween(x.lastUsedOn, NOW) >= DORMANT_DAYS).length;
  check('the dormant count matches the dates', SEATS.filter((x) => isDormant(x)).length, handCounted);

  const stats = await s.software.stats(ADMIN);
  check('the spend figure is the sum of the products',
    stats.annualSpend, SOFTWARE.filter((p) => p.status !== 'Cancelled')
      .reduce((n, p) => n + annualCost(p), 0));
  check('the idle figure is the sum of the products',
    stats.wastedSpend, SOFTWARE.filter((p) => p.status !== 'Cancelled')
      .reduce((n, p) => n + wastedCost(p), 0));
  check('seats assigned matches the list',
    stats.seatsAssigned, rows.reduce((n, r) => n + r.assigned, 0));

  const renewals = await s.software.renewals(ADMIN, 90);
  check('every renewal listed is within the window',
    renewals.filter((r) => r.inDays > 90).length, 0);
  check('renewals are soonest first',
    renewals.every((r, i) => i === 0 || renewals[i - 1].inDays <= r.inDays), true);

  /* ---- who sees what ---- */

  await allowed('a manager may read the estate', () => s.software.list(MANAGER));
  await refused('an employee may not', () => s.software.list(EMPLOYEE));
  await refused('nor read the figures', () => s.software.stats(EMPLOYEE));
  await refused('nor open a product', () => s.software.get(EMPLOYEE, SOFTWARE[0].id));

  const mine = await s.software.mine(EMPLOYEE);
  check('an employee gets their own seats',
    mine.every((m) => m.seat.empId === DEMO_EMP.id), true);
  check('and every one names a real product',
    mine.filter((m) => !m.product).length, 0);

  const nothing = await s.software.get(ADMIN, 'SW-does-not-exist');
  check('an id that does not exist is null, not a refusal', nothing, null);

  /* ---- writing ---- */

  const base = (over: Partial<SoftwareDraft> = {}): SoftwareDraft => ({
    n: `Check Tool ${Math.random().toString(36).slice(2, 7)}`,
    vendor: 'Check Vendor',
    cat: 'Productivity',
    seats: 10,
    unitCost: 1000,
    renewsOn: NOW,
    ...over,
  });

  await refused('a manager cannot add software', () => s.software.create(MANAGER, base()));
  await refused('an employee cannot either', () => s.software.create(EMPLOYEE, base()));
  await allowed('an administrator can', () => s.software.create(ADMIN, base()));

  await refused('a product with no name is refused', () => s.software.create(ADMIN, base({ n: ' ' })));
  await refused('a product with no vendor is refused',
    () => s.software.create(ADMIN, base({ vendor: '' })));
  await refused('a duplicate name is refused',
    () => s.software.create(ADMIN, base({ n: SOFTWARE[0].n })));
  await refused('negative seats are refused', () => s.software.create(ADMIN, base({ seats: -1 })));
  await refused('a negative cost is refused', () => s.software.create(ADMIN, base({ unitCost: -5 })));
  await refused('no renewal date is refused', () => s.software.create(ADMIN, base({ renewsOn: '' })));
  await refused('an owner who does not exist is refused',
    () => s.software.create(ADMIN, base({ ownerId: 'EMP-nobody' })));

  /* ---- seats ---- */

  const fresh = await s.software.create(ADMIN, base({ seats: 2 }));

  await refused('a manager cannot assign a seat',
    () => s.software.assignSeat(MANAGER, fresh.id, DEMO_EMP.id));
  await allowed('an administrator can',
    () => s.software.assignSeat(ADMIN, fresh.id, DEMO_EMP.id));
  await refused('the same person cannot hold two seats on one product',
    () => s.software.assignSeat(ADMIN, fresh.id, DEMO_EMP.id));
  await refused('a seat cannot go to somebody who does not exist',
    () => s.software.assignSeat(ADMIN, fresh.id, 'EMP-nobody'));

  /*
   * The rule that keeps the register honest: the seat count is what the
   * company pays for, so it cannot be cut below the people already holding one.
   */
  await refused('seats cannot be cut below the people holding them',
    () => s.software.update(ADMIN, fresh.id, { seats: 0 }));
  await allowed('but can be raised', () => s.software.update(ADMIN, fresh.id, { seats: 25 }));

  await refused('a product somebody holds cannot be removed',
    () => s.software.remove(ADMIN, fresh.id));

  const seat = SEATS.find((x) => x.productId === fresh.id && x.empId === DEMO_EMP.id)!;
  await refused('an employee cannot revoke a seat', () => s.software.revokeSeat(EMPLOYEE, seat.id));
  await allowed('an administrator can', () => s.software.revokeSeat(ADMIN, seat.id));
  await allowed('and then the product can be removed', () => s.software.remove(ADMIN, fresh.id));

  /* A seat the asset register issued is refused here, by design. */
  const kitSeat = SEATS.find((x) => x.assetId);
  if (kitSeat) {
    await refused('a seat issued as an asset is returned in the asset register, not here',
      () => s.software.revokeSeat(ADMIN, kitSeat.id));
  }

  /* A manager may revoke on their own line, and nowhere else. */
  const lineProduct = await s.software.create(ADMIN, base({ seats: 5 }));
  const report = Object.values(EMAP).find((e) => e.managerId === DEMO_MGR.id && e.status === 'Active');
  if (report) {
    await s.software.assignSeat(ADMIN, lineProduct.id, report.id);
    const theirs = SEATS.find((x) => x.productId === lineProduct.id && x.empId === report.id)!;
    await allowed("a manager can revoke on their own line",
      () => s.software.revokeSeat(MANAGER, theirs.id));
  }
  const outside = Object.values(EMAP).find((e) =>
    e.managerId !== DEMO_MGR.id && e.id !== DEMO_MGR.id && e.status === 'Active')!;
  await s.software.assignSeat(ADMIN, lineProduct.id, outside.id);
  const notTheirs = SEATS.find((x) => x.productId === lineProduct.id && x.empId === outside.id)!;
  await refused('and nowhere else', () => s.software.revokeSeat(MANAGER, notTheirs.id));

  /* ---- the audit trail ---- */

  const detail = (await s.software.get(ADMIN, lineProduct.id))!;
  const actions = detail.history.map((h) => h.action);
  check('creating is recorded', actions.includes('software.created'), true);
  check('assigning a seat is recorded', actions.includes('software.seat_assigned'), true);
  check('the trail is newest first',
    detail.history.every((h, i) => i === 0 || detail.history[i - 1].at >= h.at), true);
  check('every entry names who did it',
    detail.history.filter((h) => !h.actorLabel).length, 0);

  /* ---- clean up ---- */

  for (const x of SEATS.filter((y) => y.productId === lineProduct.id)) {
    SEATS.splice(SEATS.indexOf(x), 1);
  }
  for (const p of SOFTWARE.filter((x) => x.vendor === 'Check Vendor')) {
    SOFTWARE.splice(SOFTWARE.indexOf(p), 1);
  }
  check('the check left no products behind',
    SOFTWARE.filter((p) => p.vendor === 'Check Vendor').length, 0);
  check('the check left no seats behind',
    SEATS.filter((x) => !SOFTWARE.some((p) => p.id === x.productId)).length, 0);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} software checks failed`);
    process.exit(1);
  }
  console.log('the software register agrees with the asset register');
})();
