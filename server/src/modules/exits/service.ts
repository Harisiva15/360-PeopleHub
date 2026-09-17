/**
 * Exits — notice, clearance, and the full-and-final settlement.
 *
 * **Clearance gates settlement, and a CHECK cannot say so.** The schema
 * comments on `exit_clearance` admit it: a constraint cannot see sibling rows,
 * so "no department may still be pending" has to live here. It is the one rule
 * in this module that protects real money — settling with IT clearance
 * outstanding means paying someone out while they still hold a laptop.
 *
 * **The settlement is computed here and stored on payment.** Until an exit
 * settles, the figure is a live calculation: leave balances move, loans are
 * repaid, a claim gets approved. Once paid it is frozen into
 * `exit_settlement`, because what somebody was actually paid does not change
 * when their leave balance is later corrected.
 *
 * **Gratuity vests at five years and not before.** That is the Payment of
 * Gratuity Act, not a policy this tenant chose, so it is a rule in code rather
 * than a configurable number somebody can set to zero by accident.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { PF_WAGE_CAP, dailyRateFor, structureFor, taxNewRegime } from '../payroll/rules.ts';
import type { Country } from '../payroll/rules.ts';

export class ExitError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

const TO_STATUS: Record<string, string> = {
  notice_period: 'Notice Period', in_clearance: 'In Clearance',
  settled: 'Settled', withdrawn: 'Settled',
};

/** The departments that have to sign off before anyone is paid out. */
const CLEARANCE_DEPARTMENTS = ['IT', 'Finance', 'HR', 'Manager', 'Admin'];

export interface Clearance {
  k: string;
  d: string;
  done: boolean;
  on: string | null;
  owner: string;
}

export interface ExitRecord {
  id: string;
  empId: string;
  type: string;
  resignedOn: string;
  noticeDays: number;
  lwd: string;
  reason: string;
  destination: string;
  status: string;
  buyout: number;
  clearance: Clearance[];
  interview: { done: boolean; wouldRejoin?: boolean; comments?: string };
}

export interface FnF {
  perDay: number;
  payDays: number;
  daysInMonth: number;
  salary: number;
  elDays: number;
  encash: number;
  yrs: number;
  gratuity: number;
  pending: number;
  noticeShort: number;
  loanDue: number;
  advDue: number;
  pf: number;
  ptax: number;
  tds: number;
  gross: number;
  ded: number;
  net: number;
}

const PROJECTION = `
  SELECT x.id, x.employee_id, x.kind, x.resigned_on, x.notice_days,
         x.last_working_day, x.reason, x.destination, x.status, x.buyout_days,
         COALESCE(cl.lines, '[]'::jsonb) AS clearance,
         (i.id IS NOT NULL) AS interview_done,
         i.would_recommend, i.feedback
    FROM exit_record x
    LEFT JOIN exit_interview i ON i.exit_id = x.id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'k', c.department, 'd', c.department || ' clearance',
               'done', c.status = 'cleared', 'on', c.cleared_on,
               'owner', c.department) ORDER BY c.department) AS lines
        FROM exit_clearance c WHERE c.exit_id = x.id
    ) cl ON true`;

const toExit = (r: Record<string, unknown>): ExitRecord => ({
  id: r.id as string,
  empId: r.employee_id as string,
  type: r.kind as string,
  resignedOn: r.resigned_on as string,
  noticeDays: Number(r.notice_days),
  lwd: r.last_working_day as string,
  reason: (r.reason as string) ?? '',
  destination: (r.destination as string) ?? '',
  status: TO_STATUS[r.status as string] ?? 'Notice Period',
  buyout: Number(r.buyout_days ?? 0),
  clearance: r.clearance as Clearance[],
  interview: {
    done: Boolean(r.interview_done),
    ...(r.would_recommend === null ? {} : { wouldRejoin: Boolean(r.would_recommend) }),
    ...(r.feedback ? { comments: r.feedback as string } : {}),
  },
});

/** An exit carries a settlement figure, so it is not everybody's reading. */
function mayHandle(caller: Caller): boolean {
  return caller.role === 'admin' || caller.role === 'manager';
}

