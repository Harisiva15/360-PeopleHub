/**
 * Documents, exits, IT assets and the security register.
 *
 * Four small domains that share a shape: mostly reads, with a handful of
 * transitions that have to be refused rather than repeated — an asset is
 * allocated from stock, an exit is settled once.
 */

import { addDays, parseYmd, TODAY, ymd } from '../../lib/dates';
import { sum } from '../../lib/collections';
import { DOCS, DOC_TYPES, ASSETS } from '../../data/announcements';
import { DEMO_EMP, EMAP, empName, HRHEAD } from '../../data/employees';
import { salaryStructure, taxNewRegime } from '../../data/salary';
import { ytdFor } from '../../data/letters';
import { CUR_CYCLE, reviewOf } from '../../data/performance';
import { EXITS, exitOf, fnfSettlement } from '../../data/exit';
import { leaveBalance } from '../../data/leave';
import { activeLoans } from '../../data/loans';
import { ASSET_REQS, arOpen } from '../../data/assetWorkflow';
import { assetKPI, pendingRecovery } from '../../data/assets';
import { AUDIT, AUDIT_CATS, CONTROLS, POSTURE, RETENTION } from '../../data/security';
import { ONBOARD, ONB_TEMPLATE } from '../../data/onboarding';
import type {
  Asset, AssetRequest, AssetService, DocumentService, ExitDetail, ExitService, Onboarding,
  OnboardingService, SecurityService,
} from '../contracts';
import { ok } from './util';

export const documentService: DocumentService = {
  letterContext(empId) {
    const e = EMAP[empId];
    if (!e) return Promise.reject(new Error('No such employee: ' + empId));
    const salary = salaryStructure(e);
    const x = exitOf(e.id);
    return ok({
      employee: e,
      signatory: { name: HRHEAD.name, designation: HRHEAD.designation },
      managerName: empName(e.managerId || ''),
      salary,
      lastWorkingDay: x ? x.lwd : null,
      review: reviewOf(e.id) ?? null,
      cycleName: CUR_CYCLE.name,
      ytd: ytdFor(e.id),
      annualTax: taxNewRegime(salary.grossA),
    });
  },

  documents(empIds) {
    if (!empIds) return ok(DOCS.slice());
    const want = new Set(empIds);
    return ok(DOCS.filter((d) => want.has(d.empId)));
  },
  documentTypes() {
    return ok(DOC_TYPES.slice());
  },
};

export const exitService: ExitService = {
  list() {
    return ok(EXITS.slice());
  },

  detail(exitId) {
    const x = EXITS.find((e) => e.id === exitId) ?? exitOf(exitId);
    if (!x) return ok(null);
    const employee = EMAP[x.empId];
    if (!employee) return ok(null);
    const el = leaveBalance(x.empId, 'EL');
    const out: ExitDetail = {
      exit: x,
      employee,
      settlement: fnfSettlement(x),
      leaveAvail: el ? el.avail : 0,
      loansOutstanding: sum(activeLoans(x.empId), (l) => l.outstanding),
    };
    return ok(out);
  },

  setClearance(exitId, index, done) {
    const x = EXITS.find((e) => e.id === exitId);
    if (!x) return Promise.reject(new Error('No such exit: ' + exitId));
    const line = x.clearance[index];
    if (!line) return Promise.reject(new Error('No clearance line ' + index));
    line.done = done;
    return ok(x);
  },

  /** Settling closes the exit; the clearance has to be complete first. */
  settle(exitId) {
    const x = EXITS.find((e) => e.id === exitId);
    if (!x) return Promise.reject(new Error('No such exit: ' + exitId));
    if (x.status === 'Settled') return Promise.reject(new Error('Already settled'));
    const outstanding = x.clearance.filter((c) => !c.done).length;
    if (outstanding) return Promise.reject(new Error(outstanding + ' clearance item(s) still open'));
    x.status = 'Settled';
    return ok(x);
  },
};

