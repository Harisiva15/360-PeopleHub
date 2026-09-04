import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, DOW, fmtD, MON, monthLabelLong, parseYmd, TODAY, ymd } from '../../lib/dates';
import { inr, lakh } from '../../lib/format';
import { LOGO_LIGHT } from '../../assets/logo';
import { ACTIVE, empName } from '../../data/employees';
import {
  BANKS, DEPTS, GRADES, HOLIDAYS, HOLIDAY_MAP, LEAVE_TYPES, ltOf, ORG, PROJECTS, SITES,
} from '../../data/org';
import type { Site } from '../../types/org';
import { ATT } from '../../data/attendance';
import { LEAVES, LEAVE_BAL } from '../../data/leave';
import { TS } from '../../data/timesheet';
import { PAYRUNS } from '../../data/payroll';
import { CANDS, REQS } from '../../data/ats';
import { Badge, Banner, Card, KV, Table, TableWrap } from '../../components/ui';
import { Dot, ListRow } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { MapBox } from '../attendance/Punch';

/* ---------- Geo-fences ---------- */

/** The capture toggles, with the four that ship enabled. */
const CAPTURE_TOGGLES: [string, boolean][] = [
  ['Require GPS for mobile punch', true],
  ['Allow biometric device sync', true],
  ['Auto-flag punches outside fence', true],
  ['Allow employee self-regularisation', true],
  ['Capture selfie on punch-in', false],
];

function SiteCard({ site }: { site: Site }) {
  const app = useApp();
  const [draft, setDraft] = useState({ lat: String(site.lat), lng: String(site.lng), radius: String(site.radius), shift: site.shift });

  const save = () => {
    site.lat = +draft.lat;
    site.lng = +draft.lng;
    site.radius = +draft.radius;
    site.shift = draft.shift;
    /* Everyone at the site inherits its shift timing. */
    ACTIVE().filter((e) => e.site === site.id).forEach((e) => { e.shift = site.shift; });
    app.toast(site.name + ' geo-fence updated', 'ok');
    app.bump();
  };

  const assigned = ACTIVE().filter((e) => e.site === site.id).length;
  const exceptions = ATT.filter((a) => a.site === site.id && a.geoOk === false).length;

  return (
    <Card title={site.name} sub={site.addr}>
      <div className="grid g2" style={{ gap: '0 12px' }}>
        <div className="field">
          <label>Latitude</label>
          <input className="input" value={draft.lat} onChange={(e) => setDraft({ ...draft, lat: e.target.value })} />
        </div>
        <div className="field">
          <label>Longitude</label>
          <input className="input" value={draft.lng} onChange={(e) => setDraft({ ...draft, lng: e.target.value })} />
        </div>
        <div className="field">
          <label>Fence radius (metres)</label>
          <input type="number" className="input" value={draft.radius} onChange={(e) => setDraft({ ...draft, radius: e.target.value })} />
        </div>
        <div className="field">
          <label>Shift timing</label>
          <input className="input" value={draft.shift} onChange={(e) => setDraft({ ...draft, shift: e.target.value })} />
        </div>
      </div>

      <MapBox points={[]} site={site} height={180} />

      <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {assigned} employees assigned · {exceptions} historic exceptions
        </span>
        <button className="btn sm primary" onClick={save}>Save</button>
      </div>
    </Card>
  );
}

