/**
 * The job-title catalogue, in memory.
 *
 * Every method takes the caller and checks it, for the same reason user
 * administration does: the screens are written against this, so a refusal the
 * server would make and the mock does not is a bug that first appears in
 * production.
 *
 * **An employee sees one title — their own.** Not a filtered catalogue but a
 * single record, because a catalogue is a configuration surface and their own
 * designation is a fact about them. The distinction matters: filtering would
 * still tell them the codes, levels and families of everything they happen to
 * match, which is not what "view their own job title" means.
 */

import { sortBy } from '../../lib/collections';
import { TODAY, ymd } from '../../lib/dates';
import { ACTIVE, EMAP } from '../../data/employees';
import { JOB_TITLES, holdersOf, jobTitleOf, levelOf } from '../../data/jobtitles';
import type { JobTitle, JobTitleStatus } from '../../data/jobtitles';
import { REQS } from '../../data/ats';
import { recordAudit } from '../../data/audit';
import type {
  Caller, JobTitleDetail, JobTitleDraft, JobTitleFilter, JobTitleRow, JobTitleService,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));

/** Who may do what. Admin configures; a manager reads; an employee reads one. */
const mayWrite = (c: Caller) => c.role === 'admin';
const mayRead = (c: Caller) => c.role === 'admin' || c.role === 'manager';

/** The catalogue row a list renders: the title, and what it costs to know. */
function rowOf(t: JobTitle): JobTitleRow {
  const holders = holdersOf(t);
  return {
    title: t,
    employees: holders.length,
    /* Requisitions still open against this title. */
    openPositions: REQS.filter((r) => r.title === t.n && r.status === 'Open')
      .reduce((n, r) => n + Math.max(0, r.openings - r.filled), 0),
  };
}

function matches(t: JobTitle, f: JobTitleFilter): boolean {
  if (f.dept && t.dept !== f.dept) return false;
  if (f.family && t.family !== f.family) return false;
  if (f.level && t.level !== f.level) return false;
  if (f.empType && t.empType !== f.empType) return false;
  if (f.status && t.status !== f.status) return false;
  if (f.q?.trim()) {
    const hay = `${t.n} ${t.code} ${t.family} ${t.desc}`.toLowerCase();
    if (!hay.includes(f.q.trim().toLowerCase())) return false;
  }
  return true;
}

/** Everything the catalogue refuses, in the order it refuses it. */
function validate(d: Partial<JobTitleDraft>, existing?: JobTitle): string | null {
  const n = (d.n ?? existing?.n ?? '').trim();
  if (!n) return 'Give the job title a name';

  const code = (d.code ?? existing?.code ?? '').trim().toUpperCase();
  if (!code) return 'A job code is required';
  if (!/^[A-Z0-9-]{3,16}$/.test(code)) {
    return 'A job code is 3 to 16 characters: letters, digits and hyphens';
  }
  const clash = JOB_TITLES.find((t) => t.code === code && t.id !== existing?.id);
  if (clash) return `${code} is already used by ${clash.n}`;

  const dup = JOB_TITLES.find(
    (t) => t.n.toLowerCase() === n.toLowerCase() && t.id !== existing?.id);
  if (dup) return `A title called ${n} already exists (${dup.code})`;

  if (!(d.dept ?? existing?.dept)) return 'Choose a department';
  const level = d.level ?? existing?.level;
  if (!level) return 'Choose a level';
  if (!levelOf(level) || levelOf(level).id !== level) return 'No such level';

  return null;
}

