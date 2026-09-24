import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, DOW, MON, parseYmd, TODAY, ymd } from '../../lib/dates';
import { inr, lakh } from '../../lib/format';
import { LOGO_LIGHT } from '../../assets/logo';

import { BANKS, GRADES, LEAVE_TYPES, ORG, PROJECTS } from '../../data/org';
import type { Site } from '../../types/org';
import type { ComponentKind, SalaryComponent } from '../../services';
import { applyComponents } from '../../lib/compensation';
import type { CountryId } from '../../types/country';
import { COUNTRIES } from '../../data/countries';





import { Badge, Banner, Card, EmptyState, KV, Table, TableWrap } from '../../components/ui';
import { notBacked } from '../../components/NotBacked';
import { AuditTab } from '../security';
import { Dot, ListRow } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import type { Department, DepartmentDraft } from '../../services';
import { FenceForm } from './Fence';
import {
  useAddHoliday, useAllEmployees, useAttendanceAll, useCandidates, useCompensation,
  useCreateSite, useHolidays, useLeaveAll, usePayRuns, useRequisitions,
  useComponents, useRemoveComponent, useSaveComponent,
  useSetLeaveQuota, useSetSiteActive, useSites,
  useTimesheetsAll, useUpdateSite, useVisiblePeople,
  useDepartments, useCreateDepartment, useUpdateDepartment, useRemoveDepartment,
} from './data';
import { Icon } from '../../components/icons';

/* ---------- Locations ---------- */

/** The capture toggles, with the three that ship enabled. */
const CAPTURE_TOGGLES: [string, boolean][] = [
  ['Allow biometric device sync', true],
  ['Allow employee self-regularisation', true],
  ['Auto-flag missing punches', true],
  ['Require a reason on regularisation', true],
];

const KIND_LABEL: Record<NonNullable<Site['kind']>, string> = {
  headquarters: 'Head office',
  office: 'Office',
  client: 'Client site',
  remote: 'Remote',
};

function SiteCard(
  { site, assigned, onFence, onEdit, onToggle }:
  {
    site: Site;
    assigned: number;
    onFence: (s: Site) => void;
    onEdit: (s: Site) => void;
    onToggle: (s: Site) => void;
  },
) {
  const fenced = site.lat !== null && site.lng !== null && site.radius !== null;
  const closed = site.active === false;
  const where = [site.city, site.state, site.postcode].filter((x) => x && x !== '—').join(', ');
  return (
    <Card
      title={site.name}
      sub={site.addr || where || undefined}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => onEdit(site)}>Edit</button>
          {!site.remote && !closed && (
            <button className="btn sm" onClick={() => onFence(site)}>
              {fenced ? 'Move fence' : 'Set a fence'}
            </button>
          )}
          <button className="btn sm" onClick={() => onToggle(site)}>
            {closed ? 'Reopen' : 'Close'}
          </button>
        </div>
      }>
      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        <Badge>{site.id}</Badge>
        <Badge>{KIND_LABEL[site.kind ?? 'office']}</Badge>
        {site.headquarters && <Badge kind="good">Head office</Badge>}
        {closed && <Badge kind="warn">Closed</Badge>}
      </div>
      <KV rows={[
        ['City', site.city && site.city !== '—' ? site.city : '—'],
        ['State', site.state || '—'],
        ['Postal code', site.postcode || '—'],
        ['Country', site.country],
        ['Timezone', site.tz],
        ['Shift timing', site.shift],
        ['Employees based here', String(assigned)],
        ['Geo-fence', site.remote
          ? <span className="muted">A way of working, not a place — never fenced</span>
          : fenced
            ? `${site.radius} m around ${site.lat!.toFixed(4)}, ${site.lng!.toFixed(4)}`
            : <span className="muted">Not set — punches here are never measured</span>],
      ]} />
    </Card>
  );
}

/**
 * Open a location, or change one.
 *
 * The code identifies the location on every employee, punch and requisition
 * that refers to it, so it is asked for once and then shown rather than
 * offered. Renaming an office is ordinary; renumbering it is a migration.
 *
 * Nothing here decides what may be saved. Head office moving, a duplicate
 * code, a closed site being nominated — all of those are refused by the server,
 * and the refusal is shown where it happened rather than guessed at first.
 */