export async function listExits(caller: Caller): Promise<ExitRecord[]> {
  if (!mayHandle(caller)) {
    // Your own exit is yours to see.
    return withTenantReadOnly(caller, async (db) => {
      const { rows } = await db.query(
        `${PROJECTION} WHERE x.employee_id = $1`, [caller.employeeId]);
      return rows.map(toExit);
    });
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${PROJECTION} ORDER BY x.last_working_day DESC`);
    return rows.map(toExit);
  });
}

export interface NewExit {
  empId: string;
  type?: string;
  resignedOn?: string;
  noticeDays?: number;
  lwd: string;
  reason?: string;
  destination?: string;
  buyout?: number;
}

/**
 * Record a resignation.
 *
 * The clearance checklist is created with it, because an exit with no
 * checklist is one that can settle immediately — and settling is the step that
 * pays money out.
 */
export async function raiseExit(caller: Caller, draft: NewExit): Promise<ExitRecord> {
  if (!mayHandle(caller)) {
    throw new ExitError('only a manager or admin may record an exit', 'forbidden');
  }
  if (!draft.lwd) throw new ExitError('an exit needs a last working day', 'invalid');

  return withTenant(caller, async (db) => {
    const emp = await db.query(
      "SELECT id, status FROM employee WHERE id = $1", [draft.empId]);
    if (!emp.rows[0]) throw new ExitError('no such employee', 'not_found');
    if (emp.rows[0].status === 'exited') {
      throw new ExitError('that person has already left', 'already_exited');
    }

    let id: string;
    try {
      const ins = await db.query(
        `INSERT INTO exit_record
           (employee_id, kind, resigned_on, notice_days, last_working_day,
            reason, destination, buyout_days)
         VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5::date,$6,$7,$8)
         RETURNING id`,
        [draft.empId, draft.type ?? 'resignation', draft.resignedOn ?? null,
          draft.noticeDays ?? 30, draft.lwd, draft.reason ?? null,
          draft.destination ?? null, draft.buyout ?? 0]);
      id = ins.rows[0].id as string;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ExitError('that person already has an exit in progress', 'duplicate');
      }
      if ((e as { code?: string }).code === '23514') {
        throw new ExitError('the last working day cannot be before the resignation', 'invalid');
      }
      throw e;
    }

    for (const dept of CLEARANCE_DEPARTMENTS) {
      await db.query(
        'INSERT INTO exit_clearance (exit_id, department) VALUES ($1,$2)', [id, dept]);
    }

    // Serving notice, not gone: the directory still shows them until the last
    // working day passes and the settlement closes.
    await db.query("UPDATE employee SET status = 'on_notice' WHERE id = $1", [draft.empId]);

    const { rows } = await db.query(`${PROJECTION} WHERE x.id = $1`, [id]);
    return toExit(rows[0]!);
  });
}

/**
 * The full-and-final settlement, computed live.
 *
 * Every component reads the tables it belongs to rather than a stored copy —
 * leave balances for encashment, active loans for recovery, approved claims
 * not yet reimbursed. That is what makes it correct up to the moment it is
 * paid, and why it is frozen at payment rather than before.
 */
async function computeSettlement(
  db: TenantClient,
  exit: ExitRecord,
): Promise<FnF> {
  const emp = await db.query(
    `SELECT e.ctc, e.joined_on, COALESCE(le.country, 'IN') AS country
       FROM employee e LEFT JOIN legal_entity le ON le.id = e.legal_entity_id
      WHERE e.id = $1`, [exit.empId]);
  if (!emp.rows[0]) throw new ExitError('no such employee', 'not_found');

  const country = (emp.rows[0].country as Country) ?? 'IN';
  const s = structureFor(Number(emp.rows[0].ctc ?? 0), country);
  const perDay = Math.round(s.grossA / 365);

  const lwd = new Date(exit.lwd);
  const daysInMonth = new Date(lwd.getUTCFullYear(), lwd.getUTCMonth() + 1, 0).getDate();
  const payDays = lwd.getUTCDate();
  const salary = Math.round(((s.grossA / 12) * payDays) / daysInMonth);

  const leave = await db.query(
    `SELECT COALESCE(sum(b.quota + b.carried_over - b.used), 0) AS avail
       FROM leave_balance b JOIN leave_type lt ON lt.id = b.leave_type_id
      WHERE b.employee_id = $1 AND lt.encashable`, [exit.empId]);
  const elDays = Math.max(0, Number(leave.rows[0].avail));
  const encash = Math.round(elDays * dailyRateFor(s));

  /* Gratuity vests only after five years of continuous service. */
  const joined = new Date(emp.rows[0].joined_on as string);
  const yrs = Math.floor((lwd.getTime() - joined.getTime()) / (365 * 24 * 3600 * 1000));
  const basicMonthly = (s.earnings[0]?.a ?? 0) / 12;
  const gratuity = yrs >= 5 ? Math.round((basicMonthly * 15 * yrs) / 26) : 0;

  const noticeShort = exit.buyout ? Math.round(perDay * exit.buyout) : 0;

  const loans = await db.query(
    "SELECT COALESCE(sum(outstanding), 0) AS due FROM loan WHERE employee_id = $1 AND status = 'active'",
    [exit.empId]);
  const loanDue = Number(loans.rows[0].due);

  const advances = await db.query(
    `SELECT COALESCE(sum(amount - settled_amount), 0) AS due
       FROM travel_advance WHERE employee_id = $1 AND status = 'approved'`, [exit.empId]);
  const advDue = Number(advances.rows[0].due);

  const claims = await db.query(
    `SELECT COALESCE(sum(total_amount), 0) AS due
       FROM expense_claim WHERE employee_id = $1 AND status = 'approved'`, [exit.empId]);
  const pending = Number(claims.rows[0].due);

  const gross = salary + encash + gratuity + pending;
  const pf = country === 'IN'
    ? Math.round(Math.min((basicMonthly * payDays) / daysInMonth, PF_WAGE_CAP) * 0.12)
    : 0;
  const ptax = country === 'IN' ? 208 : 0;
  const tds = country === 'IN' ? Math.round(taxNewRegime(s.grossA).total / 12) : 0;
  const ded = pf + ptax + tds + noticeShort + loanDue + advDue;

  return {
    perDay, payDays, daysInMonth, salary, elDays, encash, yrs, gratuity, pending,
    noticeShort, loanDue, advDue, pf, ptax, tds, gross, ded, net: gross - ded,
  };
}

export interface ExitDetail {
  exit: ExitRecord;
  settlement: FnF;
  leaveAvail: number;
  loansOutstanding: number;
}

export async function exitDetail(caller: Caller, exitId: string): Promise<ExitDetail | null> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${PROJECTION} WHERE x.id = $1`, [exitId]);
    if (!rows[0]) return null;
    const exit = toExit(rows[0]);
    if (!mayHandle(caller) && exit.empId !== caller.employeeId) return null;

    const settlement = await computeSettlement(db, exit);
    return {
      exit,
      settlement,
      leaveAvail: settlement.elDays,
      loansOutstanding: settlement.loanDue,
    };
  });
}