export const jobTitleService: JobTitleService = {
  list(c, f = {}) {
    if (!mayRead(c)) return refuse('Your role cannot browse the job-title catalogue');
    return ok(sortBy(JOB_TITLES.filter((t) => matches(t, f)), (t) => t.n).map(rowOf));
  },

  get(c, id) {
    const t = jobTitleOf(id);
    if (!t) return ok(null);

    /*
     * An employee may read the one they hold, and nothing else. Their own
     * designation is a fact about them; the catalogue is configuration.
     */
    if (!mayRead(c)) {
      const mine = EMAP[c.meId]?.designation;
      if (t.n !== mine) return refuse('You can only view your own job title');
    }

    const holders = holdersOf(t);
    const detail: JobTitleDetail = {
      ...rowOf(t),
      /* A manager sees their line's holders; an admin sees everybody's. */
      holders: c.role === 'admin'
        ? holders
        : holders.filter((e) => e.managerId === c.meId || e.id === c.meId),
      history: recordAudit.forSubject('job_title', t.id),
    };
    return ok(detail);
  },

  /** The one title an employee is entitled to, without asking for an id. */
  mine(c) {
    const designation = EMAP[c.meId]?.designation;
    if (!designation) return ok(null);
    const t = JOB_TITLES.find((x) => x.n === designation);
    return ok(t ? rowOf(t) : null);
  },

  create(c, draft) {
    if (!mayWrite(c)) return refuse('Only an administrator can add a job title');
    const bad = validate(draft);
    if (bad) return refuse(bad);

    const t: JobTitle = {
      id: `JT-${Date.now().toString(36)}`,
      code: draft.code.trim().toUpperCase(),
      n: draft.n.trim(),
      dept: draft.dept,
      family: draft.family ?? 'Operations',
      level: draft.level,
      empType: draft.empType ?? 'Full Time',
      desc: draft.desc ?? '',
      responsibilities: draft.responsibilities ?? [],
      required: draft.required ?? [],
      preferred: draft.preferred ?? [],
      status: draft.status ?? 'Active',
      createdOn: ymd(TODAY),
      createdById: c.meId,
      modifiedOn: null,
      modifiedById: null,
    };
    JOB_TITLES.unshift(t);
    recordAudit.write(c, 'job_title.created', 'job_title', t.id, `${t.code} · ${t.n}`);
    return ok(t);
  },

  update(c, id, patch) {
    if (!mayWrite(c)) return refuse('Only an administrator can change a job title');
    const t = jobTitleOf(id);
    if (!t) return refuse('No such job title');
    const bad = validate(patch, t);
    if (bad) return refuse(bad);

    const before = { ...t };
    Object.assign(t, patch, {
      code: (patch.code ?? t.code).trim().toUpperCase(),
      n: (patch.n ?? t.n).trim(),
      modifiedOn: ymd(TODAY),
      modifiedById: c.meId,
    });

    /* Only say what actually changed — an audit line reading "updated" is noise. */
    const changed = (Object.keys(patch) as (keyof JobTitle)[])
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(t[k]));
    recordAudit.write(c, 'job_title.updated', 'job_title', t.id,
      changed.length ? `${t.code} · changed ${changed.join(', ')}` : `${t.code} · no change`);
    return ok(t);
  },

  setStatus(c, id, status: JobTitleStatus) {
    if (!mayWrite(c)) return refuse('Only an administrator can retire a job title');
    const t = jobTitleOf(id);
    if (!t) return refuse('No such job title');
    if (t.status === status) return ok(t);

    /*
     * A title somebody holds cannot be retired. Retiring it would leave their
     * designation pointing at a record the catalogue says is gone, which is
     * the state this module exists to make impossible.
     */
    const holders = holdersOf(t).length;
    if (status !== 'Active' && holders > 0) {
      return refuse(
        `${holders} ${holders === 1 ? 'person holds' : 'people hold'} this title — `
        + 'move them to another before retiring it');
    }

    t.status = status;
    t.modifiedOn = ymd(TODAY);
    t.modifiedById = c.meId;
    recordAudit.write(c, 'job_title.status', 'job_title', t.id, `${t.code} · ${status}`);
    return ok(t);
  },

  remove(c, id) {
    if (!mayWrite(c)) return refuse('Only an administrator can delete a job title');
    const t = jobTitleOf(id);
    if (!t) return refuse('No such job title');

    const holders = holdersOf(t).length;
    if (holders > 0) {
      return refuse(
        `${holders} ${holders === 1 ? 'person holds' : 'people hold'} this title — `
        + 'it cannot be deleted');
    }
    const open = rowOf(t).openPositions;
    if (open > 0) return refuse(`${open} open position(s) are hiring into this title`);

    const i = JOB_TITLES.findIndex((x) => x.id === id);
    JOB_TITLES.splice(i, 1);
    recordAudit.write(c, 'job_title.deleted', 'job_title', t.id, `${t.code} · ${t.n}`);
    return ok(t);
  },

  /** The families and levels a form offers, so the screen invents neither. */
  meta() {
    return ok({
      departments: ACTIVE().reduce<string[]>(
        (acc, e) => (acc.includes(e.dept) ? acc : [...acc, e.dept]), []),
    });
  },
};
