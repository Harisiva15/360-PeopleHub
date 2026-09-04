import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { ri } from '../../lib/rng';
import { ACTIVE, EMAP } from '../../data/employees';
import { DEPTS, deptOf } from '../../data/org';
import { COUNTRIES, countryOf } from '../../data/countries';
import type { CountryId } from '../../types/country';
import { ASSETS } from '../../data/announcements';
import { EXITS } from '../../data/exit';
import { AUDIT, AUDIT_CATS, CONTROLS, POSTURE, RETENTION } from '../../data/security';
import type { Severity } from '../../data/security';
import { HBar, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Badge, Banner, Card, EmptyState, Table, TableWrap, Tabs, Tile } from '../../components/ui';
import { Chip } from '../../components/common';
import { PERMS } from '../../state/rbac';
import type { AppRole } from '../../types/employee';
import { useShowEmployee } from '../employees/Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

type Tab = 'post' | 'access' | 'audit' | 'privacy';

const TABS: { v: Tab; label: string }[] = [
  { v: 'post', label: 'Posture' },
  { v: 'access', label: 'Access Review' },
  { v: 'audit', label: 'Audit Trail' },
  { v: 'privacy', label: 'Data & Retention' },
];

/* ---------- Posture ---------- */

function PostureTab() {
  const n = POSTURE.length;
  const mfa = POSTURE.filter((p) => p.mfa).length;
  const mgd = POSTURE.filter((p) => p.managed).length;
  const enc = POSTURE.filter((p) => p.encrypted).length;
  const pat = POSTURE.filter((p) => p.patched).length;
  const met = CONTROLS.filter((c) => c.s === 'Met').length;

  /* Identity is weighted heaviest, then device hygiene, then the control set. */
  const score = Math.round((mfa / n) * 25 + (mgd / n) * 20 + (enc / n) * 20 + (pat / n) * 15 + (met / CONTROLS.length) * 20);
  const band = score >= 85 ? 'Strong' : score >= 70 ? 'Adequate' : 'Needs work';

  const byDept: HBarRow[] = DEPTS.map((d) => {
    const g = POSTURE.filter((p) => p.e.dept === d.id);
    return { k: d.name, c: d.color, v: g.length ? Math.round((g.filter((p) => p.mfa).length / g.length) * 100) : 0 };
  });
  const byCat: HBarRow[] = AUDIT_CATS.map((c, i) => ({ k: c, c: PAL[i % 8], v: AUDIT.filter((a) => a.cat === c).length })).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="Security score" value={`${score}/100`} foot={`${band} · weighted across identity, device and controls`} />
        <Tile label="MFA enrolled" value={pct(mfa, n) + '%'} foot={`${n - mfa} accounts without a second factor`} />
        <Tile label="Managed devices" value={pct(mgd, n) + '%'} foot={`${n - mgd} outside device management`} />
        <Tile label="Disk encrypted" value={pct(enc, n) + '%'} foot={`${n - enc} unencrypted endpoints`} />
        <Tile label="Patch compliance" value={pct(pat, n) + '%'} foot={`${n - pat} behind the baseline`} />
      </div>

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

        <Card title="Posture by department" sub="MFA coverage — the weakest link decides the risk">
          <HBar rows={byDept} fmt={(v) => v + '%'} />
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
  const showEmp = useShowEmployee();
  const nav = useNavigate();

  const out: Finding[] = [];
  const admins = ACTIVE().filter((e) => e.dept === 'HR' && e.grade >= 'L4');
  /**
   * NOTE: the prototype filters on `status !== 'Completed'`, but an exit is only
   * ever 'Notice Period', 'In Clearance' or 'Settled', so the filter excludes
   * nothing and settled leavers raise a finding too. Kept as-is so the list
   * matches the prototype; 'Settled' was most likely intended. The same filter
   * appears in `data/assets.ts`.
   */
  const leavers = EXITS.filter((x) => (x.status as string) !== 'Completed' && x.lwd <= ymd(addDays(TODAY, 14)));

  POSTURE.filter((p) => !p.mfa).slice(0, 6).forEach((p) =>
    out.push({
      sev: 'crit',
      cat: 'Identity',
      t: `${p.e.name} has no second factor enrolled`,
      d: `${deptOf(p.e.dept).name} · ${countryOf(p.e.country).name}. Policy requires MFA for every account with access to personal data.`,
      act: { l: 'Open profile', f: () => showEmp(p.e.id) },
    })
  );

  leavers.forEach((x) => {
    const e = EMAP[x.empId];
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

  POSTURE.filter((p) => !p.managed).slice(0, 4).forEach((p) =>
    out.push({
      sev: 'warn',
      cat: 'Device',
      t: `${p.e.name} is signing in from an unmanaged device`,
      d: `Not enrolled in mobile device management. Last seen ${fmtD(p.lastSeen)}.`,
      act: { l: 'Open profile', f: () => showEmp(p.e.id) },
    })
  );

  POSTURE.filter((p) => !p.patched).slice(0, 4).forEach((p) =>
    out.push({
      sev: 'warn',
      cat: 'Device',
      t: `${p.e.name}’s device is behind on patches`,
      d: 'Operating system is more than two releases behind the baseline.',
      act: { l: 'Raise a ticket', f: () => nav('/helpdesk') },
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
      t: `${admins.length} accounts hold full administrator rights`,
      d: 'Organisation-wide access to every employee record, payroll run and configuration. Least privilege suggests no more than three.',
      act: { l: 'Open access control', f: () => nav('/settings') },
    });

  return sortBy(out, (o) => SEV_RANK[o.sev]);
}

const ROLES: AppRole[] = ['admin', 'manager', 'employee'];

function AccessTab({ goToAudit }: { goToAudit: () => void }) {
  const findings = useAccessFindings(goToAudit);
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
      <div className="grid g4">
        <Tile label="Findings open" value={findings.length} foot={`Across ${cats.length} categories`} />
        <Tile label="Critical" value={findings.filter((x) => x.sev === 'crit').length} foot="Identity and leaver access" />
        <Tile label="Accounts in scope" value={ACTIVE().length} foot="Active employees with a login" />
        <Tile label="Last review" value={cadence.last} foot={`Quarterly cadence · next due in ${cadence.next} days`} />
      </div>

      <Card
        title="Access review findings"
        sub={`${findings.length} items · ranked by risk`}
        actions={<button className="btn sm" onClick={exportCSV}>⤓ Export</button>}
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
          <EmptyState msg="No open access findings" icon="✓" />
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

  let list = AUDIT;
  if (cat) list = list.filter((a) => a.cat === cat);
  if (sev) list = list.filter((a) => a.sev === sev);

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
        <button className="btn" onClick={exportCSV}>⤓ Export</button>
      </div>

      <div className="grid g4">
        <Tile label="Events logged" value={AUDIT.length} foot="Last 45 days" />
        <Tile label="High severity" value={AUDIT.filter((a) => a.sev === 'high').length} foot="Payroll, access and data exports" />
        <Tile label="Distinct actors" value={uniq(AUDIT.map((a) => a.byId)).length} foot="Users performing privileged actions" />
        <Tile label="Source countries" value={uniq(AUDIT.map((a) => a.country)).length} foot="Sign-ins across entities" />
      </div>

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
  const entities = COUNTRIES.filter((c) => ACTIVE().some((e) => e.country === c.id));

  const exportCSV = () =>
    downloadCSV('data_inventory.csv', [
      ['Category', 'Contents', 'Lawful basis', 'Retention', 'Rationale'],
      ...RETENTION.map((r) => [r.k, r.d, r.law, r.keep, r.basis]),
    ]);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Data categories" value={RETENTION.length} foot="Mapped to a lawful basis" />
        <Tile label="Entities in scope" value={entities.length} foot="DPDP Act, GDPR, UK GDPR, PIPEDA, UAE PDPL" />
        <Tile label="Open subject requests" value={sum(dsr, (d) => d.n)} foot="All inside the 30-day statutory window" />
        <Tile label="Sub-processors" value={9} foot="Reviewed before engagement" />
      </div>

      <Card
        title="Data inventory and retention"
        sub="What we hold, why, and for how long"
        actions={<button className="btn sm" onClick={exportCSV}>⤓ Export</button>}
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

      <Banner kind="info" icon="ℹ">
        Attendance geo-coordinates are the most sensitive routine collection in this system. They are captured only
        at punch, compared against the site geo-fence, retained for 24 months and never used for continuous tracking.
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
  subtitle: () => `${AUDIT.length} events logged · ${AUDIT.filter((a) => a.sev === 'high').length} high severity`,
  Component: SecurityView,
});
