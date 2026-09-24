/**
 * The employment journey, in memory.
 *
 * **Nothing here sets a stage.** The stage is derived from the records that
 * already exist — an onboarding row, an exit row, the employee's own status —
 * so the write operations are on those records, not on a stage field. What
 * this service offers instead is the one thing the derivation cannot do:
 * tasks, which are work somebody has to remember rather than a fact about a
 * record.
 *
 * That is a real constraint and worth stating plainly: "change stage" is not
 * an operation. Moving somebody from Onboarding to Active means completing
 * their onboarding, and the module says so rather than offering a dropdown
 * that would put the summary and the records it summarises into disagreement.
 */

import { sortBy } from '../../lib/collections';
import { TODAY, ymd } from '../../lib/dates';
import { uid } from '../../lib/rng';
import { GRADES } from '../../data/org';
import { EMAP } from '../../data/employees';
import { LIFECYCLE } from '../../data/lifecycle';
import {
  LIFECYCLE_TASKS, lifecyclePopulation, stageOf, subjectOf, tasksFor,
} from '../../data/lifecycleStages';
import type { LifecycleStage, LifecycleTask } from '../../data/lifecycleStages';
import { recordAudit } from '../../data/audit';
import { visibleIds } from '../../state/rbac';
import type {
  Caller, LifecycleDetail, LifecycleFilter, LifecycleRow, LifecycleService, LifecycleStats,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));

/**
 * Who this caller may see.
 *
 * An admin sees everybody. A manager sees their line. An employee sees
 * themselves — and the journey is about them, so that is a real view rather
 * than an empty one.
 */
function inScope(c: Caller): LifecycleRow[] {
  const all = lifecyclePopulation().map((s) => ({
    subject: s,
    standing: stageOf(s.id),
    openTasks: tasksFor(s.id).filter((t) => !t.done).length,
  }));

  if (c.role === 'admin') return all;
  if (c.role === 'manager') {
    const mine = new Set(visibleIds('manager', c.meId));
    /*
     * A manager's line, plus the joiners and candidates reporting into them —
     * those have no employee row, so the id set cannot find them.
     */
    return all.filter((r) => mine.has(r.subject.id) || r.subject.managerId === c.meId);
  }
  return all.filter((r) => r.subject.id === c.meId);
}

function matches(r: LifecycleRow, f: LifecycleFilter): boolean {
  if (f.stage && r.standing.stage !== f.stage) return false;
  if (f.dept && r.subject.dept !== f.dept) return false;
  if (f.managerId && r.subject.managerId !== f.managerId) return false;
  if (f.site && r.subject.site !== f.site) return false;
  if (f.from && r.standing.since < f.from) return false;
  if (f.to && r.standing.since > f.to) return false;
  if (f.q?.trim()) {
    const hay = `${r.subject.name} ${r.subject.code} ${r.subject.designation}`.toLowerCase();
    if (!hay.includes(f.q.trim().toLowerCase())) return false;
  }
  return true;
}

