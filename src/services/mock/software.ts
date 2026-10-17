/**
 * The software estate, in memory.
 *
 * Two write surfaces that look similar and are not: a product is a contract
 * the company signs, and a seat is an access grant to a named person. The
 * first is procurement, the second is closer to security — which is why
 * revoking a seat is allowed on a manager's own line while changing a renewal
 * date is not.
 */

import { sortBy } from '../../lib/collections';
import { uid } from '../../lib/rng';
import { TODAY, ymd } from '../../lib/dates';
import { EMAP } from '../../data/employees';
import {
  SEATS, SOFTWARE, SOFTWARE_CATS, annualCost, isDormant, isOverAllocated,
  productOf, renewalCalendar, renewsInDays, seatsHeldBy, seatsOf, softwareKPI, wastedCost,
} from '../../data/software';
import type { SoftwareProduct, SoftwareSeat } from '../../data/software';
import { recordAudit } from '../../data/audit';
import { visibleIds } from '../../state/rbac';
import type {
  Caller, SoftwareDetail, SoftwareDraft, SoftwareFilter, SoftwareRow,
  SoftwareSeatRow, SoftwareService,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));


const rowOf = (p: SoftwareProduct): SoftwareRow => {
  const seats = seatsOf(p.id);
  return {
    product: p,
    assigned: seats.length,
    free: Math.max(0, p.seats - seats.length),
    dormant: seats.filter((s) => isDormant(s)).length,
    annualCost: annualCost(p),
    wastedCost: wastedCost(p),
    renewsInDays: renewsInDays(p),
    overAllocated: isOverAllocated(p),
  };
};

const seatRow = (s: SoftwareSeat): SoftwareSeatRow => ({
  seat: s,
  name: EMAP[s.empId]?.name ?? s.empId,
  dept: EMAP[s.empId]?.dept ?? '',
  dormant: isDormant(s),
  daysIdle: s.lastUsedOn
    ? Math.max(0, Math.round((Date.parse(ymd(TODAY)) - Date.parse(s.lastUsedOn)) / 86400000))
    : null,
});

function matches(r: SoftwareRow, f: SoftwareFilter): boolean {
  const p = r.product;
  if (f.cat && p.cat !== f.cat) return false;
  if (f.vendor && p.vendor !== f.vendor) return false;
  if (f.status && p.status !== f.status) return false;
  if (f.ownerId && p.ownerId !== f.ownerId) return false;
  if (f.renewingWithin != null && (r.renewsInDays < 0 || r.renewsInDays > f.renewingWithin)) return false;
  if (f.hasDormant && !r.dormant) return false;
  if (f.q?.trim()) {
    const hay = `${p.n} ${p.vendor} ${p.plan}`.toLowerCase();
    if (!hay.includes(f.q.trim().toLowerCase())) return false;
  }
  return true;
}

/** An administrator writes the estate; everyone else reads. */
const mayWrite = (c: Caller) => c.role === 'admin';

/**
 * Whose seat this caller may revoke.
 *
 * A manager taking a seat back from somebody who has left their team is
 * ordinary housekeeping, and making them raise a ticket for it is how dormant
 * seats accumulate. Taking one from outside their line is not theirs to do.
 */
function mayRevoke(c: Caller, empId: string): boolean {
  if (c.role === 'admin') return true;
  if (c.role === 'manager') return visibleIds('manager', c.meId).includes(empId);
  return false;
}

const validate = (d: Partial<SoftwareDraft>, existing?: SoftwareProduct): string | null => {
  const n = d.n ?? existing?.n;
  if (!n?.trim()) return 'Give the product a name';
  const clash = SOFTWARE.find((p) => p.n.toLowerCase() === n.trim().toLowerCase()
    && p.id !== existing?.id);
  if (clash) return `${clash.n} is already in the register`;
  if (!(d.vendor ?? existing?.vendor)?.trim()) return 'Name the vendor';
  const cat = d.cat ?? existing?.cat;
  if (!cat || !SOFTWARE_CATS.includes(cat)) return 'Choose a category';
  const seats = d.seats ?? existing?.seats;
  if (seats == null || !Number.isFinite(seats) || seats < 0) return 'Seats must be zero or more';
  const cost = d.unitCost ?? existing?.unitCost;
  if (cost == null || !Number.isFinite(cost) || cost < 0) return 'Cost per seat must be zero or more';
  if (!(d.renewsOn ?? existing?.renewsOn)) return 'Give it a renewal date';
  const owner = d.ownerId ?? existing?.ownerId;
  if (owner && !EMAP[owner]) return 'No such owner';
  return null;
};

