/*
 * Last in the RNG chain, after job titles.
 */
import './jobtitles';

import { sortBy } from '../lib/collections';
import { TODAY, ymd } from '../lib/dates';
import { EMAP } from './employees';

/**
 * What was done, by whom, to what.
 *
 * One trail for every module rather than one per module. The question an audit
 * answers is "who touched this", and a person's afternoon crosses six modules
 * — so six separate logs means six searches and no way to order them against
 * each other.
 *
 * Named AuditRecord rather than AuditEntry: the security module already owns
 * that name for the access-review trail it renders, and two exports of one
 * name from the data barrel is an ambiguity the compiler refuses.
 *
 * Mirrors `audit_log` in migration 0009, which has held this shape since
 * before anything wrote to it: an actor, an action, a loose subject reference,
 * and a line of prose. The subject is loose on purpose — a trail has to
 * survive the deletion of the thing it describes, so it is not a foreign key.
 */
export interface AuditRecord {
  id: string;
  /** The instant, not the date: an afternoon is read in order. */
  at: string;
  actorId: string | null;
  /** The actor's name as it was, so a later rename does not rewrite history. */
  actorLabel: string;
  /** `module.verb` — `job_title.created`, `software.assigned`. */
  action: string;
  subjectTable: string;
  subjectId: string;
  /** What the line says on screen. */
  summary: string;
}

const TRAIL: AuditRecord[] = [];
let seq = 0;

const now = () => `${ymd(TODAY)}T${new Date().toTimeString().slice(0, 8)}`;

/**
 * Appending is the only write.
 *
 * There is no update and no delete, matching the table, which revokes both
 * from the application role. A history that can be edited is not a history —
 * and this is what gets consulted when somebody disputes who changed a rate.
 */
export const recordAudit = {
  write(
    actor: { meId: string },
    action: string,
    subjectTable: string,
    subjectId: string,
    summary: string,
  ): AuditRecord {
    const entry: AuditRecord = {
      id: `AUD-${seq += 1}`,
      at: now(),
      actorId: actor.meId ?? null,
      actorLabel: EMAP[actor.meId]?.name ?? 'System',
      action,
      subjectTable,
      subjectId,
      summary,
    };
    TRAIL.unshift(entry);
    return entry;
  },

  /** Everything that has happened to one record, newest first. */
  forSubject(subjectTable: string, subjectId: string): AuditRecord[] {
    return TRAIL.filter((e) => e.subjectTable === subjectTable && e.subjectId === subjectId);
  },

  /** The whole trail, newest first, optionally narrowed. */
  all(f: { action?: string; actorId?: string; subjectTable?: string } = {}): AuditRecord[] {
    return sortBy(
      TRAIL.filter((e) =>
        (!f.action || e.action.startsWith(f.action))
        && (!f.actorId || e.actorId === f.actorId)
        && (!f.subjectTable || e.subjectTable === f.subjectTable)),
      (e) => e.at, 'desc',
    );
  },

  /** For the checks, which need a clean trail between cases. */
  reset(): void {
    TRAIL.length = 0;
    seq = 0;
  },
};