export const lifecycleService: LifecycleService = {
  list(c, f = {}) {
    return ok(sortBy(inScope(c).filter((r) => matches(r, f)), (r) => -r.standing.daysInStage));
  },

  stats(c) {
    const rows = inScope(c);
    const at = (s: LifecycleStage) => rows.filter((r) => r.standing.stage === s).length;
    const out: LifecycleStats = {
      newJoiners: at('Joined'),
      preboarding: at('Pre-boarding'),
      onboarding: at('Onboarding'),
      probation: at('Joined'),
      promotions: at('Promotion'),
      transfers: at('Transfer'),
      onLeave: at('Leave of Absence'),
      exits: at('Exit'),
      offboarding: at('Offboarding'),
    };
    return ok(out);
  },

  get(c, id) {
    const row = inScope(c).find((r) => r.subject.id === id);
    if (!row) {
      /* Distinguish "not yours" from "not there" — they need different answers. */
      return subjectOf(id)
        ? refuse('That person is outside the people you can see')
        : ok(null);
    }
    const detail: LifecycleDetail = {
      ...row,
      /* The history is the employment record's, which candidates do not have. */
      events: sortBy(LIFECYCLE[id] ?? [], (e) => e.on, 'desc'),
      tasks: tasksFor(id),
    };
    return ok(detail);
  },

  addTask(c, empId, draft) {
    if (c.role === 'employee') return refuse('Your role cannot assign lifecycle tasks');
    const row = inScope(c).find((r) => r.subject.id === empId);
    if (!row) return refuse('That person is outside the people you can see');
    if (!draft.n?.trim()) return refuse('Say what the task is');
    if (!draft.due) return refuse('Give the task a due date');
    if (draft.assigneeId && !EMAP[draft.assigneeId]) return refuse('No such assignee');

    const task: LifecycleTask = {
      id: uid('LTK'),
      empId,
      stage: row.standing.stage,
      n: draft.n.trim(),
      owner: draft.owner ?? 'HR',
      assigneeId: draft.assigneeId ?? null,
      due: draft.due,
      done: false,
      doneOn: null,
      note: draft.note ?? '',
    };
    LIFECYCLE_TASKS.push(task);
    recordAudit.write(c, 'lifecycle.task_added', 'employee', empId,
      `${row.subject.name} · ${task.n}`);
    return ok(task);
  },

  setTaskDone(c, taskId, done) {
    if (c.role === 'employee') {
      /* Somebody may complete a task assigned to them, and nothing else. */
      const own = LIFECYCLE_TASKS.find((t) => t.id === taskId);
      if (!own || own.assigneeId !== c.meId) {
        return refuse('You can only complete a task assigned to you');
      }
    }
    const t = LIFECYCLE_TASKS.find((x) => x.id === taskId);
    if (!t) return refuse('No such task');
    if (c.role !== 'employee' && !inScope(c).some((r) => r.subject.id === t.empId)) {
      return refuse('That person is outside the people you can see');
    }
    if (t.done === done) return ok(t);

    t.done = done;
    t.doneOn = done ? ymd(TODAY) : null;
    recordAudit.write(c, done ? 'lifecycle.task_done' : 'lifecycle.task_reopened',
      'employee', t.empId, `${subjectOf(t.empId)?.name ?? t.empId} · ${t.n}`);
    return ok(t);
  },

  removeTask(c, taskId) {
    if (c.role !== 'admin') return refuse('Only an administrator can remove a lifecycle task');
    const i = LIFECYCLE_TASKS.findIndex((t) => t.id === taskId);
    if (i < 0) return refuse('No such task');
    const [t] = LIFECYCLE_TASKS.splice(i, 1);
    recordAudit.write(c, 'lifecycle.task_removed', 'employee', t.empId,
      `${subjectOf(t.empId)?.name ?? t.empId} · ${t.n}`);
    return ok(t);
  },

  /*
   * The two explicit lifecycle decisions.
   *
   * The demo keeps the same refusals the server makes, so a reviewer clicking
   * through the demo meets the same rules rather than a friendlier version of
   * them. The dataset has no employment_record, so these move the subject and
   * report what would have been written.
   */
  confirmProbation(c, empId, opts = {}) {
    if (c.role === 'employee') return refuse('Your role cannot confirm probation');
    const row = inScope(c).find((r) => r.subject.id === empId);
    if (!row) return refuse('No such person');
    if (row.subject.onProbation === false && row.standing.stage !== 'Joined') {
      return refuse('Probation was already confirmed');
    }
    const on = opts.on ?? ymd(TODAY);
    if (on > ymd(TODAY)) return refuse('Probation cannot be confirmed in advance');
    if (on < row.subject.startOn) {
      return refuse(`Probation cannot be confirmed before the joining date (${row.subject.startOn})`);
    }
    row.subject.onProbation = false;
    row.standing.stage = 'Active';
    row.standing.since = on;
    recordAudit.write(c, 'lifecycle.probation_confirmed', 'employee', empId,
      row.subject.name);
    return this.get(c, empId) as Promise<LifecycleDetail>;
  },

  promote(c, empId, draft) {
    if (c.role === 'employee') return refuse('Your role cannot promote somebody');
    const wantsGrade = Boolean(draft.gradeCode?.trim());
    const wantsTitle = Boolean(draft.designation?.trim());
    if (!wantsGrade && !wantsTitle) {
      return refuse('A promotion changes a grade, a title, or both');
    }
    const row = inScope(c).find((r) => r.subject.id === empId);
    if (!row) return refuse('No such person');

    if (wantsGrade) {
      const code = draft.gradeCode!.trim();
      const order = Object.keys(GRADES);
      const next = order.indexOf(code);
      if (next < 0) return refuse(`No such grade: ${code}`);
      const now = row.subject.grade ? order.indexOf(row.subject.grade) : -1;
      if (now >= 0 && next < now) {
        return refuse(
          `${code} is below their current grade. A move down is not a promotion — `
          + 'record it as a change of role instead.');
      }
      if (now >= 0 && next === now && !wantsTitle) {
        return refuse('They are already on that grade');
      }
      row.subject.grade = code;
    }
    if (wantsTitle) row.subject.designation = draft.designation!.trim();

    row.standing.stage = 'Promotion';
    row.standing.since = draft.on ?? ymd(TODAY);
    recordAudit.write(c, 'lifecycle.promoted', 'employee', empId, row.subject.name);
    return this.get(c, empId) as Promise<LifecycleDetail>;
  },
};
