/**
 * One person on the bench: how long, what it has cost, and what to do about it.
 *
 * **The figures come from the server even though the table computes its own.**
 * The table needs a number for every row and gets it from `benchSince` and
 * `costPerDay`, which are on the row already — fetching per row would be one
 * request per person. Here, where a single consultant is in focus and somebody
 * is about to act on it, the authoritative answer is worth a call: it uses the
 * database's clock rather than the browser's, and applies the working-day rule
 * rather than calendar days.
 *
 * If the two ever disagree, the server is right and the table is a preview.
 */

import type { Consultant } from '../../services';
import { countryOf, money } from '../../data/countries';
import { Avatar, Badge, Card, EmptyState, KV } from '../../components/ui';
import { Chip } from '../../components/common';
import { useBenchStanding, useMatchesForConsultant } from './data';
import { Icon } from '../../components/icons';

export function BenchDetail({ c }: { c: Consultant }) {
  const { data: standing } = useBenchStanding(c.id);
  const { data: matches = [] } = useMatchesForConsultant(c.id);

  return (
    <div className="stack">
      <Card>
        <div className="row" style={{ gap: 14, alignItems: 'center' }}>
          <Avatar name={c.name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{c.name}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {c.role} · {countryOf(c.country).short} · {c.workAuth}
            </div>
          </div>
        </div>

        <KV rows={[
          ['On the bench since', c.benchSince || '—'],
          ['Days', standing ? `${standing.days} days` : '—'],
          /* Working days, not calendar — nobody pays bench on a Sunday. */
          ['Cost so far', standing ? money(standing.cost, c.ccy) : '—'],
          ['Day rate', money(c.costPerDay, c.ccy)],
          ['Supplied by', c.external ? 'Vendor' : 'Own payroll'],
          ['Skills', <span>{c.skills.map((s) => <Chip key={s}>{s}</Chip>)}</span>],
        ]} />
      </Card>

      <Card title="What they could be put forward for"
        sub={matches.length ? `${matches.length} open requirement(s)` : undefined} flush>
        {matches.length ? matches.map((m) => (
          <div key={m.requirement.id}
            style={{ padding: '11px 14px', borderTop: '1px solid var(--line)' }}>
            <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Badge kind={m.explain.total >= 75 ? 'good' : 'warn'}>{m.explain.total}</Badge>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{m.requirement.title}</span>
              <span className="muted" style={{ fontSize: 12.5 }}>{m.explain.margin}% margin</span>
              {!m.explain.eligible && <Badge kind="crit">Work authorisation</Badge>}
            </div>
            {/*
              * Each component with the score it earned and the score it could
              * have — "Skills 45/60" rather than a single number somebody has
              * to trust. A match nobody can account for is one a recruiter
              * learns to skip.
              */}
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {m.explain.parts.map((x) => `${x.k} ${x.v}/${x.max}`).join(' · ')}
            </div>
          </div>
        )) : (
          <EmptyState icon={<Icon n="search" size="lg" />}
            msg="Nothing open matches them right now — retrain, redeploy internally, or release" />
        )}
      </Card>
    </div>
  );
}
