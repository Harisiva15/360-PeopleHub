import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { fmtD, TODAY, ymd } from '../../lib/dates';
import { inr, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { mbS } from '../../data/countries';

import type { Asset } from '../../types/asset';
import {
  ASSET_CATS, ASSET_STATUS_BADGE, acatOf, assetEol, bookValue, inWarranty,
} from '../../data/assets';
import { entitledTo } from '../../data/assetWorkflow';



import { deptOf, siteOf } from '../../data/org';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { HBar } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useAddAsset, useAllEmployees, useAllocateAsset, useAssetKpi, useAssets, useExits,
  useMarkReturned, useOnboardingJourneys, usePendingRecovery, useVisiblePeople,
} from './data';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const AssetBadge = ({ s }: { s: string }) => (
  <Badge kind={(ASSET_STATUS_BADGE[s] || 'mute') as 'good' | 'info' | 'warn' | 'crit' | 'mute'}>{s}</Badge>
);

/* ---------------- My assets (employee) ---------------- */

function AsMine() {
  const { data: ASSETS = [] } = useAssets();
  const app = useApp();
  const mine = ASSETS.filter((a) => a.empId === app.meId);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Assets issued to me" value={mine.length} foot={`Across ${uniq(mine.map((a) => a.cat)).length} categories`} />
        <Tile label="Book value held" value={mbS(sum(mine, bookValue))} foot={`Written down from ${mbS(sum(mine, (a) => a.cost!))}`} />
        <Tile label="Out of warranty" value={mine.filter((a) => !inWarranty(a)).length} foot="Raise a helpdesk ticket for issues" />
        <Tile label="Due for refresh" value={mine.filter(assetEol).length} foot="Past the standard refresh cycle" />
      </div>

      <Card title="My assets" sub="You are accountable for these until they are returned to IT" flush>
        {mine.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Asset</th><th>Tag</th><th>Serial</th><th>Issued</th><th>Warranty</th><th>Condition</th><th>Status</th></tr>
              </thead>
              <tbody>
                {mine.map((a) => (
                  <tr key={a.id}>
                    <td><b>{a.type}</b><div className="mt">{acatOf(a.cat).n}</div></td>
                    <td className="mono">{a.tag}</td>
                    <td className="mono">{a.serial}</td>
                    <td className="nowrap">{fmtD(a.issued)}</td>
                    <td className="nowrap">{inWarranty(a) ? fmtD(a.warrantyEnd) : <Badge kind="warn">Expired</Badge>}</td>
                    <td>{a.condition}</td>
                    <td><AssetBadge s={a.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="No assets issued to you" icon="💻" />}
      </Card>

      <Banner kind="info" icon="ℹ">
        Assets must be returned to IT on or before your last working day. Anything outstanding is recovered through the
        full and final settlement at written-down value.
      </Banner>
    </div>
  );
}

/* ---------------- Register ---------------- */

/**
 * Add an item to the register.
 *
 * The holder is optional and defaults to nobody, because kit is bought both
 * ways: sometimes for a named person, sometimes into stock. Assigning here
 * saves the second step and records the same custody row either way.
 */
function AddAssetForm({ close }: { close: () => void }) {
  const app = useApp();
  const addAsset = useAddAsset();
  const { data: everyone = [] } = useAllEmployees();
  const [d, setD] = useState({
    cat: 'LAPTOP', type: '', serial: '', tag: '', cost: '',
    purchased: ymd(TODAY), warrantyEnd: '', vendor: '', empId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof d, v: string) => setD((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!d.type.trim()) return setError('Say which item this is');
    setBusy(true);
    setError(null);
    try {
      await addAsset.mutate({
        cat: d.cat,
        type: d.type.trim(),
        ...(d.serial ? { serial: d.serial } : {}),
        ...(d.tag ? { tag: d.tag } : {}),
        ...(d.cost ? { cost: Number(d.cost) } : {}),
        ...(d.purchased ? { purchased: d.purchased } : {}),
        ...(d.warrantyEnd ? { warrantyEnd: d.warrantyEnd } : {}),
        ...(d.vendor ? { vendor: d.vendor } : {}),
        ...(d.empId ? { empId: d.empId } : {}),
      });
      app.toast(d.empId ? `${d.type} added and issued` : `${d.type} added to stock`, 'ok');
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add this item');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid g2" style={{ gap: '0 14px' }}>
        <div className="field">
          <label htmlFor="a-cat">Category</label>
          <select id="a-cat" className="input" value={d.cat} onChange={(e) => set('cat', e.target.value)}>
            {ASSET_CATS.map((c) => <option key={c.id} value={c.id}>{c.n}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="a-type">Item</label>
          <input id="a-type" className="input" autoFocus placeholder='MacBook Pro 14"'
            value={d.type} onChange={(e) => set('type', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-serial">Serial number</label>
          <input id="a-serial" className="input" value={d.serial} onChange={(e) => set('serial', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-tag">Asset tag</label>
          <input id="a-tag" className="input" placeholder="Leave blank to generate"
            value={d.tag} onChange={(e) => set('tag', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-cost">Cost</label>
          <input id="a-cost" type="number" className="input" value={d.cost} onChange={(e) => set('cost', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-vendor">Vendor</label>
          <input id="a-vendor" className="input" value={d.vendor} onChange={(e) => set('vendor', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-purch">Purchased on</label>
          <input id="a-purch" type="date" className="input" value={d.purchased} onChange={(e) => set('purchased', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-warr">Warranty ends</label>
          <input id="a-warr" type="date" className="input" value={d.warrantyEnd} onChange={(e) => set('warrantyEnd', e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="a-emp">Issue to</label>
        <select id="a-emp" className="input" value={d.empId} onChange={(e) => set('empId', e.target.value)}>
          <option value="">Nobody — add to stock</option>
          {sortBy(everyone, (e) => e.name).map((e) => (
            <option key={e.id} value={e.id}>{e.name} · {e.code}</option>
          ))}
        </select>
        <div className="hint">Issuing here records the same custody entry as issuing it later.</div>
      </div>

      {error && <div className="login-msg err" role="alert">{error}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 8 }}>
        <button className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? 'Adding…' : 'Add to register'}
        </button>
      </div>
    </>
  );
}

function AsRegister() {
  const layer = useLayer();
  const { data: ASSETS = [] } = useAssets();
  const { data: k } = useAssetKpi();
  const dir = useVisiblePeople();
  const [q, setQ] = useState('');
  const [fc, setFc] = useState('');
  const [fs, setFs] = useState('');

  /* After every hook: the register health is computed by the service. */
  if (!k) return <Card><EmptyState msg="Loading the asset register…" icon="💻" /></Card>;

  let list: Asset[] = ASSETS;
  if (fc) list = list.filter((a) => a.cat === fc);
  if (fs) list = list.filter((a) => a.status === fs);
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((a) =>
      (a.type + ' ' + a.serial + ' ' + a.tag + ' ' + (a.empId ? dir.name(a.empId) : '')).toLowerCase().includes(needle),
    );
  }

  const byCat = ASSET_CATS.map((c) => ({ k: c.n, c: c.c, v: ASSETS.filter((a) => a.cat === c.id).length }));

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <input className="input" placeholder="Search asset, tag, serial or holder…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 'auto' }} value={fc} onChange={(e) => setFc(e.target.value)}>
          <option value="">All categories</option>
          {ASSET_CATS.map((c) => <option key={c.id} value={c.id}>{c.n}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={fs} onChange={(e) => setFs(e.target.value)}>
          <option value="">All statuses</option>
          {['Assigned', 'In stock', 'In repair', 'Retired'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn primary" onClick={() => layer.modal({
          title: 'Add an asset',
          sub: 'Laptops, monitors, phones and accessories',
          body: (close) => <AddAssetForm close={close} />,
          footer: null,
        })}>＋ Add asset</button>
        <button className="btn" onClick={() =>
          downloadCSV('asset_register.csv',
            [['ID', 'Tag', 'Type', 'Category', 'Serial', 'Holder', 'Location', 'Purchased', 'Cost', 'Book value', 'Warranty end', 'Condition', 'Status']].concat(
              ASSETS.map((a) => [a.id, a.tag || '', a.type, acatOf(a.cat).n, a.serial,
                a.empId ? dir.name(a.empId) : '', siteOf(a.site || 'CHN').name, a.purchased || '',
                String(a.cost ?? ''), String(bookValue(a)), a.warrantyEnd || '', a.condition || '', a.status]),
            ))}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Assets tracked" value={k.total} foot={`${k.assigned} assigned · ${k.stock} in stock`} />
        <Tile label="Gross book cost" value={mbS(k.gross)} foot="Capitalised value at purchase" />
        <Tile label="Net book value" value={mbS(k.net)} foot={`${mbS(k.dep)} depreciated to date`} />
        <Tile label="Out of warranty" value={k.outOfWarranty} foot="Assigned and unsupported" />
        <Tile label="Pending recovery" value={k.recovery} foot="Held by employees who are leaving" />
      </div>

      <Card title="Asset register" sub={`${list.length} of ${ASSETS.length} assets`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 600, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Asset</th><th>Tag</th><th>Category</th><th>Assigned to</th><th>Location</th>
                <th className="num">Cost</th><th className="num">Book value</th><th>Warranty</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 400).map((a) => (
                <tr key={a.id}>
                  <td><b>{a.type}</b><div className="mt">{a.serial}</div></td>
                  <td className="mono">{a.tag}</td>
                  <td className="nowrap">{acatOf(a.cat).n}</td>
                  <td className="nowrap">{a.empId ? dir.name(a.empId) : <span className="muted">IT stock</span>}</td>
                  <td className="nowrap">{siteOf(a.site || 'CHN').city}</td>
                  <td className="num">{inr(a.cost)}</td>
                  <td className="num">{inr(bookValue(a))}</td>
                  <td className="nowrap">
                    {inWarranty(a) ? <span className="muted">{fmtD(a.warrantyEnd)}</span> : <Badge kind="warn">Expired</Badge>}
                  </td>
                  <td><AssetBadge s={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length > 400 && (
          <div className="card-b">
            <div className="muted" style={{ fontSize: 12.5 }}>
              Showing the first 400 of {list.length} — narrow the filters or export the full register.
            </div>
          </div>
        )}
      </Card>

      <div className="grid g2">
        <Card title="Fleet by category" sub="What we own"><HBar rows={byCat} /></Card>
        <Card title="Net book value by category" sub="Written down, straight line">
          <HBar fmt={(v) => mbS(v)}
            rows={ASSET_CATS.map((c) => ({
              k: c.n, c: c.c,
              v: sum(ASSETS.filter((a) => a.cat === c.id && a.status !== 'Retired'), bookValue),
            }))} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Allocation ---------------- */

function AsAlloc() {
  const app = useApp();
  const { data: ASSETS = [] } = useAssets();
  const { data: EXITS = [] } = useExits();
  const { data: active = [] } = useAllEmployees();
  const { data: rec = [] } = usePendingRecovery();
  const dir = useVisiblePeople();
  const allocateAsset = useAllocateAsset();
  const markReturnedAsset = useMarkReturned();
  const { data: onboard = [] } = useOnboardingJourneys();
  const joiners = onboard.filter((o) => o.status !== 'Completed');

  const noLaptop = active.filter(
    (e) => !ASSETS.some((a) => a.empId === e.id && a.cat === 'LAPTOP' && a.status === 'Assigned'),
  );

  const allocate = async (empId: string) => {
    const stock = ASSETS.find((a) => a.status === 'In stock' && a.cat === 'LAPTOP');
    if (!stock) {
      app.toast('No laptops in stock — raise a purchase order first', 'err');
      return;
    }
    try {
      const issued = await allocateAsset.mutate(stock.id, empId);
      app.toast(`${issued.type} allocated to ${dir.name(empId)}`, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not allocate', 'err');
    }
  };

  const bulkAllocate = async () => {
    const stock = ASSETS.filter((a) => a.status === 'In stock' && a.cat === 'LAPTOP');
    const n = Math.min(noLaptop.length, stock.length);
    if (!n) {
      app.toast(stock.length ? 'Nobody is waiting for a laptop' : 'No laptops in stock — raise a purchase order first');
      return;
    }
    /* oldest joiner first, so the longest wait is cleared first */
    const queue = sortBy(noLaptop, (e) => e.doj).slice(0, n);
    for (let i = 0; i < queue.length; i++) {
      await allocateAsset.mutate(stock[i].id, queue[i].id);
    }
    app.toast(n + ' laptops allocated', 'ok');
  };

  const markReturned = async (a: Asset) => {
    try {
      await markReturnedAsset.mutate(a.id);
      app.toast(a.type + ' marked returned and back in stock', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not mark it returned', 'err');
    }
  };

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Employees equipped" value={`${active.length - noLaptop.length} of ${active.length}`}
          foot={pct(active.length - noLaptop.length, active.length) + '% have a company laptop'} />
        <Tile label="Awaiting allocation" value={noLaptop.length} foot="No laptop on the register" />
        <Tile label="Pending recovery" value={rec.length} foot="Held by leavers" />
        <Tile label="Value at risk" value={mbS(sum(rec, bookValue))} foot="Recoverable through F&F" />
      </div>

      <div className="grid g2">
        <Card title="Awaiting allocation" sub={`${noLaptop.length} employees without a laptop`} flush
          actions={<button className="btn sm primary" onClick={bulkAllocate}>Allocate from stock</button>}>
          {noLaptop.length ? (
            <div className="tbl-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Employee</th><th>Department</th><th>Location</th><th>Joined</th><th className="right">Action</th></tr></thead>
                <tbody>
                  {noLaptop.slice(0, 40).map((e) => (
                    <tr key={e.id}>
                      <td><PersonCell e={e} sub={e.code} /></td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td className="nowrap">{siteOf(e.site).city}</td>
                      <td className="nowrap">{fmtD(e.doj)}</td>
                      <td className="right"><button className="btn sm" onClick={() => allocate(e.id)}>Allocate</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState msg="Everyone has a laptop on the register" icon="✓" />}
        </Card>

        <Card title="Recovery worklist" sub={`${rec.length} assets held by leavers`} flush>
          {rec.length ? (
            <div className="tbl-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Asset</th><th>Held by</th><th>Last working day</th><th className="num">Book value</th><th className="right">Action</th></tr></thead>
                <tbody>
                  {rec.map((a) => {
                    const x = EXITS.find((z) => z.empId === a.empId);
                    return (
                      <tr key={a.id}>
                        <td><b>{a.type}</b><div className="mt">{a.tag}</div></td>
                        <td className="nowrap">{dir.name(a.empId)}</td>
                        <td className="nowrap">{x ? fmtD(x.lwd) : '—'}</td>
                        <td className="num">{inr(bookValue(a))}</td>
                        <td className="right"><button className="btn sm" onClick={() => markReturned(a)}>Mark returned</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <EmptyState msg="Nothing outstanding from leavers" icon="✓" />}
        </Card>
      </div>

      <Card title="Provisioning for joiners" sub={`${joiners.length} onboarding journeys in progress`} flush>
        {joiners.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Joiner</th><th>Role</th><th>Joining</th><th>IT provisioning</th></tr></thead>
              <tbody>
                {joiners.slice(0, 12).map((o) => {
                  /* the IT-asset checklist item is the source of truth for provisioning */
                  const reserved = o.tasks.find((t) => t.k === 'itasset')?.done;
                  return (
                    <tr key={o.id}>
                      <td><b>{o.name}</b></td>
                      <td className="nowrap">{o.designation}</td>
                      <td className="nowrap">{fmtD(o.doj)}</td>
                      <td>{reserved ? <Badge kind="good">Kit reserved</Badge> : <Badge kind="warn">Not started</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="No joiners in the pipeline" />}
      </Card>
    </div>
  );
}

/* ---------------- entry ---------------- */

/*
 * Two tabs, not six.
 *
 * The register used to sit alongside a request queue, a procurement view, a
 * depreciation schedule and a grade-entitlement policy — a full ITAM product
 * for a company that wants to know who has which laptop. What is left is the
 * question actually being asked: what kit do we have, who holds it, and what
 * state is it in. The book-value figures survive as tiles on the register,
 * because finance still reconciles against them.
 */
type Tab = 'reg' | 'alloc';

const TABS: { v: Tab; label: string }[] = [
  { v: 'reg', label: 'Asset Register' },
  { v: 'alloc', label: 'Issue & Return' },
];

function Assets() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('reg');

  /* An employee sees the kit issued to them, and that is the whole screen. */
  if (app.role === 'employee') return <AsMine />;

  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'reg' && <AsRegister />}
      {tab === 'alloc' && <AsAlloc />}
    </>
  );
}

registerModule({
  key: 'assets',
  title: TITLES.assets,
  Component: Assets,
});

export { entitledTo };
