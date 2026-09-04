/**
 * Documents, exits, IT assets and the security register.
 *
 * Four small domains that share a shape: mostly reads, with a handful of
 * transitions that have to be refused rather than repeated — an asset is
 * allocated from stock, an exit is settled once.
 */

import { TODAY, ymd } from '../../lib/dates';
import { sum } from '../../lib/collections';
import { DOCS, DOC_TYPES, ASSETS } from '../../data/announcements';
import { EMAP } from '../../data/employees';
import { EXITS, exitOf, fnfSettlement } from '../../data/exit';
import { leaveBalance } from '../../data/leave';
import { activeLoans } from '../../data/loans';
import { ASSET_REQS, arOpen } from '../../data/assetWorkflow';
import { pendingRecovery } from '../../data/assets';
import { AUDIT, AUDIT_CATS, CONTROLS, POSTURE, RETENTION } from '../../data/security';
import { ONBOARD } from '../../data/onboarding';
import type {
  AssetService, DocumentService, ExitDetail, ExitService, OnboardingService, SecurityService,
} from '../contracts';
import { ok } from './util';

export const documentService: DocumentService = {
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
  requests() { return ok(ASSET_REQS.slice()); },
  openRequests() { return ok(arOpen()); },
  pendingRecovery() { return ok(pendingRecovery()); },

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

  setTask(id, key, done) {
    const o = ONBOARD.find((x) => x.id === id);
    if (!o) return Promise.reject(new Error('No such onboarding journey: ' + id));
    const t = o.tasks.find((x) => x.k === key);
    if (!t) return Promise.reject(new Error('No task ' + key + ' on ' + id));
    t.done = done;
    return ok(o);
  },
};