export const softwareService: SoftwareService = {
  list(c, f = {}) {
    if (c.role === 'employee') return refuse('Your role cannot browse the software estate');
    const rows = SOFTWARE.map(rowOf).filter((r) => matches(r, f));
    return ok(sortBy(rows, (r) => -r.annualCost));
  },

  get(c, id) {
    if (c.role === 'employee') return refuse('Your role cannot browse the software estate');
    const p = productOf(id);
    if (!p) return ok(null);
    const detail: SoftwareDetail = {
      ...rowOf(p),
      seats: seatsOf(p.id).map(seatRow),
      history: recordAudit.forSubject('software', p.id),
    };
    return ok(detail);
  },

  /**
   * What the signed-in person holds.
   *
   * Deliberately not `list` with a filter: an employee gets their own seats
   * and no view of the estate, its cost or who else is on it, so this returns
   * a different shape rather than a narrower slice of the same one.
   */
  mine(c) {
    return ok(sortBy(
      seatsHeldBy(c.meId).map((s) => ({
        seat: s,
        product: productOf(s.productId)!,
        dormant: isDormant(s),
      })).filter((x) => x.product),
      (x) => x.product.n,
    ));
  },

  stats(c) {
    if (c.role === 'employee') return refuse('Your role cannot browse the software estate');
    return ok(softwareKPI());
  },

  renewals(c, withinDays = 90) {
    if (c.role === 'employee') return refuse('Your role cannot browse the software estate');
    return ok(renewalCalendar().filter((r) => r.inDays <= withinDays));
  },

  create(c, draft) {
    if (!mayWrite(c)) return refuse('Only an administrator can add software');
    const bad = validate(draft);
    if (bad) return refuse(bad);
    const p: SoftwareProduct = {
      id: uid('SW'),
      n: draft.n.trim(),
      vendor: draft.vendor.trim(),
      cat: draft.cat,
      plan: draft.plan?.trim() ?? '',
      seats: draft.seats,
      unitCost: draft.unitCost,
      billing: draft.billing ?? 'Annual',
      renewsOn: draft.renewsOn,
      ownerId: draft.ownerId ?? null,
      status: draft.status ?? 'Active',
      sso: draft.sso ?? false,
      holdsPersonalData: draft.holdsPersonalData ?? false,
      notes: draft.notes?.trim() ?? '',
    };
    SOFTWARE.push(p);
    recordAudit.write(c, 'software.created', 'software', p.id, `${p.n} · ${p.seats} seats`);
    return ok(p);
  },

  update(c, id, patch) {
    if (!mayWrite(c)) return refuse('Only an administrator can change software');
    const p = productOf(id);
    if (!p) return refuse('No such product');
    const bad = validate(patch, p);
    if (bad) return refuse(bad);

    /*
     * Cutting seats below the number of people holding one would put the
     * register into a state the company would be billed for and nobody could
     * see. Revoke the seats first — the module says which ones.
     */
    const held = seatsOf(p.id).length;
    if (patch.seats != null && patch.seats < held) {
      return refuse(`${held} people hold a seat — revoke seats before cutting the count to ${patch.seats}`);
    }

    const changed = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== (p as unknown as Record<string, unknown>)[k],
    );
    Object.assign(p, patch);
    if (changed.length) {
      recordAudit.write(c, 'software.updated', 'software', p.id, `${p.n} · ${changed.join(', ')}`);
    }
    return ok(p);
  },

  remove(c, id) {
    if (!mayWrite(c)) return refuse('Only an administrator can remove software');
    const i = SOFTWARE.findIndex((p) => p.id === id);
    if (i < 0) return refuse('No such product');
    const held = seatsOf(id).length;
    if (held) return refuse(`${held} people still hold a seat — revoke them first`);
    const [p] = SOFTWARE.splice(i, 1);
    recordAudit.write(c, 'software.removed', 'software', p.id, p.n);
    return ok(p);
  },

  assignSeat(c, productId, empId) {
    if (!mayWrite(c)) return refuse('Only an administrator can assign a seat');
    const p = productOf(productId);
    if (!p) return refuse('No such product');
    if (p.status === 'Cancelled') return refuse(`${p.n} has been cancelled`);
    const e = EMAP[empId];
    if (!e) return refuse('No such employee');
    if (e.status !== 'Active') return refuse(`${e.name} is not an active employee`);
    if (SEATS.some((s) => s.productId === productId && s.empId === empId)) {
      return refuse(`${e.name} already holds a seat on ${p.n}`);
    }
    const seat: SoftwareSeat = {
      id: uid('SEAT'),
      productId,
      empId,
      assignedOn: ymd(TODAY),
      lastUsedOn: null,
      assetId: null,
    };
    SEATS.push(seat);
    recordAudit.write(c, 'software.seat_assigned', 'software', productId, `${p.n} · ${e.name}`);
    return ok(seat);
  },

  revokeSeat(c, seatId) {
    const i = SEATS.findIndex((s) => s.id === seatId);
    if (i < 0) return refuse('No such seat');
    const seat = SEATS[i];
    if (!mayRevoke(c, seat.empId)) {
      return refuse('That seat belongs to somebody outside the people you can see');
    }
    /*
     * A seat the asset register issued is held there too. Revoking only this
     * copy would leave the two disagreeing, which is the exact failure this
     * module was built to avoid — so it refuses and says where to go.
     */
    if (seat.assetId) {
      return refuse('This seat was issued as an asset — return it in the asset register');
    }
    SEATS.splice(i, 1);
    const p = productOf(seat.productId);
    recordAudit.write(c, 'software.seat_revoked', 'software', seat.productId,
      `${p?.n ?? seat.productId} · ${EMAP[seat.empId]?.name ?? seat.empId}`);
    return ok(seat);
  },
};
