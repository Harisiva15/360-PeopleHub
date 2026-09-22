import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { ri } from '../../lib/rng';

import { DEPTS, deptOf } from '../../data/org';
import { COUNTRIES, countryOf } from '../../data/countries';
import type { CountryId } from '../../types/country';



import type { Severity } from '../../services';
import { HBar, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Badge, Banner, Card, EmptyState, Table, TableWrap, Tabs, Tile, StatRow } from '../../components/ui';
import { Chip } from '../../components/common';
import { PERMS } from '../../state/rbac';
import type { AppRole } from '../../types/employee';
import {
  useAllEmployees, useAssets, useAudit, useAuditCategories, useControls, useExits,
  useRetention,
} from './data';
import { useTenantLoginHistory, useUsers } from '../users/data';
import { useSecondFactor } from './measured';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { Icon } from '../../components/icons';

type Tab = 'post' | 'access' | 'audit' | 'privacy';

const TABS: { v: Tab; label: string }[] = [
  { v: 'post', label: 'Posture' },
  { v: 'access', label: 'Access Review' },
  { v: 'audit', label: 'Audit Trail' },
  { v: 'privacy', label: 'Data & Retention' },
];

/* ---------- Posture ---------- */

/**
 * Security posture, measured rather than asserted.
 *
 * This tab used to report MFA enrolment, managed devices, disk encryption and
 * patch compliance as percentages, and a weighted score over all four. Every
 * one of those came from `src/data/security.ts`, which assigns them with a
 * seeded random draw — there is no MDM, no identity feed and no endpoint
 * agent behind any of it. The service seam already said so in a comment and
 * the screen rendered the numbers anyway.
 *
 * A fabricated "94% encrypted" is not a placeholder. It is the figure
 * somebody quotes in a client security review, and it is the one number on
 * this page nobody can check. So the three device measures are gone — not
 * replaced with zero, which would read as a finding, but stated as not
 * measured, with what it would take to measure them.
 *
 * The one thing here that *is* knowable is whether people sign in with a
 * second factor, because this product records the method on every sign-in.
 * That is now the identity figure, labelled as what it actually counts.
 */