export const assetService: AssetService = {
  list() { return ok(ASSETS.slice()); },
  kpi() { return ok(assetKPI()); },
  requests() { return ok(ASSET_REQS.slice()); },
  openRequests() { return ok(arOpen()); },
  pendingRecovery() { return ok(pendingRecovery()); },

  addAsset(draft) {
    if (!draft.type?.trim()) return Promise.reject(new Error('Say which item this is'));
    const asset: Asset = {
      id: 'AST-' + (ASSETS.length + 1),
      empId: draft.empId ?? null,
      type: draft.type.trim(),
      serial: draft.serial ?? '',
      issued: draft.empId ? ymd(TODAY) : null,
      status: draft.empId ? 'Assigned' : 'In stock',
      cat: draft.cat || 'PERIPH',
      cost: draft.cost ?? 0,
      vendor: draft.vendor ?? '',
      tag: draft.tag || 'AT-' + String(ASSETS.length + 1).padStart(4, '0'),
      purchased: draft.purchased ?? ymd(TODAY),
      warrantyEnd: draft.warrantyEnd ?? '',
      site: draft.empId ? (EMAP[draft.empId]?.site ?? '') : '',
      condition: 'Good',
    };
    ASSETS.unshift(asset);
    return ok(asset);
  },

  requestAsset(draft) {
    if (!draft.type?.trim()) return Promise.reject(new Error('Say which item you need'));
    if (!draft.reason?.trim()) return Promise.reject(new Error('Give a reason for the request'));
    const req: AssetRequest = {
      id: 'AR-' + (ASSET_REQS.length + 1),
      empId: DEMO_EMP.id,
      type: draft.type.trim(),
      cat: draft.cat || 'PERIPH',
      cost: draft.cost ?? 0,
      reason: draft.reason.trim(),
      note: '',
      raisedOn: ymd(TODAY),
      status: 'Pending',
      entitled: false,
      /* Above the threshold, a manager's approval is not enough. */
      needsFinance: (draft.cost ?? 0) > 25000,
      managerId: EMAP[DEMO_EMP.id]?.managerId ?? null,
      approvedBy: null,
      approvedOn: null,
      rejectReason: null,
      fulfilledOn: null,
      assetId: null,
    };
    ASSET_REQS.unshift(req);
    return ok(req);
  },

  actOnRequest(id, status) {
    const r = ASSET_REQS.find((x) => x.id === id);
    if (!r) return Promise.reject(new Error('No such asset request: ' + id));
    if (r.status === status) return ok(r);
    r.status = status;
    if (status === 'Fulfilled') r.fulfilledOn = ymd(TODAY);
    return ok(r);
  },

  allocate(assetId, empId) {
    const a = ASSETS.find((x) => x.id === assetId);
    if (!a) return Promise.reject(new Error('No such asset: ' + assetId));
    if (a.status !== 'In stock') return Promise.reject(new Error('That asset is ' + a.status.toLowerCase() + ', not in stock'));
    const e = EMAP[empId];
    if (!e) return Promise.reject(new Error('No such employee: ' + empId));
    a.empId = empId;
    a.status = 'Assigned';
    a.issued = ymd(TODAY);
    a.site = e.site;
    a.country = e.country;
    return ok(a);
  },

  markReturned(assetId) {
    const a = ASSETS.find((x) => x.id === assetId);
    if (!a) return Promise.reject(new Error('No such asset: ' + assetId));
    if (a.status !== 'Assigned') return Promise.reject(new Error('That asset is not currently issued'));
    a.recoveredFrom = a.empId ?? undefined;
    a.recoveredOn = ymd(TODAY);
    a.empId = null;
    a.status = 'In stock';
    return ok(a);
  },
};

export const securityService: SecurityService = {
  audit(cat, sev) {
    let out = AUDIT.slice();
    if (cat) out = out.filter((a) => a.cat === cat);
    if (sev) out = out.filter((a) => a.sev === sev);
    return ok(out);
  },
  auditCategories() { return ok(AUDIT_CATS.slice()); },
  posture() { return ok(POSTURE.slice()); },
  controls() { return ok(CONTROLS.slice()); },
  retention() { return ok(RETENTION.slice()); },
};

export const onboardingService: OnboardingService = {
  list() { return ok(ONBOARD.slice()); },

  create(draft) {
    if (!draft.name?.trim()) return Promise.reject(new Error('The joiner needs a name'));
    if (!draft.doj) return Promise.reject(new Error('The joiner needs a joining date'));
    const journey: Onboarding = {
      id: 'ONB-' + (ONBOARD.length + 1),
      candId: draft.candId ?? '',
      name: draft.name.trim(),
      reqId: '',
      dept: draft.dept,
      designation: draft.designation,
      site: draft.site ?? 'CHN',
      doj: draft.doj,
      managerId: draft.managerId ?? '',
      buddyId: draft.buddyId ?? '',
      ctc: draft.ctc ?? 0,
      status: draft.doj <= ymd(TODAY) ? 'In Progress' : 'Pre-boarding',
      bgv: 'Not started',
      /* The standard checklist, dated around the joining date. */
      tasks: ONB_TEMPLATE.map((t) => ({
        k: t.k, n: t.n, owner: t.owner, day: t.day,
        due: ymd(addDays(parseYmd(draft.doj), t.day)),
        done: false, doneOn: null,
      })),
      docs: [],
    };
    ONBOARD.unshift(journey);
    return ok(journey);
  },

  setTask(id, key, done) {
    const o = ONBOARD.find((x) => x.id === id);
    if (!o) return Promise.reject(new Error('No such onboarding journey: ' + id));
    const t = o.tasks.find((x) => x.k === key);
    if (!t) return Promise.reject(new Error('No task ' + key + ' on ' + id));
    t.done = done;
    /* Status is derived from the checklist, never set alongside it. */
    o.status = o.tasks.every((x) => x.done) ? 'Completed' : o.doj <= ymd(TODAY) ? 'In Progress' : o.status;
    return ok(o);
  },

  complete(id) {
    const o = ONBOARD.find((x) => x.id === id);
    if (!o) return Promise.reject(new Error('No such onboarding journey: ' + id));
    const open = o.tasks.filter((t) => !t.done).length;
    if (open) return Promise.reject(new Error(open + ' checklist item(s) still open'));
    o.status = 'Completed';
    return ok(o);
  },
};
