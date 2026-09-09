/**
 * New joiners, in memory.
 *
 * The demo has to keep working, so this is a real implementation rather than a
 * stub that throws — someone clicking "Add employee" on the public site should
 * see the flow, not an error.
 *
 * It models the same two outcomes as the server: an admin's request is
 * approved on the spot, a manager's queues. It cannot model *who* is asking,
 * because the mock has no session — so the caller passes the role in, which is
 * exactly the shortcut the real service must never take.
 */

import { EMP } from '../../data/employees';
import { uid } from '../../lib/rng';
import type { JoinerDraft, JoiningRequest, JoinersService } from '../contracts';
import { ok } from './util';

const queue: JoiningRequest[] = [];

/** Continues the code series rather than restarting it. */
function nextCode(): string {
  const numbers = EMP.map((e) => Number(/\d+$/.exec(e.code)?.[0] ?? 0));
  const prefix = /^[A-Za-z]+/.exec(EMP[0]?.code ?? 'VHM')?.[0] ?? 'VHM';
  return `${prefix}${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}`;
}

function toRequest(draft: JoinerDraft, status: JoiningRequest['status']): JoiningRequest {
  return {
    id: uid('JR'),
    fullName: draft.fullName,
    workEmail: draft.workEmail,
    employeeCode: draft.employeeCode ?? null,
    designation: draft.designation ?? null,
    dept: draft.dept ?? null,
    site: draft.site ?? null,
    grade: draft.grade ?? null,
    joiningOn: draft.joiningOn,
    employmentType: draft.employmentType ?? 'permanent',
    status,
    requestedBy: null,
    requestedByName: null,
    requestedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
    employeeId: null,
  };
}

/** Turn an approved request into a row the directory will show. */
function materialise(r: JoiningRequest): void {
  const code = r.employeeCode ?? nextCode();
  EMP.push({
    id: uid('E'),
    code,
    name: r.fullName,
    gender: 'X',
    dob: '1990-01-01',
    doj: r.joiningOn,
    dol: null,
    email: r.workEmail,
    phone: '',
    dept: r.dept ?? 'ENG',
    designation: r.designation ?? 'Engineer',
    grade: (r.grade ?? 'L2') as never,
    site: r.site ?? 'CHN',
    country: 'IN',
    ccy: 'INR',
    entityId: 'IN',
    managerId: null,
    status: 'Active',
    empType: r.employmentType === 'contract' ? 'Contract' : 'Full-time',
    ctc: 0,
    bank: '', acct: '', ifsc: '',
    blood: '', address: '', emergency: '',
    skills: [],
    role: 'employee',
    reports: [],
    shift: 'IN',
    probation: true,
    exitReason: null,
    notice: 30,
    pan: null, uan: null, pf: null, esi: null,
  } as never);
  r.employeeId = code;
}

export const joinersService: JoinersService = {
  request(draft) {
    const existing = EMP.find((e) => e.email.toLowerCase() === draft.workEmail.toLowerCase());
    if (existing) {
      return Promise.reject(new Error(`${existing.code} already uses that email address`));
    }
    // No session here, so the demo behaves as the permissive case and creates
    // the person. The server decides this from the caller's role instead.
    const r = toRequest(draft, 'approved');
    r.decidedAt = new Date().toISOString();
    materialise(r);
    queue.unshift(r);
    return ok(r);
  },

  list(status) {
    return ok(status ? queue.filter((r) => r.status === status) : queue.slice());
  },

  approve(id) {
    const r = queue.find((x) => x.id === id);
    if (!r) return Promise.reject(new Error('no such joining request'));
    if (r.status !== 'pending') return Promise.reject(new Error(`already ${r.status}`));
    r.status = 'approved';
    r.decidedAt = new Date().toISOString();
    materialise(r);
    return ok(r);
  },

  reject(id) {
    const r = queue.find((x) => x.id === id);
    if (!r) return Promise.reject(new Error('no such joining request'));
    if (r.status !== 'pending') return Promise.reject(new Error(`already ${r.status}`));
    r.status = 'rejected';
    r.decidedAt = new Date().toISOString();
    return ok(r);
  },
};