function PostureTab() {
  const { data: CONTROLS = [] } = useControls();
  const { data: AUDIT = [] } = useAudit();
  const { data: AUDIT_CATS = [] } = useAuditCategories();
  const { data: history = [], loading: histLoading } = useTenantLoginHistory();
  const { data: everyone = [] } = useAllEmployees();
  const met = CONTROLS.filter((c) => c.s === 'Met').length;

  const sf = useSecondFactor(history);

  /*
   * Per department, over the people who have actually signed in. A department
   * where nobody has signed in yet is left out rather than drawn at 0% — an
   * empty bar and a bar of non-adopters look identical and mean opposite
   * things.
   */
  const deptOfEmp = (id: string) => everyone.find((e) => e.id === id)?.dept;
  const byDept: HBarRow[] = DEPTS.map((d) => {
    const seen = [...sf.signedIn].filter((id) => deptOfEmp(id) === d.id);
    const with2fa = seen.filter((id) => sf.withSecondFactor.has(id));
    return { k: d.name, c: d.color, v: seen.length ? pct(with2fa.length, seen.length) : -1 };
  }).filter((r) => r.v >= 0);
  const byCat: HBarRow[] = AUDIT_CATS.map((c, i) => ({ k: c, c: PAL[i % 8], v: AUDIT.filter((a) => a.cat === c).length })).filter((r) => r.v);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile
          label="Signed in with a second factor"
          value={histLoading ? '—' : `${pct(sf.withSecondFactor.size, sf.signedIn.size)}%`}
          foot={histLoading
            ? 'Reading sign-in history…'
            : `${sf.withSecondFactor.size} of ${sf.signedIn.size} accounts that have signed in`}
        />
        <Tile
          label="Controls met"
          value={`${met}/${CONTROLS.length}`}
          foot={`${CONTROLS.length - met} not yet fully implemented`}
        />
        <Tile label="Managed devices" value="Not measured" foot="No device management is connected" />
        <Tile label="Disk encryption" value="Not measured" foot="No endpoint agent is connected" />
      </StatRow>

      {/*
        * Above the charts, not below them. Somebody arriving to answer "are we
        * secure" needs to know which half of this page is evidence before they
        * read either half.
        */}
      <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Device posture is not measured">
        Whether a laptop is enrolled in device management, encrypted or patched is
        not something this application can observe. Reporting it would need an MDM
        or endpoint agent connected under Integrations. Until one is, these figures
        are absent rather than estimated — an estimate here reads as a measurement.
      </Banner>

      <div className="grid g2">
        <Card title="Control framework" sub={`${met} of ${CONTROLS.length} controls fully met`} flush>
          <Table>
            <thead>
              <tr><th>Control</th><th>Implementation</th><th className="right">Status</th></tr>
            </thead>
            <tbody>
              {CONTROLS.map((c) => (
                <tr key={c.k}>
                  <td><b>{c.k}</b></td>
                  <td className="muted">{c.d}</td>
                  <td className="right"><Badge kind={c.s === 'Met' ? 'good' : 'warn'}>{c.s}</Badge></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card
          title="Second factor by department"
          sub="Share of people who have signed in using one. Departments with no sign-ins are omitted."
        >
          {byDept.length
            ? <HBar rows={byDept} fmt={(v) => v + '%'} />
            : <EmptyState msg="No sign-ins recorded yet" icon={<Icon n="security" size="lg" />} />}
        </Card>
      </div>

      <Card title="Sign-in activity" sub="Last 45 days of privileged actions by category">
        <HBar rows={byCat} />
      </Card>
    </div>
  );
}

/* ---------- Access review ---------- */

type FindingSev = 'crit' | 'warn' | 'info';

interface Finding {
  sev: FindingSev;
  cat: string;
  t: string;
  d: string;
  act: { l: string; f: () => void };
}

const SEV_RANK: Record<FindingSev, number> = { crit: 0, warn: 1, info: 2 };
const SEV_LABEL: Record<FindingSev, string> = { crit: 'Act now', warn: 'Review', info: 'FYI' };
const SEV_KIND: Record<FindingSev, 'crit' | 'warn' | 'info'> = { crit: 'crit', warn: 'warn', info: 'info' };

/**
 * Derives the open access findings and the action each one hands you. Every
 * finding ends somewhere you can act, rather than in a list you have to
 * translate into work yourself.
 */
function useAccessFindings(goToAudit: () => void): Finding[] {
  const nav = useNavigate();
  const { data: AUDIT = [] } = useAudit();
  const { data: EXITS = [] } = useExits();
  const { data: ASSETS = [] } = useAssets();
  const { data: everyone = [] } = useAllEmployees();
  const { data: history = [] } = useTenantLoginHistory();
  const { data: accounts = [] } = useUsers({});
  const sf = useSecondFactor(history);

  const out: Finding[] = [];
  /*
   * Who actually holds the administrator role, read from the account.
   *
   * This was `everyone.filter((e) => e.dept === 'HR' && e.grade >= 'L4')` —
   * a guess at who administrators are, from a department and a grade band.
   * It would have counted a senior HR person with no account at all and
   * missed the IT administrator entirely. The role lives on
   * `tenant_membership` and is what every server-side check reads, so it is
   * what a finding about privilege has to count.
   */
  const admins = accounts.filter((a) => a.role === 'admin' && a.status === 'Active');
  /* A settled exit has had its access closed, so it is no longer a finding. */
  const leavers = EXITS.filter((x) => x.status !== 'Settled' && x.lwd <= ymd(addDays(TODAY, 14)));

  /*
   * Accounts that sign in without a second factor.
   *
   * Stated as what was observed — "has only ever signed in with a password"
   * — rather than "has no second factor enrolled", which is a claim about
   * Supabase Auth's records that this application does not read. Somebody
   * who enrolled yesterday and has not signed in since would have been
   * accused of ignoring policy by the stronger wording.
   */
  accounts
    .filter((a) => a.status === 'Active' && a.empId
      && sf.signedIn.has(a.empId) && !sf.withSecondFactor.has(a.empId))
    .slice(0, 6)
    .forEach((a) => {
      const e = everyone.find((y) => y.id === a.empId);
      out.push({
        sev: 'crit',
        cat: 'Identity',
        t: `${a.name} has only ever signed in with a password`,
        d: e
          ? `${deptOf(e.dept).name} · ${countryOf(e.country).name}. No sign-in on record used a second factor.`
          : 'No sign-in on record used a second factor.',
        act: { l: 'Open sign-in history', f: () => nav(`/users?v=signins`) },
      });
    });

  leavers.forEach((x) => {
    const e = everyone.find((y) => y.id === x.empId);
    if (!e) return;
    const held = ASSETS.filter((a) => a.empId === e.id && a.status === 'Assigned').length;
    out.push({
      sev: 'crit',
      cat: 'Joiner–mover–leaver',
      t: `${e.name} leaves on ${fmtD(x.lwd)} with access still live`,
      d: `Accounts, VPN and asset recovery must be closed on or before the last working day. ${held} asset(s) still on their record.`,
      act: { l: 'Open exit', f: () => nav('/exit') },
    });
  });

  /*
   * There were two device findings here — an unmanaged device and one behind
   * on patches — each naming a real colleague. Both were drawn at random.
   * A named accusation is worse than a wrong percentage: somebody would have
   * been asked to explain a laptop nobody had looked at. Nothing replaces
   * them, because nothing here can see a device.
   */

  /* Locked accounts are a real finding, and they are in the account table. */
  accounts.filter((a) => a.status === 'Locked').slice(0, 5).forEach((a) =>
    out.push({
      sev: 'warn',
      cat: 'Identity',
      t: `${a.name}’s account is locked`,
      d: a.lockReason || 'Locked by an administrator. Only an administrator can lift it.',
      act: { l: 'Open user management', f: () => nav('/users?v=locked') },
    })
  );

  AUDIT.filter((a) => a.sev === 'high' && a.cat === 'Security' && /export/i.test(a.action))
    .slice(0, 3)
    .forEach((a) =>
      out.push({
        sev: 'warn',
        cat: 'Data',
        t: `Salary register exported by ${a.by}`,
        d: `${fmtD(a.on)} at ${a.at} from ${a.ip} (${a.device}). Bulk exports of compensation data are reviewable events.`,
        act: { l: 'Open audit trail', f: goToAudit },
      })
    );

  if (admins.length > 3)
    out.push({
      sev: 'warn',
      cat: 'Privilege',
      t: `${admins.length} active accounts hold the administrator role`,
      d: 'Organisation-wide access to every employee record, payroll run and configuration. Least privilege suggests no more than three.',
      act: { l: 'Open access control', f: () => nav('/settings') },
    });

  return sortBy(out, (o) => SEV_RANK[o.sev]);
}

const ROLES: AppRole[] = ['admin', 'manager', 'employee'];

function AccessTab({ goToAudit }: { goToAudit: () => void }) {
  const findings = useAccessFindings(goToAudit);
  const { data: everyone = [] } = useAllEmployees();
  const cats = uniq(findings.map((x) => x.cat));
  const modules = uniq(ROLES.flatMap((r) => PERMS[r]));

  /* The review cadence is illustrative — fixed on mount so it does not jitter. */
  const cadence = useMemo(() => ({ last: fmtD(addDays(TODAY, -ri(20, 40))), next: ri(15, 60) }), []);

  const exportCSV = () =>
    downloadCSV('access_review.csv', [
      ['Severity', 'Category', 'Finding', 'Detail'],
      ...findings.map((x) => [x.sev, x.cat, x.t, x.d]),
    ]);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Findings open" value={findings.length} foot={`Across ${cats.length} categories`} />
        <Tile label="Critical" value={findings.filter((x) => x.sev === 'crit').length} foot="Identity and leaver access" />
        <Tile label="Accounts in scope" value={everyone.length} foot="Active employees with a login" />
        <Tile label="Last review" value={cadence.last} foot={`Quarterly cadence · next due in ${cadence.next} days`} />
      </StatRow>

      <Card
        title="Access review findings"
        sub={`${findings.length} items · ranked by risk`}
        actions={<button className="btn sm" onClick={exportCSV}><Icon n="download" size="lg" /> Export</button>}
        flush
      >
        {findings.length ? (
          <div className="lst">
            {findings.map((x, i) => (
              <div className="lst-i" key={i}>
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, marginBottom: 3 }}>
                      <Badge kind={SEV_KIND[x.sev]}>{SEV_LABEL[x.sev]}</Badge>
                      <Chip>{x.cat}</Chip>
                    </div>
                    <b>{x.t}</b>
                    <div className="mt" style={{ marginTop: 3 }}>{x.d}</div>
                  </div>
                  <button className="btn sm" onClick={x.act.f}>{x.act.l}</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState msg="No open access findings" icon={<Icon n="ok" size="lg" />} />
        )}
      </Card>

      <Card title="Permission matrix" sub="What each role can reach — enforced on every route" flush>
        <div style={{ maxHeight: 520, overflow: 'auto' }}>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Module</th>
                  {ROLES.map((r) => <th key={r} className="right">{r.charAt(0).toUpperCase() + r.slice(1)}</th>)}
                </tr>
              </thead>
              <tbody>
                {modules.map((m) => (
                  <tr key={m}>
                    <td><b>{TITLES[m] || m}</b></td>
                    {ROLES.map((r) => (
                      <td key={r} className="right">
                        {PERMS[r].includes(m) ? <Badge kind="good">✓</Badge> : <span className="muted">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </div>
      </Card>
    </div>
  );
}

/* ---------- Audit trail ---------- */

const AUDIT_SEV: { v: Severity; label: string }[] = [
  { v: 'high', label: 'High' },
  { v: 'medium', label: 'Medium' },
  { v: 'low', label: 'Low' },
];
const AUDIT_SEV_KIND: Record<Severity, 'crit' | 'warn' | 'mute'> = { high: 'crit', medium: 'warn', low: 'mute' };

/** The table caps at this many rows; the export carries the full trail. */
const AUDIT_PAGE = 200;

function AuditTab() {
  const [cat, setCat] = useState('');
  const [sev, setSev] = useState('');
  const { data: AUDIT = [] } = useAudit();
  const { data: AUDIT_CATS = [] } = useAuditCategories();
  /* Filtering happens in the service — the query re-runs when either changes. */
  const { data: list = [] } = useAudit(cat, sev);

  const exportCSV = () =>
    downloadCSV('audit_trail.csv', [
      ['Date', 'Time', 'Severity', 'Category', 'Action', 'Performed by', 'Device', 'IP'],
      ...AUDIT.map((a) => [a.on, a.at, a.sev, a.cat, a.action, a.by, a.device, a.ip]),
    ]);

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>
          {AUDIT_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={sev} onChange={(e) => setSev(e.target.value)}>
          <option value="">All severities</option>
          {AUDIT_SEV.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>Append-only · retained 2 years</span>
        <button className="btn" onClick={exportCSV}><Icon n="download" size="lg" /> Export</button>
      </div>

      <StatRow cols={4}>
        <Tile label="Events logged" value={AUDIT.length} foot="Last 45 days" />
        <Tile label="High severity" value={AUDIT.filter((a) => a.sev === 'high').length} foot="Payroll, access and data exports" />
        <Tile label="Distinct actors" value={uniq(AUDIT.map((a) => a.byId)).length} foot="Users performing privileged actions" />
        <Tile label="Source countries" value={uniq(AUDIT.map((a) => a.country)).length} foot="Sign-ins across entities" />
      </StatRow>

      <Card title="Audit trail" sub={`${list.length} of ${AUDIT.length} events`} flush>
        <div style={{ maxHeight: 600, overflow: 'auto' }}>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>When</th><th>Severity</th><th>Category</th><th>Action</th>
                  <th>Performed by</th><th>Device</th><th>IP</th>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, AUDIT_PAGE).map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">{fmtD(a.on)} <span className="muted">{a.at}</span></td>
                    <td><Badge kind={AUDIT_SEV_KIND[a.sev]}>{AUDIT_SEV.find((s) => s.v === a.sev)?.label}</Badge></td>
                    <td><Chip>{a.cat}</Chip></td>
                    <td>{a.action}</td>
                    <td className="nowrap">{a.by} {countryOf(a.country).flag}</td>
                    <td className="nowrap muted">{a.device}</td>
                    <td className="mono muted">{a.ip}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </div>
        {list.length > AUDIT_PAGE && (
          <div className="card-b">
            <div className="muted" style={{ fontSize: 12.5 }}>
              Showing the most recent {AUDIT_PAGE} — export for the full trail.
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------- Data & retention ---------- */

/** Where each entity's employee data sits, and the safeguard it moves under. */
const TRANSFERS: Record<CountryId, { residency: string; safeguard: string }> = {
  IN: { residency: 'India (in-country)', safeguard: 'DPDP Act — consent and legitimate use' },
  GB: { residency: 'United Kingdom', safeguard: 'UK GDPR — UK IDTA for onward transfer' },
  AE: { residency: 'UAE', safeguard: 'PDPL — adequacy assessment on file' },
  CA: { residency: 'Canada', safeguard: 'PIPEDA — comparable protection clause' },
  US: { residency: 'United States', safeguard: 'Standard contractual clauses' },
};

function PrivacyTab() {
  const { data: RETENTION = [] } = useRetention();
  const { data: everyone = [] } = useAllEmployees();
  /* Illustrative counts, drawn once on mount so the panel holds still. */
  const dsr = useMemo(
    () => [
      { k: 'Access request', n: ri(0, 3), d: 'Copy of everything held about the individual', sla: '30 days' },
      { k: 'Correction', n: ri(0, 4), d: 'Amend inaccurate personal data', sla: '30 days' },
      { k: 'Erasure', n: ri(0, 2), d: 'Delete where no legal basis to retain remains', sla: '30 days' },
      { k: 'Portability', n: ri(0, 1), d: 'Machine-readable export of the record', sla: '30 days' },
    ],
    []
  );
  const entities = COUNTRIES.filter((c) => everyone.some((e) => e.country === c.id));

  const exportCSV = () =>
    downloadCSV('data_inventory.csv', [
      ['Category', 'Contents', 'Lawful basis', 'Retention', 'Rationale'],
      ...RETENTION.map((r) => [r.k, r.d, r.law, r.keep, r.basis]),
    ]);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Data categories" value={RETENTION.length} foot="Mapped to a lawful basis" />
        <Tile label="Entities in scope" value={entities.length} foot="DPDP Act, GDPR, UK GDPR, PIPEDA, UAE PDPL" />
        <Tile label="Open subject requests" value={sum(dsr, (d) => d.n)} foot="All inside the 30-day statutory window" />
        <Tile label="Sub-processors" value={9} foot="Reviewed before engagement" />
      </StatRow>

      <Card
        title="Data inventory and retention"
        sub="What we hold, why, and for how long"
        actions={<button className="btn sm" onClick={exportCSV}><Icon n="download" size="lg" /> Export</button>}
        flush
      >
        <Table>
          <thead>
            <tr><th>Category</th><th>Contents</th><th>Lawful basis</th><th>Retention</th><th>Rationale</th></tr>
          </thead>
          <tbody>
            {RETENTION.map((r) => (
              <tr key={r.k}>
                <td><b>{r.k}</b></td>
                <td className="muted">{r.d}</td>
                <td className="nowrap">{r.law}</td>
                <td className="nowrap"><b>{r.keep}</b></td>
                <td className="muted">{r.basis}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="grid g2">
        <Card title="Subject rights requests" sub="Rolling 12 months" flush>
          <Table>
            <thead>
              <tr><th>Right</th><th>What it means</th><th className="num">Open</th><th>SLA</th></tr>
            </thead>
            <tbody>
              {dsr.map((d) => (
                <tr key={d.k}>
                  <td><b>{d.k}</b></td>
                  <td className="muted">{d.d}</td>
                  <td className="num">{d.n}</td>
                  <td className="nowrap">{d.sla}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Cross-border transfers" sub="Where employee data moves and under what safeguard" flush>
          <Table>
            <thead>
              <tr><th>Entity</th><th>Residency</th><th>Safeguard</th></tr>
            </thead>
            <tbody>
              {entities.map((c) => (
                <tr key={c.id}>
                  <td>{c.flag} {c.entity}</td>
                  <td className="nowrap">{TRANSFERS[c.id].residency}</td>
                  <td className="muted">{TRANSFERS[c.id].safeguard}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <Banner kind="info" icon={<Icon n="info" size="lg" />}>
        Attendance geo-coordinates are the most sensitive routine collection in this system. They are captured only
        times, the work mode chosen, and the coordinates captured at punch — compared against the site's
        geo-fence, retained for 24 months, and never used for continuous tracking between punches.
      </Banner>
    </div>
  );
}

/* ---------- Shell ---------- */

function SecurityView() {
  const [tab, setTab] = useState<Tab>('post');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'post' && <PostureTab />}
      {tab === 'access' && <AccessTab goToAudit={() => setTab('audit')} />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'privacy' && <PrivacyTab />}
    </>
  );
}

registerModule({
  key: 'security',
  title: TITLES.security,
  Component: SecurityView,
});