/** Tick or untick one clearance line. */
export async function setClearance(
  caller: Caller,
  exitId: string,
  department: string,
  done: boolean,
): Promise<ExitRecord> {
  if (!mayHandle(caller)) {
    throw new ExitError('only a manager or admin may sign off clearance', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const x = await db.query('SELECT status FROM exit_record WHERE id = $1 FOR UPDATE', [exitId]);
    if (!x.rows[0]) throw new ExitError('no such exit', 'not_found');
    if (x.rows[0].status === 'settled') {
      throw new ExitError('that exit is already settled', 'settled');
    }

    const upd = await db.query(
      `UPDATE exit_clearance
          SET status = $3, cleared_by = CASE WHEN $3 = 'cleared' THEN $4::uuid ELSE NULL END,
              cleared_on = CASE WHEN $3 = 'cleared' THEN CURRENT_DATE ELSE NULL END
        WHERE exit_id = $1 AND department = $2`,
      [exitId, department, done ? 'cleared' : 'pending', caller.employeeId]);
    if (upd.rowCount === 0) {
      throw new ExitError(`no ${department} clearance on this exit`, 'no_line');
    }

    // Once anything is signed off, the exit is in clearance rather than notice.
    await db.query(
      `UPDATE exit_record SET status = 'in_clearance'
        WHERE id = $1 AND status = 'notice_period'
          AND EXISTS (SELECT 1 FROM exit_clearance c
                       WHERE c.exit_id = $1 AND c.status = 'cleared')`, [exitId]);

    const { rows } = await db.query(`${PROJECTION} WHERE x.id = $1`, [exitId]);
    return toExit(rows[0]!);
  });
}