export function GeoTab() {
  const app = useApp();
  return (
    <div className="stack">
      <Banner kind="info" icon="📍" title="How geo-fencing works">
        Every in-office punch captures device GPS coordinates. The distance to the assigned site centre is compared
        against the fence radius — anything outside is flagged for manager approval. WFH and client-site punches log
        location for audit but do not enforce a fence.
      </Banner>

      <div className="grid g2">
        {SITES.filter((s) => s.lat).map((s) => <SiteCard key={s.id} site={s} />)}
      </div>

      <Card title="Attendance capture settings" sub="Applies to all sites">
        <div className="grid g3" style={{ gap: '0 14px' }}>
          <div className="field"><label>Grace period (minutes)</label><input type="number" className="input" defaultValue={20} /></div>
          <div className="field"><label>Full day (hours)</label><input type="number" className="input" defaultValue={8} step={0.5} /></div>
          <div className="field"><label>Half day (hours)</label><input type="number" className="input" defaultValue={4} step={0.5} /></div>
          <div className="field"><label>Break deduction (minutes)</label><input type="number" className="input" defaultValue={45} /></div>
          <div className="field"><label>Max WFH days / month</label><input type="number" className="input" defaultValue={8} /></div>
          <div className="field"><label>Late marks before penalty</label><input type="number" className="input" defaultValue={3} /></div>
        </div>
        <div className="row wrap" style={{ gap: 16, marginTop: 6 }}>
          {CAPTURE_TOGGLES.map(([k, on]) => (
            <label key={k} className="row" style={{ gap: 7, cursor: 'pointer' }}>
              <input type="checkbox" defaultChecked={on} />
              <span style={{ fontSize: 12.5 }}>{k}</span>
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => app.toast('Settings saved', 'ok')}>Save settings</button>
        </div>
      </Card>
    </div>
  );
}

/* ---------- Leave policy ---------- */

const LEAVE_RULE_TOGGLES: [string, boolean][] = [
  ['Apply sandwich rule', true],
  ['Allow half-day leave', true],
  ['Allow negative balance', false],
  ['Auto-approve after SLA breach', false],
  ['Notify team on approval', true],
];

function AddHolidayBody({ onChange }: { onChange: (v: { d: string; n: string; opt: boolean }) => void }) {
  const [v, setV] = useState({ d: ymd(addDays(TODAY, 30)), n: '', opt: false });
  const set = (next: typeof v) => { setV(next); onChange(next); };
  return (
    <>
      <div className="field">
        <label>Date</label>
        <input type="date" className="input" value={v.d} onChange={(e) => set({ ...v, d: e.target.value })} />
      </div>
      <div className="field">
        <label>Holiday name</label>
        <input className="input" placeholder="e.g. Founders Day" value={v.n} onChange={(e) => set({ ...v, n: e.target.value })} />
      </div>
      <div className="field">
        <label>Type</label>
        <select className="input" value={v.opt ? '1' : '0'} onChange={(e) => set({ ...v, opt: e.target.value === '1' })}>
          <option value="0">Fixed</option>
          <option value="1">Optional</option>
        </select>
      </div>
    </>
  );
}

export function LeavePolicyTab() {
  const app = useApp();
  const layer = useLayer();

  const setQuota = (id: string, quota: number) => {
    const t = ltOf(id);
    t.quota = quota;
    /* An entitlement change reprices every open balance, not just new joiners. */
    ACTIVE().forEach((e) => {
      const bal = LEAVE_BAL[e.id]?.[t.id];
      if (bal) bal.quota = quota;
    });
    app.toast(`${t.name} quota updated to ${quota} days`, 'ok');
    app.bump();
  };

  const addHoliday = () => {
    let draft = { d: ymd(addDays(TODAY, 30)), n: '', opt: false };
    layer.modal({
      title: 'Add holiday',
      size: 'narrow',
      body: <AddHolidayBody onChange={(v) => { draft = v; }} />,
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => {
              const n = draft.n || 'Company holiday';
              HOLIDAYS.push({ d: draft.d, n, opt: draft.opt });
              HOLIDAYS.sort((a, b) => (a.d < b.d ? -1 : 1));
              if (!draft.opt) HOLIDAY_MAP[draft.d] = n;
              close();
              app.toast('Holiday added to the calendar', 'ok');
              app.bump();
            }}
          >
            Add holiday
          </button>
        </>
      ),
    });
  };

  return (
    <div className="stack">
      <Card
        title="Leave types & entitlement"
        sub={`${ORG.fy} · effective 1 April`}
        actions={<button className="btn sm primary" onClick={() => app.toast('Settings saved', 'ok')}>Save policy</button>}
        flush
      >
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Leave type</th><th className="num">Annual quota</th><th>Carry forward</th>
                <th className="num">Carry cap</th><th>Encashable</th><th>Applies to</th><th>Approval</th>
              </tr>
            </thead>
            <tbody>
              {LEAVE_TYPES.map((t) => (
                <tr key={t.id}>
                  <td><Dot color={t.color} /> <b>{t.name}</b></td>
                  <td className="num">
                    <input
                      type="number"
                      className="input"
                      style={{ width: 74, padding: '4px 7px' }}
                      defaultValue={t.quota}
                      onChange={(e) => setQuota(t.id, +e.target.value)}
                    />
                  </td>
                  <td><Badge kind={t.carry ? 'good' : 'mute'}>{t.carry ? 'Yes' : 'No'}</Badge></td>
                  <td className="num">{t.cap || '—'}</td>
                  <td>{t.encash ? 'Yes' : 'No'}</td>
                  <td>{t.gender ? (t.gender === 'F' ? 'Female employees' : 'Male employees') : 'All employees'}</td>
                  <td>{t.id === 'ML' || t.id === 'LOP' ? 'Manager + HR' : 'Reporting manager'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <div className="grid g2">
        <Card title="Policy rules" sub="Configurable parameters">
          <div className="grid g2" style={{ gap: '0 14px' }}>
            <div className="field">
              <label>Leave year starts</label>
              <select className="input" defaultValue="1 April"><option>1 April</option><option>1 January</option></select>
            </div>
            <div className="field">
              <label>Accrual frequency</label>
              <select className="input" defaultValue="Monthly">
                <option>Monthly</option><option>Quarterly</option><option>Annual upfront</option>
              </select>
            </div>
            <div className="field"><label>Notice for casual leave (days)</label><input type="number" className="input" defaultValue={2} /></div>
            <div className="field"><label>Notice for earned leave (days)</label><input type="number" className="input" defaultValue={7} /></div>
            <div className="field"><label>Medical certificate after (days)</label><input type="number" className="input" defaultValue={3} /></div>
            <div className="field"><label>Comp-off validity (days)</label><input type="number" className="input" defaultValue={60} /></div>
          </div>
          <div className="row wrap" style={{ gap: 16 }}>
            {LEAVE_RULE_TOGGLES.map(([k, on]) => (
              <label key={k} className="row" style={{ gap: 7, cursor: 'pointer' }}>
                <input type="checkbox" defaultChecked={on} />
                <span style={{ fontSize: 12.5 }}>{k}</span>
              </label>
            ))}
          </div>
        </Card>

        <Card
          title="Holiday calendar"
          sub={`${HOLIDAYS.length} holidays configured`}
          actions={<button className="btn sm" onClick={addHoliday}>＋ Add</button>}
          flush
        >
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {HOLIDAYS.map((h) => {
              const d = parseYmd(h.d);
              return (
                <ListRow key={h.d + h.n}>
                  <div className="right" style={{ width: 48, flex: '0 0 48px' }}>
                    <div style={{ fontWeight: 750 }}>{d.getDate()}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{MON[d.getMonth()]}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>{h.n}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{DOW[d.getDay()]}</div>
                  </div>
                  <Badge kind={h.opt ? 'info' : 'mute'}>{h.opt ? 'Optional' : 'Fixed'}</Badge>
                </ListRow>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------- Salary components ---------- */

type CompKind = 'Earning' | 'Deduction' | 'Benefit';

/** [component, kind, calculation, taxable, part of gross, PF applicable] */
const COMPONENTS: [string, CompKind, string, string, string, string][] = [
  ['Basic Salary', 'Earning', '40% of annual CTC', 'Yes', 'Yes', 'Yes'],
  ['House Rent Allowance', 'Earning', '50% of Basic', 'Exempt u/s 10(13A)', 'Yes', 'No'],
  ['Leave Travel Allowance', 'Earning', '8% of Basic', 'Exempt on claim', 'Yes', 'No'],
  ['Special Allowance', 'Earning', 'Balancing figure', 'Yes', 'Yes', 'No'],
  ['Employer PF', 'Benefit', '12% of Basic (capped ₹15,000/month)', 'No', 'No', '—'],
  ['Gratuity accrual', 'Benefit', '4.81% of Basic', 'Exempt to ₹20 L', 'No', '—'],
  ['Group Medical Insurance', 'Benefit', '₹12,000 per annum', 'No', 'No', '—'],
  ['Employee PF', 'Deduction', '12% of Basic (capped ₹15,000/month)', '80C deduction', '—', '—'],
  ['ESI (employee)', 'Deduction', '0.75% of gross if ≤ ₹21,000', 'No', '—', '—'],
  ['Professional Tax', 'Deduction', 'State slab (₹200–₹208/month)', '16(iii) deduction', '—', '—'],
  ['Income Tax (TDS)', 'Deduction', 'Section 192 monthly average', '—', '—', '—'],
];

const KIND_TONE: Record<CompKind, 'good' | 'crit' | 'info'> = { Earning: 'good', Deduction: 'crit', Benefit: 'info' };

export function PayConfigTab() {
  const app = useApp();
  const grades = Object.keys(GRADES) as (keyof typeof GRADES)[];

  return (
    <div className="stack">
      <Card
        title="Salary components"
        sub="How CTC is broken down for every employee"
        actions={<button className="btn sm primary" onClick={() => app.toast('Settings saved', 'ok')}>Save</button>}
        flush
      >
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Component</th><th>Type</th><th>Calculation</th>
                <th>Taxable</th><th>Part of gross</th><th>PF applicable</th>
              </tr>
            </thead>
            <tbody>
              {COMPONENTS.map((r) => (
                <tr key={r[0]}>
                  <td><b>{r[0]}</b></td>
                  <td><Badge kind={KIND_TONE[r[1]]}>{r[1]}</Badge></td>
                  <td>{r[2]}</td><td>{r[3]}</td><td>{r[4]}</td><td>{r[5]}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <div className="grid g2">
        <Card title="Payroll configuration" sub="Cycle and cut-offs">
          <div className="grid g2" style={{ gap: '0 14px' }}>
            <div className="field">
              <label>Pay cycle</label>
              <select className="input" defaultValue="Monthly (calendar)">
                <option>Monthly (calendar)</option><option>Monthly (26th–25th)</option>
              </select>
            </div>
            <div className="field">
              <label>Attendance cut-off</label>
              <input type="number" className="input" defaultValue={25} />
              <div className="hint">Day of month</div>
            </div>
            <div className="field">
              <label>Salary credit date</label>
              <input type="number" className="input" defaultValue={1} />
              <div className="hint">Of the following month</div>
            </div>
            <div className="field"><label>PF wage ceiling (₹)</label><input type="number" className="input" defaultValue={15000} /></div>
            <div className="field"><label>ESI gross ceiling (₹)</label><input type="number" className="input" defaultValue={21000} /></div>
            <div className="field"><label>Basic as % of CTC</label><input type="number" className="input" defaultValue={40} /></div>
          </div>
        </Card>

        <Card title="Compensation bands" sub={`${grades.length} grades`} flush>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Grade</th><th className="num">Minimum</th><th className="num">Maximum</th>
                  <th className="num">Employees</th><th className="num">Median actual</th>
                </tr>
              </thead>
              <tbody>
                {grades.map((g) => {
                  const es = ACTIVE().filter((e) => e.grade === g);
                  const med = es.length ? sortBy(es, (e) => e.ctc)[Math.floor(es.length / 2)].ctc : 0;
                  return (
                    <tr key={g}>
                      <td><b>{GRADES[g].label}</b></td>
                      <td className="num">{inr(GRADES[g].min)}</td>
                      <td className="num">{inr(GRADES[g].max)}</td>
                      <td className="num">{es.length}</td>
                      <td className="num">{med ? inr(med) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      </div>
    </div>
  );
}

/* ---------- Org structure ---------- */

export function OrgTab() {
  const app = useApp();
  return (
    <div className="stack">
      <div className="grid g2">
        <Card
          title="Departments"
          sub={`${DEPTS.length} configured`}
          actions={
            <button className="btn sm" onClick={() => app.toast('Department creation requires CEO approval in this configuration')}>
              ＋ Add
            </button>
          }
          flush
        >
          <TableWrap>
            <Table>
              <thead>
                <tr><th>Department</th><th>Head</th><th className="num">Headcount</th><th className="num">Annual cost</th><th className="num">Open roles</th></tr>
              </thead>
              <tbody>
                {DEPTS.map((d) => (
                  <tr key={d.id}>
                    <td><Dot color={d.color} /> <b>{d.name}</b></td>
                    <td className="nowrap">{empName(d.head || '')}</td>
                    <td className="num">{ACTIVE().filter((e) => e.dept === d.id).length}</td>
                    <td className="num">{lakh(sum(ACTIVE().filter((e) => e.dept === d.id), (e) => e.ctc))}</td>
                    <td className="num">{sum(REQS.filter((r) => r.dept === d.id && r.status === 'Open'), (r) => r.openings - r.filled)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>

        <Card title="Locations" sub={`${SITES.length} configured`} flush>
          <TableWrap>
            <Table>
              <thead>
                <tr><th>Location</th><th>City</th><th className="num">Headcount</th><th>Shift</th><th className="num">PT / month</th></tr>
              </thead>
              <tbody>
                {SITES.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    <td>{s.city}</td>
                    <td className="num">{ACTIVE().filter((e) => e.site === s.id).length}</td>
                    <td>{s.shift}</td>
                    <td className="num">{inr(s.ptax)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      </div>

      <Card title="Projects & cost centres" sub={`${PROJECTS.length} active projects`} flush>
        <TableWrap>
          <Table>
            <thead>
              <tr><th>Project</th><th>Client</th><th>Billable</th><th className="num">Hours logged</th><th className="num">People engaged</th></tr>
            </thead>
            <tbody>
              {PROJECTS.map((p) => {
                const ts = TS.filter((t) => t.rows.some((r) => r.proj === p.id));
                return (
                  <tr key={p.id}>
                    <td><Dot color={p.color} /> <b>{p.name}</b></td>
                    <td>{p.client}</td>
                    <td><Badge kind={p.billable ? 'good' : 'mute'}>{p.billable ? 'Billable' : 'Internal'}</Badge></td>
                    <td className="num">{sum(ts, (t) => sum(t.rows.filter((r) => r.proj === p.id), (r) => sum(r.h)))}</td>
                    <td className="num">{uniq(ts.map((t) => t.empId)).length}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </div>
  );
}

/* ---------- Company profile ---------- */

const INTEGRATIONS: [string, string, 'good' | 'mute'][] = [
  ['Biometric devices (3 sites)', 'Connected', 'good'],
  ['EPFO Unified Portal', 'Connected', 'good'],
  [`Bank — ${BANKS[0]} Corporate`, 'Connected', 'good'],
  ['Google Workspace SSO', 'Connected', 'good'],
  ['Slack notifications', 'Not configured', 'mute'],
  ['Naukri / LinkedIn job posting', 'Connected', 'good'],
  ['Tally / ERP journal export', 'Not configured', 'mute'],
];

export function CompanyTab() {
  const app = useApp();
  return (
    <div className="grid g-2-1">
      <Card
        title="Company profile"
        sub="Used on payslips, offer letters and statutory filings"
        actions={<button className="btn sm primary" onClick={() => app.toast('Settings saved', 'ok')}>Save</button>}
      >
        <div className="grid g2" style={{ gap: '0 14px' }}>
          <div className="field"><label>Product name</label><input className="input" defaultValue={ORG.product} /></div>
          <div className="field"><label>Trading name</label><input className="input" defaultValue={ORG.name} /></div>
          <div className="field"><label>Legal entity name</label><input className="input" defaultValue={ORG.legal} /></div>
          <div className="field"><label>CIN</label><input className="input" defaultValue={ORG.cin} /></div>
          <div className="field"><label>Company PAN</label><input className="input" defaultValue={ORG.pan} /></div>
          <div className="field"><label>TAN</label><input className="input" defaultValue={ORG.tan} /></div>
          <div className="field"><label>Financial year</label><input className="input" defaultValue={ORG.fy} /></div>
          <div className="field"><label>Brand name (used on documents)</label><input className="input" defaultValue={ORG.name} /></div>
          <div className="field"><label>Tagline</label><input className="input" defaultValue={ORG.tagline} /></div>
        </div>

        <div className="field">
          <label>Logo</label>
          <div className="banner" style={{ background: '#fff', borderColor: '#e1e0d9' }}>
            <img src={LOGO_LIGHT} alt={ORG.name} style={{ height: 44, width: 'auto' }} />
            <div style={{ color: '#45443f' }}>
              <div className="t" style={{ color: '#101010' }}>Primary logo</div>
              Used on payslips, offer letters, certificates and the app header. A light variant is applied
              automatically in dark mode.
            </div>
          </div>
        </div>

        <div className="field">
          <label>Registered address</label>
          <textarea className="input" defaultValue={ORG.addr} />
        </div>
      </Card>

      <div className="stack">
        <Card title="At a glance" sub="Live system counts">
          <KV
            rows={[
              ['Active employees', ACTIVE().length],
              ['Departments', DEPTS.length],
              ['Locations', `${SITES.filter((s) => s.lat).length} offices + remote`],
              ['Attendance records', ATT.length.toLocaleString('en-IN')],
              ['Timesheets', TS.length.toLocaleString('en-IN')],
              ['Leave requests', LEAVES.length.toLocaleString('en-IN')],
              ['Payroll cycles', PAYRUNS.length],
              ['Open requisitions', REQS.filter((r) => r.status === 'Open').length],
              ['Candidates', CANDS.length],
            ]}
          />
        </Card>

        <Card title="Integrations" sub="Connected systems" flush>
          {INTEGRATIONS.map((i) => (
            <ListRow key={i[0]}>
              <span>🔌</span>
              <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{i[0]}</div>
              <Badge kind={i[2]}>{i[1]}</Badge>
            </ListRow>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ---------- Configuration audit log ---------- */

/**
 * The configuration-change log, distinct from the full security audit trail:
 * it records who changed the system's settings, not who used it.
 */
const CONFIG_ACTIONS: [string, string, string, number][] = [
  ['Payroll', '', 'Balaji Srinivasan', 0],
  ['Access', 'Role changed to Manager for 2 users', 'Priya Raghavan', 1],
  ['Attendance', 'Bengaluru geo-fence radius updated 200 m → 220 m', 'Karthik Shetty', 2],
  ['Hiring', 'Requisition JR-2603 approved (Engineering Manager — Platform)', 'Vikram Sundaram', 3],
  ['Payroll', 'Salary revision applied to 14 employees', 'Priya Raghavan', 5],
  ['Leave', 'Leave policy updated — EL carry-forward cap set to 30 days', 'Priya Raghavan', 8],
  ['Employee', '3 employees added via onboarding automation', 'System', 9],
  ['Compliance', 'Form 24Q Q1 filed with the Income Tax Department', 'Balaji Srinivasan', 12],
  ['Security', 'Two-factor authentication enforced for admin role', 'System', 15],
  ['Attendance', 'Bulk regularisation approved (biometric outage, 22 records)', 'Anitha Menon', 18],
];

export function ConfigAuditTab() {
  const app = useApp();
  const rows = CONFIG_ACTIONS.map((a, i) => ({
    cat: a[0],
    /* The first row names the last locked payroll cycle. */
    action: a[1] || 'Payroll run locked for ' + monthLabelLong(PAYRUNS[PAYRUNS.length - 2].mk),
    by: a[2],
    on: fmtD(addDays(TODAY, -a[3])),
    at: `${9 + (i % 9)}:${String(10 + i * 5).padStart(2, '0')}`,
    ip: `10.4.${1 + i}.${2 + i * 7}`,
  }));

  return (
    <Card
      title="Audit log"
      sub="Configuration and privileged actions · last 30 days"
      actions={<button className="btn sm" onClick={() => app.toast('Audit log exported', 'ok')}>⤓ Export</button>}
      flush
    >
      <TableWrap>
        <Table>
          <thead>
            <tr><th>When</th><th>Category</th><th>Action</th><th>Performed by</th><th>IP</th></tr>
          </thead>
          <tbody>
            {rows.map((a, i) => (
              <tr key={i}>
                <td className="nowrap">{a.on} {a.at}</td>
                <td><Badge kind="info">{a.cat}</Badge></td>
                <td>{a.action}</td>
                <td className="nowrap">{a.by}</td>
                <td className="mono muted">{a.ip}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </Card>
  );
}

