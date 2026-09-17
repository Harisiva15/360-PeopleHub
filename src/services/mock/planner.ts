/**
 * The planner, in memory.
 *
 * Mirrors the server's ordering arithmetic rather than sorting an array,
 * because the board's behaviour under a drag is the thing worth demonstrating
 * and a mock that re-sorts hides exactly the case the real one has to get
 * right.
 */

import { TODAY, addDays, ymd } from '../../lib/dates';
import { DEMO_EMP, DEMO_MGR, EMAP } from '../../data/employees';
import { PROJECTS } from '../../data/org';
import type {
  BoardStats, Iteration, PlannerService, WorkItem, WorkItemQuery,
} from '../contracts';
import { ok } from './util';

const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];
const CLOSED = new Set(['done', 'cancelled']);

export const ITERATIONS: Iteration[] = [
  {
    id: 'IT1', name: 'Sprint 14', goal: 'Attendance and timesheet to beta',
    from: ymd(addDays(TODAY, -3)), to: ymd(addDays(TODAY, 11)), status: 'active',
  },
  {
    id: 'IT2', name: 'Sprint 15', goal: 'Payroll dry run',
    from: ymd(addDays(TODAY, 12)), to: ymd(addDays(TODAY, 26)), status: 'planned',
  },
];

let seq = 0;
const make = (p: Partial<WorkItem> & { title: string }): WorkItem => {
  seq += 1;
  return {
    id: 'WI' + seq,
    ref: 'PLAN-' + seq,
    projectId: null, project: null,
    iterationId: null, iteration: null,
    parentId: null,
    kind: 'task', desc: '', status: 'backlog', priority: 'medium',
    assigneeId: null, reporterId: DEMO_MGR.id, source: '',
    due: null, estimate: null, order: seq * 1024, closedOn: null, comments: [],
    ...p,
  };
};

const atlas = PROJECTS[0]!;
const nbfc = PROJECTS[1]!;

export const WORK_ITEMS: WorkItem[] = [
  make({ title: 'Design the punch-in screen', kind: 'story', status: 'in_progress',
    projectId: atlas.id, project: atlas.id, iterationId: 'IT1', iteration: 'Sprint 14',
    assigneeId: DEMO_EMP.id, priority: 'high', estimate: 8, due: ymd(addDays(TODAY, 4)) }),
  make({ title: 'Geo-fence accuracy on low-signal devices', kind: 'bug', status: 'in_progress',
    projectId: atlas.id, project: atlas.id, iterationId: 'IT1', iteration: 'Sprint 14',
    assigneeId: DEMO_MGR.id, priority: 'urgent', estimate: 5, due: ymd(addDays(TODAY, 1)) }),
  make({ title: 'Timesheet weekly rollup', kind: 'task', status: 'review',
    projectId: atlas.id, project: atlas.id, iterationId: 'IT1', iteration: 'Sprint 14',
    assigneeId: DEMO_EMP.id, estimate: 13 }),
  make({ title: 'Payroll statutory rates for FY27', kind: 'task', status: 'todo',
    projectId: nbfc.id, project: nbfc.id, iterationId: 'IT2', iteration: 'Sprint 15',
    priority: 'high', estimate: 8 }),
  make({ title: 'Leave encashment at exit', kind: 'story', status: 'backlog',
    projectId: nbfc.id, project: nbfc.id, estimate: 21 }),
  make({ title: 'Migrate the asset register', kind: 'task', status: 'done',
    projectId: atlas.id, project: atlas.id, iterationId: 'IT1', iteration: 'Sprint 14',
    assigneeId: DEMO_EMP.id, estimate: 3, closedOn: ymd(addDays(TODAY, -2)) }),

  /* Action items: no project, and a note of where each came from. */
  make({ title: 'Circulate the Q3 board pack', kind: 'action', status: 'todo',
    source: 'Management meeting, 12 Sep', assigneeId: DEMO_MGR.id,
    priority: 'urgent', due: ymd(addDays(TODAY, 2)) }),
  make({ title: 'Publish the revised leave policy', kind: 'action', status: 'in_progress',
    source: 'HR review', assigneeId: DEMO_EMP.id, due: ymd(addDays(TODAY, 6)) }),
  make({ title: 'Close the ISO evidence gaps', kind: 'action', status: 'blocked',
    source: 'Internal audit, 2 Sep', assigneeId: DEMO_MGR.id,
    priority: 'high', due: ymd(addDays(TODAY, -1)) }),
];

const find = (id: string) => WORK_ITEMS.find((w) => w.id === id);
const missing = (id: string) => Promise.reject(new Error('No such work item: ' + id));
const byOrder = (a: WorkItem, b: WorkItem) => a.order - b.order;

