/**
 * Document collection — what has been asked for, and what has arrived.
 *
 * Shares the RNG stream with onboarding, so the journeys and their checklists
 * are drawn in a fixed order and the demo looks the same on every reload.
 *
 * The template mirrors the server's `JOINER_DOCUMENTS` exactly. Regulated
 * identifiers are deliberately absent: this tenant does not store PAN or bank
 * account numbers, and asking for a document the system cannot hold would be
 * theatre.
 */

import './onboarding';

import { addDays, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, pick } from '../lib/rng';
import { ONBOARD } from './onboarding';
import { EMP } from './employees';
import type { DocRequest } from '../services/contracts';

/** [kind, label, mandatory] — the standard checklist for an Indian joiner. */
export const JOINER_DOCUMENTS: [string, string, boolean][] = [
  ['photo_id', 'Government photo ID', true],
  ['address_proof', 'Proof of address', true],
  ['education', 'Highest degree certificate', true],
  ['experience', 'Experience / relieving letter', true],
  ['payslips', 'Last three payslips', false],
  ['offer_signed', 'Signed offer letter', true],
  ['bank_mandate', 'Bank mandate form', false],
  ['photo', 'Passport photograph', false],
  ['medical', 'Pre-employment medical', false],
];

export const DOC_REQS: DocRequest[] = [];

let seq = 0;
const nextId = () => 'DR-' + String(++seq).padStart(4, '0');

/** A blank request, which is what every document starts as. */
export function blankRequest(
  scope: { journeyId?: string; empId?: string },
  kind: string,
  label: string,
  mandatory: boolean,
  due: string | null,
): DocRequest {
  return {
    id: nextId(),
    journeyId: scope.journeyId ?? null,
    empId: scope.empId ?? null,
    kind,
    label,
    mandatory,
    status: 'pending',
    due,
    receivedOn: null,
    verifiedBy: null,
    verifiedOn: null,
    note: '',
    hasFile: false,
  };
}

(function genRequests() {
  const verifier = EMP.find((e) => e.dept === 'HR')?.id ?? EMP[0].id;

  ONBOARD.forEach((j) => {
    /* Chasing starts a week before the joining date, or it is no use. */
    const due = ymd(addDays(parseYmd(j.doj), -7));
    const overdue = due < ymd(TODAY);

    JOINER_DOCUMENTS.forEach(([kind, label, mandatory]) => {
      const r = blankRequest({ journeyId: j.id }, kind, label, mandatory, due);

      /*
       * Once the due date has passed most documents are in, and the mandatory
       * ones are chased harder than the optional ones — an intake screen whose
       * outstanding list is always empty teaches nobody anything.
       */
      if (overdue && chance(mandatory ? 0.85 : 0.55)) {
        r.receivedOn = ymd(addDays(parseYmd(due), -pick([1, 2, 3, 5, 8])));
        if (chance(0.7)) {
          r.status = 'verified';
          r.verifiedBy = verifier;
          r.verifiedOn = ymd(addDays(parseYmd(r.receivedOn), 1));
        } else if (chance(0.2)) {
          r.status = 'rejected';
          r.note = pick([
            'Scan is unreadable',
            'Expired — please send a current copy',
            'Name does not match the offer',
          ]);
        } else {
          r.status = 'received';
        }
      } else if (!mandatory && chance(0.15)) {
        r.status = 'waived';
        r.note = 'Waived at the hiring manager’s request';
      }

      DOC_REQS.push(r);
    });
  });
})();

/** Everything asked for in one scope. Ordered as the template lists them. */
export const requestsFor = (q: { journeyId?: string; empId?: string }): DocRequest[] =>
  DOC_REQS.filter((r) => (q.journeyId ? r.journeyId === q.journeyId : true)
    && (q.empId ? r.empId === q.empId : true));
