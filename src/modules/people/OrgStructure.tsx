/**
 * The organisation at a glance: leadership, then departments.
 *
 * A different question from the reporting tree next to it. The tree answers
 * "who does this person report to"; this answers "what is this company made
 * of" — how big each department is, who runs it, and what the people in it
 * actually do. Both are worth having and neither substitutes for the other.
 *
 * **The department cards are derived, not configured.** Sub-teams are the
 * designations the department's own people hold, counted from the roster. A
 * hand-maintained list of teams would be wrong within a month and nobody would
 * notice; a count of who is actually there cannot drift from the directory.
 *
 * **The rows add up.** Only the largest designations are listed by name, with
 * the remainder folded into one line, so the numbers shown sum to the total
 * underneath them. A top-five that silently omits thirty people is a card that
 * invites the reader to do arithmetic and get a wrong answer.
 */

import { useMemo } from 'react';
import type { Employee } from '../../types/employee';
import type { Requisition } from '../../services';
import { sortBy } from '../../lib/collections';
import { DEPTS, deptOf, siteOf } from '../../data/org';
import { Avatar, EmptyState } from '../../components/ui';

/** How many designations get their own line before the rest are folded up. */
const NAMED_ROWS = 4;

export interface SubTeam { name: string; n: number }

/**
 * The designation breakdown for one department, largest first, with a tail.
 *
 * Exported so the folding can be checked against constructed cases rather than
 * eyeballed on a chart.
 */
export function subTeams(people: Employee[], named = NAMED_ROWS): SubTeam[] {
  const counts = new Map<string, number>();
  people.forEach((e) => counts.set(e.designation, (counts.get(e.designation) ?? 0) + 1));

  const all = sortBy([...counts].map(([name, n]) => ({ name, n })), (r) => -r.n);
  if (all.length <= named) return all;

  const head = all.slice(0, named);
  const rest = all.slice(named).reduce((n, r) => n + r.n, 0);
  /* One line for everyone not named, so the column still sums to the total. */
  return rest > 0 ? [...head, { name: 'Other roles', n: rest }] : head;
}

function PersonLine({ e, role, onOpen }: { e: Employee; role?: string; onOpen: (id: string) => void }) {
  return (
    <button className="org-person" onClick={() => onOpen(e.id)} title={`Open ${e.name}`}>
      <Avatar name={e.name} size="sm" />
      <span className="org-t">
        <span className="org-n">{e.name}</span>
        <span className="org-d">{role ?? e.designation}</span>
        <span className="org-m">📍 {siteOf(e.site).city === '—' ? 'Remote' : siteOf(e.site).city}</span>
      </span>
    </button>
  );
}

export function OrgStructure({
  everyone, requisitions, onOpen, q, deptFilter,
}: {
  everyone: Employee[];
  requisitions: Requisition[];
  onOpen: (id: string) => void;
  q: string;
  deptFilter: string;
}) {
  const ceo = everyone.find((e) => !e.managerId);

  const byId = useMemo(() => {
    const m = new Map(everyone.map((e) => [e.id, e]));
    return (id: string | null | undefined) => (id ? m.get(id) : undefined);
  }, [everyone]);

  /* The leadership band is whoever reports to the chief executive. */
  const leaders = useMemo(() => sortBy(
    (ceo?.reports ?? []).map((id) => byId(id)).filter((x): x is Employee => !!x),
    (e) => e.name), [ceo, byId]);

  const needle = q.trim().toLowerCase();
  const hit = (e: Employee) =>
    !!needle && (e.name + ' ' + e.designation + ' ' + deptOf(e.dept).name)
      .toLowerCase().includes(needle);

  const depts = DEPTS
    .filter((d) => !deptFilter || d.id === deptFilter)
    .map((d) => {
      const people = everyone.filter((e) => e.dept === d.id);
      return { d, people, head: byId(d.head), teams: subTeams(people) };
    })
    .filter((row) => row.people.length > 0);

  const openings = requisitions
    .filter((r) => r.status === 'Open')
    .reduce((n, r) => n + Math.max(0, r.openings - r.filled), 0);

  if (!ceo) {
    return (
      <EmptyState icon="☰"
        msg="Nobody sits at the top of the chart — every employee has a manager, so there is no structure to draw from." />
    );
  }

  return (
    <div className="org-wrap">
      <div className="orgtree org-struct">
        <ul>
          <li>
            {/* The chief executive, alone at the top. */}
            <div className={'org-node' + (hit(ceo) ? ' hit' : '')}>
              <div className="org-card org-lead">
                <PersonLine e={ceo} onOpen={onOpen} />
              </div>
            </div>

            {leaders.length > 0 && (
              <ul className="org-leaders">
                {leaders.map((l, i) => (
                  <li key={l.id}>
                    <div className={'org-node' + (hit(l) ? ' hit' : '')}>
                      {/*
                        * Tinted by position rather than by anything the tone
                        * means — it groups the band visually, and the reader
                        * gets the person's actual department from the card.
                        */}
                      <div className={'org-card org-lead t-' + TONES[i % TONES.length]}>
                        <PersonLine e={l} onOpen={onOpen} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/*
              * Departments hang off the leadership band as a whole rather than
              * off one leader each. Several departments genuinely report into
              * the same person, and drawing a guessed one-to-one would state a
              * reporting line the data does not contain.
              */}
            {depts.length > 0 && (
              <ul className="org-depts">
                {depts.map(({ d, people, head, teams }) => (
                  <li key={d.id}>
                    <div className="org-dept" style={{ ['--dept' as string]: d.color }}>
                      <div className="org-dept-h">
                        <span className="org-dept-dot" />
                        {d.name}
                      </div>

                      {head
                        ? <PersonLine e={head} role="Head" onOpen={onOpen} />
                        : <div className="org-dept-nohead">No head named</div>}

                      <div className="org-dept-rows">
                        {teams.map((t) => (
                          <div key={t.name} className="org-dept-row">
                            <span>{t.name}</span>
                            <b>{t.n}</b>
                          </div>
                        ))}
                      </div>

                      <div className="org-dept-total">
                        <span>Total</span>
                        <b>{people.length}</b>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        </ul>
      </div>

      <div className="org-foot">
        <span>👥 One team</span>
        <span>{new Set(everyone.map((e) => e.site)).size} locations</span>
        <span>{openings ? `${openings} positions open` : 'Fully staffed'}</span>
      </div>
    </div>
  );
}

const TONES = ['blue', 'green', 'violet', 'amber', 'rose'] as const;
