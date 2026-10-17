/**
 * Software assets.
 *
 * The register exists to answer two questions the asset list cannot: what is
 * renewing, and what are we paying for that nobody opens. Both are derived
 * from seats rather than recorded, so neither can be quietly wrong — the
 * dormant figure moves when somebody uses the tool, not when somebody
 * remembers to update a field.
 *
 * An employee sees only the seats they hold. That is not a filtered version of
 * the estate; the cost of the contract and who else is on it are not theirs,
 * so it is a different screen.
 */

import { useState } from 'react';
import { sortBy, uniq } from '../../lib/collections';
import { fmtD } from '../../lib/dates';
import { inr } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { deptOf } from '../../data/org';
import { DORMANT_DAYS, RENEWAL_WINDOW, SOFTWARE_CATS } from '../../services';
import type {
  SoftwareCat, SoftwareDetail, SoftwareDraft, SoftwareFilter, SoftwareRow, SoftwareStatus,
} from '../../services';
import { Avatar, Badge, Banner, Card, EmptyState, KV, StatRow, Tabs, Tile } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useAssignSeat, useCreateSoftware, useMySoftware, useRemoveSoftware, useRenewals,
  useRevokeSeat, useSoftware, useSoftwareProduct, useSoftwareStats, useUpdateSoftware,
  useVisiblePeople,
} from './data';

type Tab = 'estate' | 'renewals' | 'dormant';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const STATUS_TONE: Record<SoftwareStatus, 'good' | 'warn' | 'mute'> = {
  Active: 'good', Trial: 'warn', Cancelled: 'mute',
};

/** Overdue reads differently from due, so it gets its own tone rather than a minus sign. */
function RenewsIn({ days }: { days: number }) {
  if (days < 0) return <Badge kind="crit">{-days}d overdue</Badge>;
  if (days <= 30) return <Badge kind="warn">in {days}d</Badge>;
  if (days <= RENEWAL_WINDOW) return <Badge kind="info">in {days}d</Badge>;
  return <span className="muted">in {days}d</span>;
}

/* ---------------- the form ---------------- */