/**
 * Close the exit and pay the settlement.
 *
 * Refused while any clearance line is outstanding. That is the rule the schema
 * could not express, and the one that stops somebody being paid out while they
 * still hold a laptop. The settlement is frozen here: what was actually paid
 * does not change when a leave balance is corrected next month.
 */
export async function settleExit(caller: Caller, exitId: string): Promise<ExitRecord> {
  if (caller.role !== 'admin') {
    throw new ExitError('only an admin may settle an exit', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} WHERE x.id = $1 FOR UPDATE OF x`, [exitId]);
    if (!rows[0]) throw new ExitError('no such exit', 'not_found');
    const exit = toExit(rows[0]);
    if (exit.status === 'Settled') throw new ExitError('that exit is already settled', 'settled');

    const open = await db.query(
      "SELECT department FROM exit_clearance WHERE exit_id = $1 AND status <> 'cleared' ORDER BY department",
      [exitId]);
    if ((open.rowCount ?? 0) > 0) {
      const names = open.rows.map((r) => r.department as string).join(', ');
      throw new ExitError(`clearance is still outstanding: ${names}`, 'not_cleared');
    }

    const f = await computeSettlement(db, exit);

    await db.query(
      `INSERT INTO exit_settlement
         (exit_id, currency, salary_payable, leave_encashment, gratuity, bonus_payable,
          notice_recovery, loan_recovery, asset_recovery, tax_deducted, net_payable, paid_on)
       SELECT $1, t.base_currency, $2, $3, $4, $5, $6, $7, 0, $8, $9, CURRENT_DATE
         FROM tenant t WHERE t.id = current_tenant_id()
       ON CONFLICT (tenant_id, exit_id) DO UPDATE SET
         net_payable = EXCLUDED.net_payable, paid_on = EXCLUDED.paid_on`,
      [exitId, f.salary, f.encash, f.gratuity, f.pending,
        f.noticeShort, f.loanDue + f.advDue, f.pf + f.ptax + f.tds, f.net]);

    await db.query(
      "UPDATE exit_record SET status = 'settled', settled_on = CURRENT_DATE WHERE id = $1",
      [exitId]);

    // Now they have left. The directory stops showing them as active, and the
    // asset register starts showing anything they still hold for recovery.
    await db.query(
      "UPDATE employee SET status = 'exited', left_on = $2 WHERE id = $1",
      [exit.empId, exit.lwd]);

    await db.query(
      `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'people', 'exit_settled', 'notice', $1, COALESCE(e.full_name, 'system'),
              'exit_record', $2, jsonb_build_object('net', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, exitId, String(f.net)]);

    const back = await db.query(`${PROJECTION} WHERE x.id = $1`, [exitId]);
    return toExit(back.rows[0]!);
  });
}

/** Record the exit interview. */
export async function recordExitInterview(
  caller: Caller,
  exitId: string,
  answers: { wouldRejoin?: boolean; rating?: number; comments?: string },
): Promise<ExitRecord> {
  if (!mayHandle(caller)) {
    throw new ExitError('only a manager or admin may record an exit interview', 'forbidden');
  }
  if (answers.rating !== undefined
      && (!Number.isInteger(answers.rating) || answers.rating < 1 || answers.rating > 5)) {
    throw new ExitError('a rating is 1 to 5', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const x = await db.query('SELECT id FROM exit_record WHERE id = $1', [exitId]);
    if (!x.rows[0]) throw new ExitError('no such exit', 'not_found');

    await db.query(
      `INSERT INTO exit_interview
         (exit_id, held_on, conducted_by, overall_rating, would_recommend, feedback)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, exit_id) DO UPDATE SET
         held_on = EXCLUDED.held_on, conducted_by = EXCLUDED.conducted_by,
         overall_rating = EXCLUDED.overall_rating,
         would_recommend = EXCLUDED.would_recommend, feedback = EXCLUDED.feedback`,
      [exitId, caller.employeeId, answers.rating ?? null,
        answers.wouldRejoin ?? null, answers.comments ?? null]);

    const { rows } = await db.query(`${PROJECTION} WHERE x.id = $1`, [exitId]);
    return toExit(rows[0]!);
  });
}
