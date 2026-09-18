/**
 * Document collection across every joiner at once.
 *
 * The per-journey panel answers "what is outstanding for this person"; this
 * answers "who is holding us up", which is the question actually asked in a
 * Monday morning intake meeting. Joiners are ranked by how much is missing and
 * how close their joining date is — a joiner with two documents outstanding who
 * starts next week matters more than one with five who starts in a month.
 */

import { useState } from 'react';
import type { DocRequest, Onboarding } from '../../services';
import { daysBetween, fmtD, TODAY, ymd } from '../../lib/dates';
import { Avatar, Badge, Card, EmptyState, Tile, StatRow } from '../../components/ui';
import { ListRow } from '../../components/common';
import { DocumentCollection } from '../documents/collection';
import { useDocRequests } from '../documents/data';
import { useJourneys } from './data';
import { Icon } from '../../components/icons';

/** Outstanding means it has not arrived — a rejected document has not arrived. */
export const outstanding = (r: DocRequest) => r.status === 'pending' || r.status === 'rejected';

export interface IntakeRow {
  j: Onboarding;
  docs: DocRequest[];
  missing: number;
  toCheck: number;
  /** Negative once the joining date has passed, which sorts it to the top. */
  daysToJoin: number;
}

/**
 * Rank joiners by how badly they are holding things up.
 *
 * Pure, and exported, so the ordering can be checked against constructed cases
 * rather than inferred from whatever the fixture happened to draw. Most
 * missing first; among equals, the soonest joining date, so a joiner who starts
 * on Monday outranks one who starts next month with the same gap.
 */
export function rankIntake(
  journeys: Onboarding[],
  requests: DocRequest[],
  today: string,
): IntakeRow[] {
  const byJourney = new Map<string, DocRequest[]>();
  requests.forEach((r) => {
    if (!r.journeyId) return;
    const list = byJourney.get(r.journeyId) ?? [];
    list.push(r);
    byJourney.set(r.journeyId, list);
  });

  return journeys
    .filter((j) => j.status !== 'Completed')
    .map((j) => {
      const docs = byJourney.get(j.id) ?? [];
      return {
        j,
        docs,
        missing: docs.filter((r) => r.mandatory && outstanding(r)).length,
        toCheck: docs.filter((r) => r.status === 'received').length,
        daysToJoin: daysBetween(today, j.doj),
      };
    })
    .sort((a, b) => (b.missing - a.missing) || (a.daysToJoin - b.daysToJoin));
}

export function CollectionView() {
  const { data: journeys = [] } = useJourneys();
  const { data: all = [] } = useDocRequests();
  const [sel, setSel] = useState<string | null>(null);

  const open = journeys.filter((j) => j.status !== 'Completed');
  const rows = rankIntake(journeys, all, ymd(TODAY));
  const chosen = rows.find((r) => r.j.id === sel) ?? rows[0];

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Joiners in intake" value={open.length} foot="Onboarding not yet complete" tone="blue" />
        <Tile label="Documents outstanding" value={all.filter(outstanding).length}
          foot="Requested, not received" tone="amber" />
        <Tile label="Awaiting verification" value={all.filter((r) => r.status === 'received').length}
          foot="Received but unchecked" tone="violet" />
        <Tile label="Joiners fully cleared" value={rows.filter((r) => r.docs.length && !r.missing).length}
          foot="No mandatory document missing" tone="green" />
      </StatRow>

      <div className="grid g-1-2">
        <Card title="Who is holding us up" sub={`${rows.length} joiners`} flush>
          <div style={{ maxHeight: 640, overflow: 'auto' }}>
            {rows.length ? rows.map(({ j, missing, toCheck, daysToJoin }) => (
              <ListRow key={j.id} onClick={() => setSel(j.id)}
                style={chosen && j.id === chosen.j.id ? { background: 'var(--brand-wash)' } : undefined}>
                <Avatar name={j.name} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 13 }}>{j.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {daysToJoin < 0 ? `Joined ${fmtD(j.doj)}`
                      : daysToJoin === 0 ? 'Joins today'
                        : `Joins in ${daysToJoin} day${daysToJoin === 1 ? '' : 's'}`}
                  </div>
                </div>
                {toCheck > 0 && <Badge kind="info">{toCheck} to check</Badge>}
                {missing > 0
                  ? <Badge kind={daysToJoin <= 7 ? 'crit' : 'warn'}>{missing} missing</Badge>
                  : <Badge kind="good">Cleared</Badge>}
              </ListRow>
            )) : <EmptyState msg="No joiners in intake" icon={<Icon n="document" size="lg" />} />}
          </div>
        </Card>

        {chosen
          ? <DocumentCollection scope={{ journeyId: chosen.j.id }} title={chosen.j.name + ' — documents'} />
          : <Card><EmptyState msg="Select a joiner" /></Card>}
      </div>
    </div>
  );
}