export const plannerService: PlannerService = {
  items(q: WorkItemQuery) {
    let out = WORK_ITEMS.slice().sort(byOrder);
    if (q.projectId) out = out.filter((w) => w.projectId === q.projectId);
    if (q.iterationId) out = out.filter((w) => w.iterationId === q.iterationId);
    if (q.assigneeId) out = out.filter((w) => w.assigneeId === q.assigneeId);
    if (q.kind) out = out.filter((w) => w.kind === q.kind);
    if (q.openOnly) out = out.filter((w) => !CLOSED.has(w.status));
    return ok(out);
  },

  mine(empId) {
    const who = empId ?? DEMO_EMP.id;
    const rank = ['urgent', 'high', 'medium', 'low'];
    const out = WORK_ITEMS
      .filter((w) => w.assigneeId === who && !CLOSED.has(w.status))
      .sort((a, b) => {
        if (a.due !== b.due) {
          if (!a.due) return 1;
          if (!b.due) return -1;
          return a.due < b.due ? -1 : 1;
        }
        return rank.indexOf(a.priority) - rank.indexOf(b.priority);
      });
    return ok(out);
  },

  board(projectId) {
    const rows: BoardStats[] = STATUSES.map((status) => {
      const col = WORK_ITEMS.filter(
        (w) => w.status === status && (!projectId || w.projectId === projectId),
      );
      return { status, count: col.length, estimate: col.reduce((a, w) => a + (w.estimate ?? 0), 0) };
    });
    return ok(rows);
  },

  iterations() { return ok(ITERATIONS.slice()); },

  createItem(draft) {
    if (!draft.title.trim()) return Promise.reject(new Error('A work item needs a title'));
    if (draft.status && CLOSED.has(draft.status)) {
      return Promise.reject(new Error('A new item cannot start closed'));
    }
    const status = draft.status ?? 'backlog';
    const tail = Math.max(0, ...WORK_ITEMS.filter((w) => w.status === status).map((w) => w.order));
    const proj = draft.projectId ? PROJECTS.find((p) => p.id === draft.projectId) : null;
    const it = draft.iterationId ? ITERATIONS.find((i) => i.id === draft.iterationId) : null;
    const row = make({
      title: draft.title.trim(),
      kind: draft.kind ?? 'task',
      status,
      projectId: proj?.id ?? null, project: proj?.id ?? null,
      iterationId: it?.id ?? null, iteration: it?.name ?? null,
      desc: draft.desc ?? '',
      priority: draft.priority ?? 'medium',
      assigneeId: draft.assigneeId ?? null,
      source: draft.source ?? '',
      due: draft.due ?? null,
      estimate: draft.estimate ?? null,
      order: tail + 1024,
    });
    WORK_ITEMS.push(row);
    return ok(row);
  },

  createIteration(draft) {
    if (!draft.name.trim()) return Promise.reject(new Error('An iteration needs a name'));
    if (draft.to < draft.from) return Promise.reject(new Error('It cannot end before it starts'));
    if (ITERATIONS.some((i) => i.name === draft.name.trim())) {
      return Promise.reject(new Error('An iteration with that name already exists'));
    }
    ITERATIONS.unshift({
      id: 'IT' + (ITERATIONS.length + 1), name: draft.name.trim(),
      goal: draft.goal ?? '', from: draft.from, to: draft.to, status: 'planned',
    });
    return ok(ITERATIONS.slice());
  },

  /** The same midpoint arithmetic the server uses, for the same reason. */
  moveItem(id, status, afterId) {
    const w = find(id);
    if (!w) return missing(id);
    if (!STATUSES.includes(status)) return Promise.reject(new Error('Unknown status: ' + status));

    const column = WORK_ITEMS.filter((x) => x.status === status && x.id !== id).sort(byOrder);
    if (afterId) {
      const anchor = column.find((x) => x.id === afterId);
      if (!anchor) {
        return Promise.reject(new Error('The item it should follow is not in that column'));
      }
      const next = column.find((x) => x.order > anchor.order);
      w.order = next ? (anchor.order + next.order) / 2 : anchor.order + 1024;
    } else {
      w.order = column.length ? column[0]!.order / 2 : 1024;
    }

    w.status = status;
    w.closedOn = CLOSED.has(status) ? (w.closedOn ?? ymd(TODAY)) : null;
    return ok(w);
  },

  updateItem(id, patch) {
    const w = find(id);
    if (!w) return missing(id);
    if (patch.title !== undefined) {
      if (!patch.title.trim()) return Promise.reject(new Error('A work item needs a title'));
      w.title = patch.title.trim();
    }
    if (patch.desc !== undefined) w.desc = patch.desc;
    if (patch.priority !== undefined) w.priority = patch.priority;
    if (patch.assigneeId !== undefined) w.assigneeId = patch.assigneeId;
    if (patch.due !== undefined) w.due = patch.due;
    if (patch.estimate !== undefined) w.estimate = patch.estimate;
    if (patch.source !== undefined) w.source = patch.source;
    if (patch.iterationId !== undefined) {
      const it = ITERATIONS.find((i) => i.id === patch.iterationId);
      w.iterationId = it?.id ?? null;
      w.iteration = it?.name ?? null;
    }
    if (patch.projectId !== undefined) {
      const p = PROJECTS.find((x) => x.id === patch.projectId);
      w.projectId = p?.id ?? null;
      w.project = p?.id ?? null;
    }
    return ok(w);
  },

  comment(id, text) {
    const w = find(id);
    if (!w) return missing(id);
    if (!text.trim()) return Promise.reject(new Error('A comment needs some text'));
    w.comments.push({
      by: EMAP[DEMO_EMP.id]?.name ?? 'You', on: ymd(TODAY), text: text.trim(),
    });
    return ok(w);
  },
};