function SiteForm({ close, existing }: { close: () => void; existing?: Site }) {
  const app = useApp();
  const create = useCreateSite();
  const update = useUpdateSite();
  const editing = existing !== undefined;

  const [code, setCode] = useState(existing?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [city, setCity] = useState(existing?.city === '—' ? '' : existing?.city ?? '');
  const [state, setState] = useState(existing?.state ?? '');
  const [postcode, setPostcode] = useState(existing?.postcode ?? '');
  const [country, setCountry] = useState(existing?.country ?? 'IN');
  const [address, setAddress] = useState(existing?.addr ?? '');
  const [timezone, setTimezone] = useState(existing?.tz ?? 'Asia/Kolkata');
  const [kind, setKind] = useState<NonNullable<Site['kind']>>(existing?.kind ?? 'office');
  const [busy, setBusy] = useState(false);

  const promoting = kind === 'headquarters' && !existing?.headquarters;

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        city: city.trim(),
        state: state.trim(),
        country,
        address: address.trim(),
        postcode: postcode.trim(),
        timezone: timezone.trim(),
        kind,
      };
      if (editing) await update.mutate(existing.id, body);
      else await create.mutate({ code: code.trim().toUpperCase(), ...body });
      app.toast(editing ? 'Location saved' : 'Location opened', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not save the location', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="grid g2">
        <label className="fld">
          <span>Code</span>
          <input className="input" value={code} disabled={editing} autoFocus={!editing}
            placeholder="BLR" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          {editing && (
            <span className="muted" style={{ fontSize: 11.5 }}>
              Every record that names this location uses the code, so it does not change.
            </span>
          )}
        </label>
        <label className="fld">
          <span>Name</span>
          <input className="input" value={name} autoFocus={editing}
            placeholder="Bengaluru" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="fld">
          <span>Kind</span>
          <select className="input" value={kind}
            onChange={(e) => setKind(e.target.value as NonNullable<Site['kind']>)}>
            {(Object.keys(KIND_LABEL) as NonNullable<Site['kind']>[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>City</span>
          <input className="input" value={city} onChange={(e) => setCity(e.target.value)} />
        </label>
        <label className="fld">
          <span>State</span>
          <input className="input" value={state} placeholder="Karnataka"
            onChange={(e) => setState(e.target.value)} />
        </label>
        <label className="fld">
          <span>Postal code</span>
          <input className="input" value={postcode} placeholder="560103"
            onChange={(e) => setPostcode(e.target.value)} />
        </label>
        <label className="fld">
          <span>Country</span>
          {/*
            * A list rather than a text box. Payroll, statutory deductions and
            * the tax year all branch on the country, and only these five are
            * implemented — a location in a sixth would take joiners and then
            * have no way to pay them.
            */}
          <select className="input" value={country}
            onChange={(e) => setCountry(e.target.value as CountryId)}>
            {COUNTRIES.map((c) => (
              <option key={c.id} value={c.id}>{c.flag} {c.name}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>Timezone</span>
          <input className="input" value={timezone} placeholder="Asia/Kolkata"
            onChange={(e) => setTimezone(e.target.value)} />
        </label>
      </div>
      <label className="fld">
        <span>Address</span>
        <input className="input" value={address}
          placeholder="Ecospace, Bellandur, ORR"
          onChange={(e) => setAddress(e.target.value)} />
      </label>

      {promoting && (
        <Banner kind="warn" title="This becomes the company's head office">
          A company has one. Nominating this location demotes the current head
          office to an ordinary office in the same step — letters, payslips and
          statutory filings that name the registered address will follow it.
        </Banner>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save location' : 'Open location'}
        </button>
      </div>
    </div>
  );
}

/**
 * Locations, with the fence editable again.
 *
 * The note that used to sit here said the fence was gone. It was, between
 * migrations 0016 and 0018 — and 0018 brought it back without anybody
 * revisiting this screen, so it went on claiming no coordinates were collected
 * while every punch was storing one.
 *
 * The default shift stays un-editable per site, and that part of the old note
 * still holds: a shift is now a regional tag on the person, so an India-shift
 * and a US-shift colleague can sit in the same office and a site-wide push
 * would overwrite one of them.
 */
export function LocationsTab() {
  const app = useApp();
  const layer = useLayer();
  /* useQuery re-runs on any mutation, so a save here refreshes the list. */
  const { data: sites = [] } = useSites();
  const { data: everyone = [] } = useAllEmployees();
  const setActive = useSetSiteActive();

  const editFence = (site: Site) => layer.modal({
    title: `Geo-fence — ${site.name}`,
    sub: 'What counts as being at this site',
    size: 'narrow',
    body: (close: () => void) => <FenceForm close={close} site={site} />,
    footer: null,
  });

  const editSite = (site: Site) => layer.modal({
    title: site.name,
    sub: 'The location, as every record that names it will read',
    size: 'narrow',
    body: (close: () => void) => <SiteForm close={close} existing={site} />,
    footer: null,
  });

  const addSite = () => layer.modal({
    title: 'Open a location',
    sub: 'It becomes choosable on every posting screen',
    size: 'narrow',
    body: (close: () => void) => <SiteForm close={close} />,
    footer: null,
  });

  /*
   * Closing is refused by the server while anyone is posted there, and for head
   * office at any time. The button stays enabled and the refusal is shown,
   * because a disabled button with no explanation is the version of this rule
   * nobody learns anything from.
   */
  const toggle = async (site: Site) => {
    const closing = site.active !== false;
    try {
      await setActive.mutate(site.id, !closing);
      app.toast(closing ? `${site.name} closed` : `${site.name} reopened`, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not change the location', 'err');
    }
  };

  const open = sites.filter((s) => s.active !== false);
  const closed = sites.filter((s) => s.active === false);
  const hq = open.find((s) => s.headquarters);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {hq
            ? <>Head office is <b>{hq.name}</b>. {open.length} locations open.</>
            : <>No head office is nominated. {open.length} locations open.</>}
        </div>
        <button className="btn primary sm" onClick={addSite}>Open a location</button>
      </div>

      <Banner kind="warn" icon={<Icon n="location" size="lg" />} title="Punches record where they were made">
        Punching in asks the browser for a position and stores it against the punch,
        with the distance from this site at that moment. A punch outside the fence is
        flagged for review, never refused. A punch history with coordinates is a
        movement history of a named person — it belongs in the retention register,
        and people should be told it is collected.
      </Banner>

      <div className="grid g2">
        {open.map((s) => (
          <SiteCard
            key={s.id}
            site={s}
            assigned={everyone.filter((e) => e.site === s.id).length}
            onFence={editFence}
            onEdit={editSite}
            onToggle={toggle}
          />
        ))}
      </div>

      {closed.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            Closed. Nobody can be posted here, and the records that already name
            one of these still resolve to it.
          </div>
          <div className="grid g2">
            {closed.map((s) => (
              <SiteCard
                key={s.id}
                site={s}
                assigned={everyone.filter((e) => e.site === s.id).length}
                onFence={editFence}
                onEdit={editSite}
                onToggle={toggle}
              />
            ))}
          </div>
        </>
      )}

      {/*
        * Attendance capture is not stored anywhere yet. The card used to end in
        * a Save that toasted "Settings saved" and wrote nothing — a form that
        * reports success for work it did not do is worse than one that is
        * plainly not finished, because the numbers then appear to be in force.
        */}
      <Card title="Attendance capture settings"
        sub="Not yet stored — these are the defaults the rules currently use">
        <div className="grid g3" style={{ gap: '0 14px' }}>
          <div className="field"><label>Grace period (minutes)</label><input type="number" className="input" value={20} disabled readOnly /></div>
          <div className="field"><label>Full day (hours)</label><input type="number" className="input" value={8} step={0.5} disabled readOnly /></div>
          <div className="field"><label>Half day (hours)</label><input type="number" className="input" value={4} step={0.5} disabled readOnly /></div>
          <div className="field"><label>Break deduction (minutes)</label><input type="number" className="input" value={45} disabled readOnly /></div>
          <div className="field"><label>Max WFH days / month</label><input type="number" className="input" value={8} disabled readOnly /></div>
          <div className="field"><label>Late marks before penalty</label><input type="number" className="input" value={3} disabled readOnly /></div>
        </div>
        <div className="row wrap" style={{ gap: 16, marginTop: 6 }}>
          {CAPTURE_TOGGLES.map(([k, on]) => (
            <label key={k} className="row" style={{ gap: 7 }}>
              <input type="checkbox" checked={on} disabled readOnly />
              <span style={{ fontSize: 12.5 }}>{k}</span>
            </label>
          ))}
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
  const { data: HOLIDAYS = [] } = useHolidays();
  const setLeaveQuota = useSetLeaveQuota();
  const addHolidayCmd = useAddHoliday();

  const setQuota = async (id: string, quota: number) => {
    try {
      const r = await setLeaveQuota.mutate(id, quota);
      app.toast(`${r.type} quota updated to ${r.quota} days · ${r.repriced} balances repriced`, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not update the quota', 'err');
    }
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
            onClick={async () => {
              try {
                await addHolidayCmd.mutate(draft.d, draft.n || 'Company holiday', draft.opt);
                close();
                app.toast('Holiday added to the calendar', 'ok');
              } catch (e) {
                app.toast(e instanceof Error ? e.message : 'Could not add the holiday', 'err');
              }
            }}
          >
            Add holiday
          </button>
        </>
      ),
    });
  };

  /*
   * The card has no Save button. Each quota persists the moment it changes,
   * through setLeaveQuota, which reports how many balances it repriced. A Save
   * button beside that would claim to commit the rest of the card too —
   * carry-forward, caps, encashment — and those have no endpoint, which is why
   * they are shown read-only rather than as inputs.
   */
  return (
    <div className="stack">
      <Card
        title="Leave types & entitlement"
        sub={`${ORG.fy} · effective 1 April`}
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
          actions={<button className="btn sm" onClick={addHoliday}><Icon n="add" size="lg" /> Add</button>}
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


/** [component, kind, calculation, taxable, part of gross, PF applicable] */

/* ---------- salary components ---------- */

const COMP_KIND_LABEL: Record<ComponentKind, string> = {
  earning: 'Earning',
  deduction: 'Deduction',
  employer_contribution: 'Employer cost',
  reimbursement: 'Reimbursement',
};
const COMP_KIND_TONE: Record<ComponentKind, 'good' | 'crit' | 'info' | 'mute'> = {
  earning: 'good',
  deduction: 'crit',
  employer_contribution: 'info',
  reimbursement: 'mute',
};

/** How a component's figure is arrived at, in the words the table shows. */
const basisOf = (c: SalaryComponent): string =>
  c.flat !== null ? `Fixed ${inr(c.flat)} per annum`
    : c.percentOf === null ? `${c.percent}% of annual CTC`
      : `${c.percent}% of ${c.percentOf}`;

/**
 * Create a component, or change one.
 *
 * The code is the identity every other component refers to — HRA is "50% of
 * BASIC" by code — so it is asked for once and shown thereafter.
 */
function ComponentForm({ close, existing, others }: {
  close: () => void;
  existing?: SalaryComponent;
  others: SalaryComponent[];
}) {
  const app = useApp();
  const save = useSaveComponent();
  const editing = existing !== undefined;

  const [code, setCode] = useState(existing?.code ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<ComponentKind>(existing?.kind ?? 'earning');
  const [mode, setMode] = useState<'percent' | 'flat'>(existing?.flat !== null && existing !== undefined ? 'flat' : 'percent');
  const [percent, setPercent] = useState(existing?.percent !== null && existing?.percent !== undefined ? String(existing.percent) : '');
  const [flat, setFlat] = useState(existing?.flat !== null && existing?.flat !== undefined ? String(existing.flat) : '');
  const [percentOf, setPercentOf] = useState(existing?.percentOf ?? '');
  const [taxable, setTaxable] = useState(existing?.taxable ?? true);
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);

  /* Only a component that is itself a percentage of CTC may be a base. */
  const bases = others.filter((c) => c.percentOf === null && c.flat === null && c.code !== existing?.code);

  const submit = async () => {
    setBusy(true);
    try {
      await save.mutate({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        kind,
        percentOf: mode === 'percent' && percentOf ? percentOf : null,
        percent: mode === 'percent' ? Number(percent) : null,
        flat: mode === 'flat' ? Number(flat) : null,
        taxable,
        active,
        ...(existing ? { order: existing.order } : {}),
      });
      app.toast(editing ? 'Component saved' : 'Component added', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not save the component', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="grid g2">
        <label className="fld">
          <span>Code</span>
          <input className="input" value={code} disabled={editing} autoFocus={!editing}
            placeholder="HRA" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          {editing && (
            <span className="muted" style={{ fontSize: 11.5 }}>
              Other components refer to this one by its code, so it does not change.
            </span>
          )}
        </label>
        <label className="fld">
          <span>Name</span>
          <input className="input" value={name} autoFocus={editing}
            placeholder="House Rent Allowance" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="fld">
          <span>Type</span>
          <select className="input" value={kind}
            onChange={(e) => setKind(e.target.value as ComponentKind)}>
            {(Object.keys(COMP_KIND_LABEL) as ComponentKind[]).map((k) => (
              <option key={k} value={k}>{COMP_KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>Calculated as</span>
          <select className="input" value={mode}
            onChange={(e) => setMode(e.target.value as 'percent' | 'flat')}>
            <option value="percent">A percentage</option>
            <option value="flat">A fixed annual amount</option>
          </select>
        </label>

        {mode === 'percent' ? (
          <>
            <label className="fld">
              <span>Percentage</span>
              <input className="input" type="number" step="0.001" min="0" value={percent}
                placeholder="40" onChange={(e) => setPercent(e.target.value)} />
            </label>
            <label className="fld">
              <span>Of</span>
              <select className="input" value={percentOf}
                onChange={(e) => setPercentOf(e.target.value)}>
                <option value="">Annual CTC</option>
                {bases.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
          </>
        ) : (
          <label className="fld">
            <span>Annual amount</span>
            <input className="input" type="number" min="0" value={flat}
              placeholder="12000" onChange={(e) => setFlat(e.target.value)} />
          </label>
        )}
      </div>

      <div className="row wrap" style={{ gap: 16 }}>
        <label className="row" style={{ gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />
          <span style={{ fontSize: 12.5 }}>Taxable</span>
        </label>
        <label className="row" style={{ gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span style={{ fontSize: 12.5 }}>Active</span>
        </label>
      </div>

      {mode === 'flat' && (
        <Banner kind="warn" title="A fixed amount cannot scale with CTC">
          Percentages reconcile to any CTC; a fixed amount does not. Adding one
          means the percentage components must be reduced so the total still
          comes to each employee&rsquo;s CTC exactly, or the structure is refused.
        </Banner>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save component' : 'Add component'}
        </button>
      </div>
    </div>
  );
}

/**
 * The company's salary formula.
 *
 * This table used to be eleven hard-coded rows above a Save button that toasted
 * and wrote nothing. The rows described what `structureFor` in payroll/rules.ts
 * does, which was accurate and entirely unconnected to it — editing them was
 * impossible and appearing to save them was misleading.
 *
 * The reconciliation line is the one that matters: components only take effect
 * for an employee who has a stored compensation, and a structure is refused
 * unless the earnings and employer costs come to exactly their CTC. Showing the
 * total against 100% here means that refusal is never a surprise.
 */
function SalaryComponentsCard() {
  const app = useApp();
  const layer = useLayer();
  const { data: components = [], loading } = useComponents();
  const remove = useRemoveComponent();

  /* The same arithmetic the server does, against a round number, so the
     percentages can be read as a proportion of CTC rather than of each other. */
  const SAMPLE = 1_000_000;
  const check = applyComponents(components, SAMPLE);

  const edit = (c?: SalaryComponent) => layer.modal({
    title: c ? c.name : 'Add a salary component',
    sub: c ? `Component ${c.code}` : 'One rule in the company’s salary formula',
    size: 'narrow',
    body: (close: () => void) => (
      <ComponentForm close={close} existing={c} others={components} />
    ),
    footer: null,
  });

  const drop = async (c: SalaryComponent) => {
    try {
      await remove.mutate(c.code);
      app.toast(`${c.name} removed`, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not remove the component', 'err');
    }
  };

  return (
    <Card
      title="Salary components"
      sub="How CTC is broken down. Applies to employees with a stored compensation."
      actions={<button className="btn sm primary" onClick={() => edit()}>Add component</button>}
      flush
    >
      {!loading && components.length === 0 ? (
        <div style={{ padding: 16 }}>
          <EmptyState icon={<Icon n="money" size="lg" />} msg="No components defined. Until one exists every payslip uses the built-in defaults — basic at 40% of CTC, HRA at half of basic. Add components to replace that with the company’s own structure." />
        </div>
      ) : (
        <>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Component</th><th>Code</th><th>Type</th><th>Calculation</th>
                  <th className="num">On {inr(SAMPLE)}</th><th>Taxable</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {components.map((c) => {
                  const line = check.lines.find((l) => l.code === c.code);
                  return (
                    <tr key={c.code} style={c.active ? undefined : { opacity: 0.55 }}>
                      <td><b>{c.name}</b></td>
                      <td className="mono">{c.code}</td>
                      <td><Badge kind={COMP_KIND_TONE[c.kind]}>{COMP_KIND_LABEL[c.kind]}</Badge></td>
                      <td>{basisOf(c)}</td>
                      <td className="num">{line ? inr(line.annual) : '—'}</td>
                      <td>{c.taxable ? 'Yes' : 'No'}</td>
                      <td>{c.active ? 'Active' : 'Inactive'}</td>
                      <td className="nowrap" style={{ textAlign: 'right' }}>
                        <button className="btn sm" onClick={() => edit(c)}>Edit</button>{' '}
                        <button className="btn sm" onClick={() => drop(c)}>Remove</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>

          <div style={{ padding: '10px 16px' }}>
            {check.balances ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Earnings and employer costs come to <b>{inr(check.counted)}</b> on a
                CTC of {inr(SAMPLE)} — the formula reconciles, so a compensation can
                be saved against it.
              </div>
            ) : (
              <Banner kind="warn" title="The formula does not reconcile">
                Earnings and employer costs come to {inr(check.counted)} against a CTC
                of {inr(SAMPLE)} — {inr(Math.abs(check.difference))}{' '}
                {check.difference > 0 ? 'more' : 'short'}. Saving a compensation will be
                refused until they add up. Nothing is rounded to close the gap, because
                a payslip that quietly disagrees with an offer letter is worse than one
                that will not save.
              </Banner>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export function PayConfigTab() {
  const { data: comp = [] } = useCompensation();
  const everyone = comp.map((c) => c.employee);
  const grades = Object.keys(GRADES) as (keyof typeof GRADES)[];

  return (
    <div className="stack">
      <SalaryComponentsCard />

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
                  const es = everyone.filter((e) => e.grade === g);
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

/**
 * The department editor.
 *
 * The code is the department's identity — every employee, job title and
 * requisition joins on it — so it is set once and locked afterwards. Renaming
 * is what the name field is for.
 */
function DeptForm({ initial, people, lockCode, onChange }: {
  initial: DepartmentDraft;
  people: { id: string; name: string }[];
  lockCode: boolean;
  onChange: (v: DepartmentDraft) => void;
}) {
  const [v, setV] = useState<DepartmentDraft>(initial);
  const set = (patch: Partial<DepartmentDraft>) => {
    const next = { ...v, ...patch };
    setV(next);
    onChange(next);
  };

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="dept-code">Code</label>
        <input id="dept-code" className="input" value={v.code} disabled={lockCode}
          maxLength={12} placeholder="ENG"
          onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          {lockCode
            ? 'The code is what every employee and job title joins on, so it cannot change.'
            : '2–12 characters: letters, digits, hyphen or underscore. It cannot be changed later.'}
        </div>
      </div>
      <div className="field">
        <label htmlFor="dept-name">Name</label>
        <input id="dept-name" className="input" value={v.name}
          placeholder="Engineering"
          onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="dept-head">Head of department</label>
        <select id="dept-head" className="input" value={v.headId ?? ''}
          onChange={(e) => set({ headId: e.target.value || null })}>
          <option value="">Nobody yet</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
    </div>
  );
}

export function OrgTab() {
  const app = useApp();
  const layer = useLayer();
  const { data: everyone = [] } = useAllEmployees();
  const { data: sites = [] } = useSites();
  const { data: reqs = [] } = useRequisitions();
  const { data: sheets = [] } = useTimesheetsAll(everyone.map((e) => e.id));
  const { data: depts = [], loading: deptsLoading, refetch: refetchDepts } = useDepartments();
  const createDept = useCreateDepartment();
  const updateDept = useUpdateDepartment();
  const removeDept = useRemoveDepartment();
  const dir = useVisiblePeople();

  const editDept = (existing?: Department) => {
    let draft: DepartmentDraft = {
      code: existing?.code ?? '', name: existing?.name ?? '',
      colour: existing?.colour ?? null, headId: existing?.headId ?? null,
    };
    layer.modal({
      title: existing ? `Edit ${existing.name}` : 'Add a department',
      size: 'narrow',
      body: (
        <DeptForm initial={draft} people={everyone} lockCode={Boolean(existing)}
          onChange={(v) => { draft = v; }} />
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            try {
              if (existing) await updateDept.mutate(existing.code, draft);
              else await createDept.mutate(draft);
              close();
              refetchDepts();
              app.toast(existing ? 'Department updated' : 'Department added', 'ok');
            } catch (e) {
              app.toast(e instanceof Error ? e.message : 'Could not save the department', 'err');
            }
          }}>{existing ? 'Save' : 'Add'}</button>
        </>
      ),
    });
  };

  /*
   * Removal is refused by the server whenever anything still points at the
   * department, and the refusal names what. So this does not try to predict
   * it — it asks, and shows what comes back.
   */
  const delDept = (d: Department) => layer.modal({
    title: `Remove ${d.name}?`,
    size: 'narrow',
    body: (
      <div className="stack">
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          A department can only be removed when nothing references it — no
          employees, job titles, requisitions or history. If anything does, the
          server will say what, and deactivating it is the right move instead:
          the department stops being offered and its history stays readable.
        </div>
        {d.headcount > 0 && (
          <Banner kind="warn" icon={<Icon n="warn" size="lg" />}>
            {d.headcount} {d.headcount === 1 ? 'person is' : 'people are'} in this department.
          </Banner>
        )}
      </div>
    ),
    footer: (close) => (
      <>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn" onClick={async () => {
          try {
            await updateDept.mutate(d.code, { active: false });
            close();
            refetchDepts();
            app.toast(`${d.name} deactivated`, 'ok');
          } catch (e) {
            app.toast(e instanceof Error ? e.message : 'Could not deactivate', 'err');
          }
        }}>Deactivate instead</button>
        <button className="btn danger" onClick={async () => {
          try {
            await removeDept.mutate(d.code);
            close();
            refetchDepts();
            app.toast(`${d.name} removed`, 'ok');
          } catch (e) {
            app.toast(e instanceof Error ? e.message : 'Could not remove the department', 'err');
          }
        }}>Remove</button>
      </>
    ),
  });

  return (
    <div className="stack">
      <div className="grid g2">
        <Card
          title="Departments"
          sub={depts.length ? `${depts.length} configured` : 'None configured'}
          actions={app.role === 'admin' && (
            <button className="btn sm" onClick={() => editDept()}>
              <Icon n="add" size="lg" /> Add
            </button>
          )}
          flush
        >
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Department</th><th>Head</th><th className="num">Headcount</th>
                  <th className="num">Annual cost</th><th className="num">Open roles</th>
                  {app.role === 'admin' && <th className="right">&nbsp;</th>}
                </tr>
              </thead>
              <tbody>
                {depts.map((d) => (
                  <tr key={d.code}>
                    <td>
                      <Dot color={d.colour ?? 'var(--s1)'} /> <b>{d.name}</b>
                      {!d.active && <> <Badge kind="mute">Inactive</Badge></>}
                    </td>
                    <td className="nowrap">{d.headName || dir.name(d.headId)}</td>
                    <td className="num">{d.headcount}</td>
                    <td className="num">{lakh(sum(everyone.filter((e) => e.dept === d.code), (e) => e.ctc))}</td>
                    <td className="num">{sum(reqs.filter((r) => r.dept === d.code && r.status === 'Open'), (r) => r.openings - r.filled)}</td>
                    {app.role === 'admin' && (
                      <td className="right nowrap">
                        <button className="btn sm ghost" onClick={() => editDept(d)}>Edit</button>{' '}
                        <button className="btn sm ghost" onClick={() => delDept(d)}>Remove</button>
                      </td>
                    )}
                  </tr>
                ))}
                {!depts.length && (
                  <tr><td colSpan={app.role === 'admin' ? 6 : 5}>
                    <EmptyState
                      msg={deptsLoading ? 'Loading departments…' : 'No departments configured yet'}
                      icon={<Icon n="building" size="lg" />}
                    />
                  </td></tr>
                )}
              </tbody>
            </Table>
          </TableWrap>
        </Card>

        <Card title="Locations" sub={`${sites.length} configured`} flush>
          <TableWrap>
            <Table>
              <thead>
                <tr><th>Location</th><th>City</th><th className="num">Headcount</th><th>Shift</th><th className="num">PT / month</th></tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    <td>{s.city}</td>
                    <td className="num">{everyone.filter((e) => e.site === s.id).length}</td>
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
                const ts = sheets.filter((t) => t.entries.some((e) => e.proj === p.id));
                return (
                  <tr key={p.id}>
                    <td><Dot color={p.color} /> <b>{p.name}</b></td>
                    <td>{p.client}</td>
                    <td><Badge kind={p.billable ? 'good' : 'mute'}>{p.billable ? 'Billable' : 'Internal'}</Badge></td>
                    <td className="num">{sum(ts, (t) => sum(t.entries.filter((e) => e.proj === p.id), (e) => e.hours))}</td>
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
  const { data: everyone = [] } = useAllEmployees();
  /* "Live system counts" said Departments from a constant. It counts them now. */
  const { data: depts = [] } = useDepartments();
  const { data: sites = [] } = useSites();
  const { data: runs = [] } = usePayRuns();
  const { data: reqs = [] } = useRequisitions();
  const { data: cands = [] } = useCandidates();
  const ids = everyone.map((e) => e.id);
  const { data: attendance = [] } = useAttendanceAll(ids);
  const { data: sheets = [] } = useTimesheetsAll(ids);
  const { data: leave = [] } = useLeaveAll(ids);
  return (
    <div className="grid g-2-1">
      <Card
        title="Company profile"
        sub="Used on payslips, offer letters and statutory filings"
        actions={<button className="btn sm primary"
          {...notBacked('the company profile is not editable from here yet — these fields read the configured entity')}
        >Save</button>}
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
            <img src={LOGO_LIGHT} alt={ORG.name} style={{ height: 66, width: 'auto' }} />
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
              ['Active employees', everyone.length],
              ['Departments', depts.length],
              ['Locations', `${sites.filter((s) => !s.remote).length} offices + remote`],
              ['Attendance records', attendance.length.toLocaleString('en-IN')],
              ['Timesheets', sheets.length.toLocaleString('en-IN')],
              ['Leave requests', leave.length.toLocaleString('en-IN')],
              ['Payroll cycles', runs.length],
              ['Open requisitions', reqs.filter((r) => r.status === 'Open').length],
              ['Candidates', cands.length],
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

/**
 * The audit log tab.
 *
 * It used to build its own rows from a constant — eight invented actions with
 * invented IP addresses, attributed to named colleagues — while `security.audit()`
 * had been live the whole time and the Security module was already reading it.
 * An administrator looking at a fabricated audit trail is worse served than one
 * looking at none, so this renders the real one rather than a second opinion.
 */
export const ConfigAuditTab = AuditTab;