function ProductForm({ existing, close }: { existing?: SoftwareDetail; close: () => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const create = useCreateSoftware();
  const update = useUpdateSoftware();
  const p = existing?.product;

  const [d, setD] = useState<SoftwareDraft>({
    n: p?.n ?? '',
    vendor: p?.vendor ?? '',
    cat: p?.cat ?? 'Productivity',
    plan: p?.plan ?? '',
    seats: p?.seats ?? 0,
    unitCost: p?.unitCost ?? 0,
    billing: p?.billing ?? 'Annual',
    renewsOn: p?.renewsOn ?? '',
    ownerId: p?.ownerId ?? null,
    status: p?.status ?? 'Active',
    sso: p?.sso ?? false,
    holdsPersonalData: p?.holdsPersonalData ?? false,
    notes: p?.notes ?? '',
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof SoftwareDraft>(k: K, v: SoftwareDraft[K]) => setD({ ...d, [k]: v });

  const save = async () => {
    setErr('');
    try {
      if (p) await update.mutate(p.id, d);
      else await create.mutate(d);
      app.toast(p ? 'Software updated' : 'Software added', 'ok');
      close();
    } catch (e) { setErr(msg(e, 'Could not save')); }
  };

  const yearly = (d.seats || 0) * (d.unitCost || 0);

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not saved">{err}</Banner>}

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 2 }}>
          <label>Product <span className="req">*</span></label>
          <input className="input" value={d.n} autoFocus placeholder="Figma Organisation"
            onChange={(e) => set('n', e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Vendor <span className="req">*</span></label>
          <input className="input" value={d.vendor} placeholder="Figma"
            onChange={(e) => set('vendor', e.target.value)} />
        </div>
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Category <span className="req">*</span></label>
          <select className="input" value={d.cat}
            onChange={(e) => set('cat', e.target.value as SoftwareCat)}>
            {SOFTWARE_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Plan</label>
          <input className="input" value={d.plan ?? ''} placeholder="Business"
            onChange={(e) => set('plan', e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Status</label>
          <select className="input" value={d.status}
            onChange={(e) => set('status', e.target.value as SoftwareStatus)}>
            {(['Active', 'Trial', 'Cancelled'] as const).map((sv) => (
              <option key={sv} value={sv}>{sv}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Seats purchased <span className="req">*</span></label>
          <input className="input" type="number" min={0} value={d.seats}
            onChange={(e) => set('seats', Number(e.target.value))} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Cost per seat, a year <span className="req">*</span></label>
          <input className="input" type="number" min={0} value={d.unitCost}
            onChange={(e) => set('unitCost', Number(e.target.value))} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Billed</label>
          <select className="input" value={d.billing}
            onChange={(e) => set('billing', e.target.value as 'Annual' | 'Monthly')}>
            <option value="Annual">Annually</option>
            <option value="Monthly">Monthly</option>
          </select>
        </div>
      </div>

      {yearly > 0 && (
        <Banner kind="info" icon={<Icon n="money" size="lg" />} title="Annual commitment">
          {inr(yearly)} a year at {d.seats} seats. The figure is per seat per year whichever
          way it is billed, so a monthly plan still totals the same.
        </Banner>
      )}

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Renews on <span className="req">*</span></label>
          <input className="input" type="date" value={d.renewsOn}
            onChange={(e) => set('renewsOn', e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Business owner</label>
          <select className="input" value={d.ownerId ?? ''}
            onChange={(e) => set('ownerId', e.target.value || null)}>
            <option value="">Nobody named</option>
            {sortBy(dir.list, (e) => e.name).map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={d.sso}
            onChange={(e) => set('sso', e.target.checked)} />
          <span>Sign-in goes through the company identity provider</span>
        </label>
        <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6 }}>
          <input type="checkbox" checked={d.holdsPersonalData}
            onChange={(e) => set('holdsPersonalData', e.target.checked)} />
          <span>The vendor holds employee personal data</span>
        </label>
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea className="input" rows={2} value={d.notes ?? ''}
          onChange={(e) => set('notes', e.target.value)} />
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={create.pending || update.pending} onClick={save}>
          {p ? 'Save changes' : 'Add software'}
        </button>
      </div>
    </div>
  );
}

function AssignSeatForm({ productId, close }: { productId: string; close: () => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const assign = useAssignSeat();
  const [empId, setEmpId] = useState('');
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    try { await assign.mutate(productId, empId); app.toast('Seat assigned', 'ok'); close(); }
    catch (e) { setErr(msg(e, 'Could not assign the seat')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not assigned">{err}</Banner>}
      <div className="field">
        <label>Who gets the seat <span className="req">*</span></label>
        <select className="input" value={empId} autoFocus onChange={(e) => setEmpId(e.target.value)}>
          <option value="">Choose somebody</option>
          {sortBy(dir.list, (e) => e.name).map((e) => (
            <option key={e.id} value={e.id}>{e.name} · {deptOf(e.dept).name}</option>
          ))}
        </select>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!empId || assign.pending} onClick={save}>
          Assign seat
        </button>
      </div>
    </div>
  );
}

/* ---------------- the detail ---------------- */

function ProductDetail({ id }: { id: string }) {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const { data: d, loading, error } = useSoftwareProduct(id);
  const revoke = useRevokeSeat();
  const remove = useRemoveSoftware();
  const [tab, setTab] = useState<'overview' | 'seats' | 'history'>('overview');

  if (error) return <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />;
  if (!d) return <EmptyState msg={loading ? 'Loading…' : 'No such product'} />;

  const p = d.product;
  const act = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); app.toast(done, 'ok'); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  return (
    <div className="stack">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Badge kind={STATUS_TONE[p.status]}>{p.status}</Badge>
        <Badge kind="mute">{p.cat}</Badge>
        {!p.sso && <Badge kind="warn">No single sign-on</Badge>}
        {p.holdsPersonalData && <Badge kind="info">Holds personal data</Badge>}
        {d.overAllocated && <Badge kind="crit">More holders than seats</Badge>}
      </div>

      {d.overAllocated && (
        <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Over-allocated">
          {d.assigned} people hold a seat and {p.seats} are paid for. Either buy the
          difference or revoke {d.assigned - p.seats} seat(s) — a vendor audit would
          bill for the gap.
        </Banner>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'overview' as const, label: 'Overview' },
          { v: 'seats' as const, label: `Seats (${d.assigned})` },
          { v: 'history' as const, label: 'History' },
        ]}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <>
          <KV rows={[
            ['Vendor', p.vendor],
            ['Plan', p.plan || '—'],
            ['Seats purchased', p.seats],
            ['Seats assigned', d.assigned],
            ['Seats free', d.free],
            ['Dormant seats', d.dormant ? `${d.dormant} · unopened for ${DORMANT_DAYS}+ days` : 'None'],
            ['Cost per seat', `${inr(p.unitCost)} a year`],
            ['Annual commitment', inr(d.annualCost)],
            ['Idle spend', d.wastedCost ? inr(d.wastedCost) + ' a year' : '—'],
            ['Billed', p.billing === 'Annual' ? 'Annually' : 'Monthly'],
            ['Renews on', <>{fmtD(p.renewsOn)} · <RenewsIn days={d.renewsInDays} /></>],
            ['Business owner', p.ownerId ? dir.name(p.ownerId) : '—'],
            ['Single sign-on', p.sso ? 'Enforced' : 'Not enforced'],
          ]} />
          {p.notes && <Card title="Notes"><p className="muted">{p.notes}</p></Card>}
          {app.role === 'admin' && (
            <div className="row" style={{ gap: 9, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => layer.modal({
                title: 'Edit software',
                sub: p.n,
                body: (close) => <ProductForm existing={d} close={close} />,
                footer: null,
              })}>
                <Icon n="tool" size="lg" /> Edit
              </button>
              <button className="btn danger" disabled={d.assigned > 0}
                title={d.assigned ? 'Revoke every seat first' : undefined}
                onClick={() => act(() => remove.mutate(p.id), `${p.n} removed`)}>
                <Icon n="remove" size="lg" /> Remove
              </button>
            </div>
          )}
        </>
      )}

      {tab === 'seats' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {d.assigned} of {p.seats} seats · {d.free} free
            </span>
            {app.role === 'admin' && (
              <button className="btn sm" onClick={() => layer.modal({
                title: 'Assign a seat',
                sub: p.n,
                size: 'narrow',
                body: (close) => <AssignSeatForm productId={p.id} close={close} />,
                footer: null,
              })}>
                <Icon n="add" size="lg" /> Assign seat
              </button>
            )}
          </div>
          {d.seats.length ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Person</th><th>Department</th><th>Assigned</th>
                    <th>Last opened</th><th />
                  </tr>
                </thead>
                <tbody>
                  {d.seats.map((s) => (
                    <tr key={s.seat.id}>
                      <td>
                        <div className="row" style={{ gap: 9, alignItems: 'center' }}>
                          <Avatar name={s.name} />
                          <span style={{ fontWeight: 650, fontSize: 13 }}>{s.name}</span>
                        </div>
                      </td>
                      <td className="nowrap">{s.dept ? deptOf(s.dept).name : '—'}</td>
                      <td className="nowrap">{fmtD(s.seat.assignedOn)}</td>
                      <td className="nowrap">
                        {s.seat.lastUsedOn
                          ? <>{fmtD(s.seat.lastUsedOn)}{s.dormant && <> <Badge kind="warn">{s.daysIdle}d idle</Badge></>}</>
                          : <Badge kind="crit">Never opened</Badge>}
                      </td>
                      <td className="num">
                        {app.role !== 'employee' && (
                          <button className="btn ghost icon sm" aria-label={`Revoke ${s.name}`}
                            onClick={() => act(() => revoke.mutate(s.seat.id),
                              `Seat revoked from ${s.name}`)}>
                            <Icon n="remove" size="sm" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Icon n="people" size="xl" />}
              msg="Nobody holds a seat — the whole subscription is idle spend" />
          )}
        </>
      )}

      {tab === 'history' && (
        d.history.length ? (
          <div className="tl"><div className="tl-day">
            {d.history.map((h) => (
              <div className="tl-row" key={h.id}>
                <div className="tl-time mono">{h.at.slice(5, 10)}</div>
                <div className="tl-mark" aria-hidden="true">
                  <i style={{ background: 'var(--brand)' }} />
                </div>
                <div className="tl-body">
                  <div className="tl-k">{h.action.replace('software.', '').replace(/_/g, ' ')}</div>
                  <div className="tl-s">{h.summary}</div>
                  <div className="tl-who muted">{h.actorLabel}</div>
                </div>
              </div>
            ))}
          </div></div>
        ) : (
          <EmptyState icon={<Icon n="clock" size="xl" />}
            msg="Nothing has changed since the register was opened" />
        )
      )}
    </div>
  );
}

/* ---------------- an employee's own view ---------------- */

function MySoftware() {
  const { data: rows = [], loading } = useMySoftware();
  return (
    <Card title="Your software" sub="The seats assigned to you">
      {rows.length ? (
        <div className="stack">
          {rows.map((r) => (
            <div key={r.seat.id} className="lc-task">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="lc-task-n">{r.product.n}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {r.product.vendor} · {r.product.plan || r.product.cat}
                  {' · since '}{fmtD(r.seat.assignedOn)}
                </div>
              </div>
              {r.dormant && <Badge kind="warn">Unused</Badge>}
            </div>
          ))}
          <Banner kind="info" icon={<Icon n="info" size="lg" />} title="Not using one of these?">
            Tell IT and they will take the seat back. Each unused seat is money the
            company keeps paying, and there is no penalty for handing one in.
          </Banner>
        </div>
      ) : (
        <EmptyState icon={<Icon n="laptop" size="xl" />}
          msg={loading ? 'Loading…' : 'No software is assigned to you'} />
      )}
    </Card>
  );
}

/* ---------------- the page ---------------- */

function SoftwareView() {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const [tab, setTab] = useTabFromUrl<Tab>('estate', ['estate', 'renewals', 'dormant']);
  const [f, setF] = useState<SoftwareFilter>({});

  const scoped: SoftwareFilter = tab === 'dormant' ? { ...f, hasDormant: true } : f;
  const { data: rows = [], loading, error } = useSoftware(scoped);
  const { data: all = [] } = useSoftware({});
  const { data: stats } = useSoftwareStats();
  const { data: renewals = [] } = useRenewals(RENEWAL_WINDOW);

  if (app.role === 'employee') return <MySoftware />;
  if (error) {
    return (
      <Card title="Software assets">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const openDetail = (r: SoftwareRow) => layer.drawer({
    title: r.product.n,
    sub: `${r.product.vendor} · ${r.assigned} of ${r.product.seats} seats`,
    body: <ProductDetail id={r.product.id} />,
  });

  const exportCsv = () => downloadCSV('software_estate.csv', [
    ['Product', 'Vendor', 'Category', 'Plan', 'Status', 'Seats purchased',
      'Seats assigned', 'Seats free', 'Dormant seats', 'Cost per seat',
      'Annual cost', 'Idle spend', 'Renews on', 'Owner', 'SSO'],
    ...rows.map((r) => [
      r.product.n, r.product.vendor, r.product.cat, r.product.plan, r.product.status,
      r.product.seats, r.assigned, r.free, r.dormant, r.product.unitCost,
      r.annualCost, r.wastedCost, r.product.renewsOn,
      r.product.ownerId ? dir.name(r.product.ownerId) : '—',
      r.product.sso ? 'Yes' : 'No',
    ]),
  ]);

  const one = (k: keyof SoftwareFilter) => (v: string) => setF({ ...f, [k]: v || undefined });

  const table = (
    <Card
      title={tab === 'dormant' ? 'Where the money is going' : 'The estate'}
      sub={tab === 'dormant'
        ? 'Products with seats nobody has opened — most expensive first'
        : `${rows.length} of ${all.length} · most expensive first`}
      flush
    >
      {rows.length ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th><th>Category</th><th className="num">Seats</th>
                <th className="num">Assigned</th><th className="num">Dormant</th>
                <th className="num">A year</th><th className="num">Idle spend</th>
                <th>Renews</th><th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.product.id} className="clickable" onClick={() => openDetail(r)}>
                  <td>
                    <div style={{ fontWeight: 650, fontSize: 13 }}>{r.product.n}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {r.product.vendor}
                      {r.product.status !== 'Active' && <> · {r.product.status}</>}
                      {!r.product.sso && <> · no SSO</>}
                    </div>
                  </td>
                  <td className="nowrap">{r.product.cat}</td>
                  <td className="num">{r.product.seats}</td>
                  <td className="num">
                    {r.assigned}
                    {r.overAllocated && <> <Badge kind="crit">over</Badge></>}
                  </td>
                  <td className="num">{r.dormant || '—'}</td>
                  <td className="num money">{inr(r.annualCost)}</td>
                  <td className="num money">{r.wastedCost ? inr(r.wastedCost) : '—'}</td>
                  <td className="nowrap"><RenewsIn days={r.renewsInDays} /></td>
                  <td className="nowrap">
                    {r.product.ownerId ? dir.name(r.product.ownerId) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<Icon n="laptop" size="xl" />}
          msg={loading
            ? 'Loading the register…'
            : tab === 'dormant'
              ? 'Every paid seat is in use — nothing to reclaim'
              : 'No software matches this filter'}
        />
      )}
    </Card>
  );

  return (
    <div className="stack">
      {app.role === 'admin' && (
        <PageActions>
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>
            <Icon n="download" size="lg" /> Export
          </button>
          <button className="btn primary" onClick={() => layer.modal({
            title: 'Add software',
            body: (close) => <ProductForm close={close} />,
            footer: null,
          })}>
            <Icon n="add" size="lg" /> Add software
          </button>
        </PageActions>
      )}

      <StatRow cols={5}>
        <Tile icon={<Icon n="money" size="lg" />} label="Annual spend"
          value={stats ? inr(stats.annualSpend) : '—'}
          foot={stats ? `${stats.products} products` : ''} />
        <Tile icon={<Icon n="people" size="lg" />} label="Seats"
          value={stats ? `${stats.seatsAssigned} / ${stats.seatsPurchased}` : '—'}
          foot="Assigned of purchased" />
        <Tile icon={<Icon n="warn" size="lg" />} label="Idle spend"
          value={stats ? inr(stats.wastedSpend) : '—'}
          foot={stats ? `${stats.dormantSeats} dormant seats` : ''} />
        <Tile icon={<Icon n="clock" size="lg" />} label="Renewing"
          value={stats?.renewingSoon ?? '—'}
          foot={`Within ${RENEWAL_WINDOW} days`} />
        <Tile icon={<Icon n="lock" size="lg" />} label="Without SSO"
          value={stats?.noSso ?? '—'} foot="Sign-in outside the IdP" />
      </StatRow>

      {stats && stats.overdue > 0 && (
        <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Renewal dates have passed">
          {stats.overdue} product(s) renewed without anybody recording a decision.
          Either the date is stale or the company auto-renewed — both are worth knowing.
        </Banner>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'estate' as const, label: 'Estate' },
          { v: 'renewals' as const, label: `Renewals (${renewals.length})` },
          { v: 'dormant' as const, label: 'Idle seats' },
        ]}
        onChange={setTab}
      />

      {tab !== 'renewals' && (
        <div className="toolbar">
          <div className="gsearch" style={{ width: 230, flex: '0 0 auto' }}>
            <span className="gsearch-ic" aria-hidden="true"><Icon n="search" /></span>
            <input className="gsearch-in" type="search" value={f.q ?? ''}
              placeholder="Product or vendor…" aria-label="Search software"
              onChange={(e) => one('q')(e.target.value)} />
          </div>
          <select className="input sm" value={f.cat ?? ''} aria-label="Category"
            onChange={(e) => one('cat')(e.target.value)}>
            <option value="">All categories</option>
            {SOFTWARE_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input sm" value={f.vendor ?? ''} aria-label="Vendor"
            onChange={(e) => one('vendor')(e.target.value)}>
            <option value="">All vendors</option>
            {sortBy(uniq(all.map((r) => r.product.vendor))).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <select className="input sm" value={f.status ?? ''} aria-label="Status"
            onChange={(e) => one('status')(e.target.value)}>
            <option value="">All statuses</option>
            {(['Active', 'Trial', 'Cancelled'] as const).map((sv) => (
              <option key={sv} value={sv}>{sv}</option>
            ))}
          </select>
          <div className="spacer" />
          {Object.values(f).some((v) => v != null && v !== '') && (
            <button className="btn sm" onClick={() => setF({})}>Reset</button>
          )}
        </div>
      )}

      {tab === 'renewals' ? (
        <Card title="What renews next"
          sub={`The next ${RENEWAL_WINDOW} days, soonest first`} flush>
          {renewals.length ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Renews</th><th>Product</th><th>Vendor</th>
                    <th className="num">Seats</th><th className="num">Commitment</th>
                    <th>Owner</th><th>Decide by</th>
                  </tr>
                </thead>
                <tbody>
                  {renewals.map(({ product: p, inDays }) => {
                    const row = all.find((r) => r.product.id === p.id);
                    return (
                      <tr key={p.id} className="clickable"
                        onClick={() => row && openDetail(row)}>
                        <td className="nowrap">{fmtD(p.renewsOn)}</td>
                        <td style={{ fontWeight: 650 }}>{p.n}</td>
                        <td className="nowrap">{p.vendor}</td>
                        <td className="num">{p.seats}</td>
                        <td className="num money">{inr(p.seats * p.unitCost)}</td>
                        <td className="nowrap">{p.ownerId ? dir.name(p.ownerId) : '—'}</td>
                        <td><RenewsIn days={inDays} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Icon n="clock" size="xl" />}
              msg={`Nothing renews in the next ${RENEWAL_WINDOW} days`} />
          )}
        </Card>
      ) : table}
    </div>
  );
}

registerModule({
  key: 'software',
  title: TITLES.software,
  Component: SoftwareView,
});

export { SoftwareView };
