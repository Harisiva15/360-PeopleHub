import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { daysBetween, fmtD, parseYmd, TODAY, ymd } from '../../lib/dates';
import { inr, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { mbS } from '../../data/countries';
import { ASSETS } from '../../data/announcements';
import type { Asset } from '../../types/asset';
import {
  ASSET_CATS, ASSET_STATUS_BADGE, acatOf, assetAge, assetEol, assetKPI, bookValue, inWarranty, modelOf, pendingRecovery,
} from '../../data/assets';
import { ASSET_POLICY, ASSET_REQS, ASSET_REQ_BADGE, arOpen, entitledTo } from '../../data/assetWorkflow';
import type { AssetRequest } from '../../data/assetWorkflow';
import { ACTIVE, EMAP, empName } from '../../data/employees';
import { EXITS } from '../../data/exit';
import { ONBOARD } from '../../data/onboarding';
import { deptOf, GRADES, siteOf } from '../../data/org';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { BarChart, HBar, PAL } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import type { Grade } from '../../types/country';

const AssetBadge = ({ s }: { s: string }) => (
  <Badge kind={(ASSET_STATUS_BADGE[s] || 'mute') as 'good' | 'info' | 'warn' | 'crit' | 'mute'}>{s}</Badge>
);

const ReqBadge = ({ s }: { s: string }) => (
  <Badge kind={(ASSET_REQ_BADGE[s] || 'warn') as 'good' | 'info' | 'crit' | 'warn'}>{s}</Badge>
);

/* ---------------- My assets (employee) ---------------- */

function AsMine() {
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

function AsRegister() {
  const [q, setQ] = useState('');
  const [fc, setFc] = useState('');
  const [fs, setFs] = useState('');

  let list: Asset[] = ASSETS;
  if (fc) list = list.filter((a) => a.cat === fc);
  if (fs) list = list.filter((a) => a.status === fs);
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((a) =>
      (a.type + ' ' + a.serial + ' ' + a.tag + ' ' + (a.empId ? empName(a.empId) : '')).toLowerCase().includes(needle),
    );
  }

  const k = assetKPI();
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
        <button className="btn" onClick={() =>
          downloadCSV('asset_register.csv',
            [['ID', 'Tag', 'Type', 'Category', 'Serial', 'Holder', 'Location', 'Purchased', 'Cost', 'Book value', 'Warranty end', 'Condition', 'Status']].concat(
              ASSETS.map((a) => [a.id, a.tag || '', a.type, acatOf(a.cat).n, a.serial,
                a.empId ? empName(a.empId) : '', siteOf(a.site || 'CHN').name, a.purchased || '',
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
                  <td className="nowrap">{a.empId ? empName(a.empId) : <span className="muted">IT stock</span>}</td>
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

/* ---------------- Requests ---------------- */

function AsRequests() {
  const app = useApp();
  const [fs, setFs] = useState('');
  const scope = app.role === 'employee' ? ASSET_REQS.filter((r) => r.empId === app.meId) : ASSET_REQS;
  const list = fs ? scope.filter((r) => r.status === fs) : scope;
  const open = arOpen();
  const spendPending = sum(open, (r) => r.cost);

  const act = (r: AssetRequest, status: string, msg: string) => {
    r.status = status;
    if (status === 'Fulfilled') r.fulfilledOn = ymd(TODAY);
    app.toast(msg, 'ok');
    app.bump();
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={fs} onChange={(e) => setFs(e.target.value)}>
          <option value="">All statuses</option>
          {uniq(ASSET_REQS.map((r) => r.status)).map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>{inr(spendPending)} of requests awaiting approval</span>
      </div>

      <div className="grid g4">
        <Tile label="Open requests" value={open.length} foot="Awaiting approval" />
        <Tile label="Committed spend" value={inr(spendPending)} foot="If all open requests are approved" />
        <Tile label="Outside entitlement" value={ASSET_REQS.filter((r) => !r.entitled).length} foot="Above grade allowance" />
        <Tile label="Fulfilled" value={ASSET_REQS.filter((r) => r.status === 'Fulfilled').length} foot="Delivered to the requester" />
      </div>

      <Card title="Asset requests" sub={`${list.length} records`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Reference</th><th>Requester</th><th>Item</th><th className="num">Cost</th>
                <th>Reason</th><th>Entitlement</th><th>Raised</th><th>Status</th>
                {app.role !== 'employee' && <th className="right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td><PersonCell e={EMAP[r.empId]} /></td>
                  <td><b>{r.type}</b><div className="mt">{acatOf(r.cat).n}</div></td>
                  <td className="num">{inr(r.cost)}</td>
                  <td>{r.reason}</td>
                  <td>
                    {r.entitled ? <Badge kind="good">Within grade</Badge> : <Badge kind="warn">Above grade</Badge>}
                    {r.needsFinance && <> <Badge kind="info">Finance</Badge></>}
                  </td>
                  <td className="nowrap">{fmtD(r.raisedOn)}</td>
                  <td><ReqBadge s={r.status} /></td>
                  {app.role !== 'employee' && (
                    <td className="right nowrap">
                      {r.status.startsWith('Pending') ? (
                        <>
                          <button className="btn sm primary" onClick={() => act(r, 'Approved', 'Request approved')}>Approve</button>{' '}
                          <button className="btn sm" onClick={() => act(r, 'Rejected', 'Request rejected')}>Reject</button>
                        </>
                      ) : r.status === 'Approved' ? (
                        <button className="btn sm" onClick={() => act(r, 'Fulfilled', 'Marked fulfilled')}>Fulfil</button>
                      ) : <span className="muted">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Allocation ---------------- */

function AsAlloc() {
  const app = useApp();
  const active = ACTIVE();
  const noLaptop = active.filter((e) => !ASSETS.some((a) => a.empId === e.id && a.cat === 'LAPTOP' && a.status === 'Assigned'));
  const rec = pendingRecovery();
  const joiners = ONBOARD.filter((o) => o.status !== 'Completed');

  const allocate = (empId: string) => {
    const stock = ASSETS.find((a) => a.status === 'In stock' && a.cat === 'LAPTOP');
    if (!stock) {
      app.toast('No laptops in stock — raise a purchase order first', 'err');
      return;
    }
    const e = EMAP[empId];
    stock.empId = empId;
    stock.status = 'Assigned';
    stock.issued = ymd(TODAY);
    stock.site = e.site;
    stock.country = e.country;
    app.toast(`${stock.type} allocated to ${e.name}`, 'ok');
    app.bump();
  };

  const bulkAllocate = () => {
    const stock = ASSETS.filter((a) => a.status === 'In stock' && a.cat === 'LAPTOP');
    const n = Math.min(noLaptop.length, stock.length);
    if (!n) {
      app.toast(stock.length ? 'Nobody is waiting for a laptop' : 'No laptops in stock — raise a purchase order first');
      return;
    }
    /* oldest joiner first, so the longest wait is cleared first */
    sortBy(noLaptop, (e) => e.doj).slice(0, n).forEach((e, i) => {
      const a = stock[i];
      a.empId = e.id;
      a.status = 'Assigned';
      a.issued = ymd(TODAY);
      a.site = e.site;
      a.country = e.country;
    });
    app.toast(n + ' laptops allocated', 'ok');
    app.bump();
  };

  const markReturned = (a: Asset) => {
    a.recoveredFrom = a.empId ?? undefined;
    a.recoveredOn = ymd(TODAY);
    a.empId = null;
    a.status = 'In stock';
    app.toast(a.type + ' marked returned and back in stock', 'ok');
    app.bump();
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
                        <td className="nowrap">{empName(a.empId!)}</td>
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

/* ---------------- Stock & procurement ---------------- */

function AsStock() {
  const app = useApp();
  const stock = ASSETS.filter((a) => a.status === 'In stock');
  const repair = ASSETS.filter((a) => a.status === 'In repair');

  const byModel = uniq(stock.map((a) => a.type)).map((t) => ({
    t, n: stock.filter((a) => a.type === t).length,
    cat: modelOf(t).cat, cost: modelOf(t).cost, vendor: modelOf(t).vendor,
  }));

  /* reorder point: less than one month of joining demand left on the shelf */
  const monthlyJoiners = Math.max(1, Math.round(ACTIVE().filter((e) => daysBetween(e.doj, ymd(TODAY)) <= 365).length / 12));
  const reorder = byModel.filter((m) => m.cat === 'LAPTOP' && m.n < monthlyJoiners);

  const returnToStock = (a: Asset) => {
    a.status = 'In stock';
    a.condition = 'Good';
    app.toast(a.type + ' repaired and returned to stock', 'ok');
    app.bump();
  };

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Units in stock" value={stock.length} foot="Ready to allocate" />
        <Tile label="Stock value" value={mbS(sum(stock, bookValue))} foot="At written-down value" />
        <Tile label="In repair" value={repair.length} foot={`${mbS(sum(repair, bookValue))} out of service`} />
        <Tile label="Monthly demand" value={monthlyJoiners + ' laptops'} foot="Based on the last 12 months of joiners" />
      </div>

      {reorder.length > 0 && (
        <Banner kind="warn" icon="⚠">
          <b>Reorder recommended.</b> {reorder.map((m) => `${m.t} (${m.n} left)`).join(', ')} — below one month of joining
          demand. Lead time from {uniq(reorder.map((m) => m.vendor)).join(' and ')} is typically 2–3 weeks.
        </Banner>
      )}

      <div className="grid g2">
        <Card title="Stock on hand" sub={`${byModel.length} models`} flush
          actions={<button className="btn sm primary" onClick={() => app.toast('Purchase requisition drafted — routed to Finance for approval', 'ok')}>Raise purchase order</button>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Model</th><th>Category</th><th>Vendor</th><th className="num">Units</th><th className="num">Unit cost</th><th className="num">Value</th></tr></thead>
              <tbody>
                {sortBy(byModel, (m) => -m.n).map((m) => (
                  <tr key={m.t}>
                    <td><b>{m.t}</b></td>
                    <td className="nowrap">{acatOf(m.cat).n}</td>
                    <td className="nowrap">{m.vendor}</td>
                    <td className={'num' + (m.cat === 'LAPTOP' && m.n < monthlyJoiners ? ' strong' : '')}>{m.n}</td>
                    <td className="num">{inr(m.cost)}</td>
                    <td className="num">{inr(m.cost * m.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Repair queue" sub={`${repair.length} units out of service`} flush>
          {repair.length ? (
            <div className="tbl-wrap" style={{ maxHeight: 380, overflow: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Asset</th><th>Tag</th><th>Age</th><th>Warranty</th><th className="right">Action</th></tr></thead>
                <tbody>
                  {repair.map((a) => (
                    <tr key={a.id}>
                      <td><b>{a.type}</b><div className="mt">{a.condition}</div></td>
                      <td className="mono">{a.tag}</td>
                      <td className="nowrap">{assetAge(a).toFixed(1)} yrs</td>
                      <td>{inWarranty(a) ? <Badge kind="good">Covered</Badge> : <Badge kind="warn">Chargeable</Badge>}</td>
                      <td className="right"><button className="btn sm" onClick={() => returnToStock(a)}>Return to stock</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState msg="Nothing in the repair queue" icon="✓" />}
        </Card>
      </div>

      <Card title="Spend by vendor" sub="Gross purchase value across the whole fleet">
        <HBar fmt={(v) => mbS(v)}
          rows={sortBy(
            uniq(ASSETS.map((a) => a.vendor!)).map((v, i) => ({
              k: v, c: PAL[i % 8], v: sum(ASSETS.filter((a) => a.vendor === v), (a) => a.cost!),
            })),
            (r) => -r.v,
          )} />
      </Card>
    </div>
  );
}

/* ---------------- Lifecycle & depreciation ---------------- */

function AsLife() {
  const live = ASSETS.filter((a) => a.status !== 'Retired');

  const bands = [
    { k: 'Under 1 year', c: 'var(--s6)', f: (a: Asset) => assetAge(a) < 1 },
    { k: '1–2 years', c: 'var(--s3)', f: (a: Asset) => assetAge(a) >= 1 && assetAge(a) < 2 },
    { k: '2–3 years', c: 'var(--s4)', f: (a: Asset) => assetAge(a) >= 2 && assetAge(a) < 3 },
    { k: '3–4 years', c: 'var(--s2)', f: (a: Asset) => assetAge(a) >= 3 && assetAge(a) < 4 },
    { k: 'Past refresh', c: 'var(--s8)', f: assetEol },
  ].map((b) => ({ k: b.k, c: b.c, v: live.filter(b.f).length }));

  /* five-year straight-line schedule on the live fleet, in ₹ lakh */
  const years: { k: string; v: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const yr = TODAY.getFullYear() + i;
    const charge = sum(live, (a) => {
      const life = acatOf(a.cat).life;
      const start = parseYmd(a.purchased!).getFullYear();
      return yr >= start && yr < start + life ? Math.round((a.cost! * 0.95) / life) : 0;
    });
    years.push({ k: String(yr), v: Math.round(charge / 100000) });
  }

  const refresh = sortBy(live.filter((a) => assetEol(a) && a.status === 'Assigned'), (a) => -assetAge(a));
  const refreshCost = sum(refresh, (a) => modelOf(a.type).cost);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Live fleet" value={live.length} foot="Excluding retired assets" />
        <Tile label="Past refresh cycle" value={refresh.length} foot="Assigned and beyond useful life" />
        <Tile label="Refresh cost" value={mbS(refreshCost)} foot="To replace everything past cycle" />
        <Tile label="Average fleet age" value={(sum(live, assetAge) / Math.max(1, live.length)).toFixed(1) + ' yrs'}
          foot="Standard cycle is 4 years for laptops" />
      </div>

      <div className="grid g2">
        <Card title="Fleet ageing" sub="Time since purchase"><HBar rows={bands} /></Card>
        <Card title="Depreciation schedule" sub="Annual charge on the live fleet, ₹ lakh">
          <BarChart labels={years.map((y) => y.k)} height={200} fmt={(v) => '₹' + v + 'L'}
            series={[{ name: 'Depreciation (₹L)', color: 'var(--s1)', data: years.map((y) => y.v) }]} />
        </Card>
      </div>

      <Card title="Refresh plan" sub={`${refresh.length} assets past their useful life`} flush
        actions={<button className="btn sm primary" onClick={() =>
          downloadCSV('asset_refresh_plan.csv',
            [['Asset', 'Tag', 'Serial', 'Holder', 'Purchased', 'Age (yrs)', 'Book value', 'Replacement cost']].concat(
              refresh.map((a) => [a.type, a.tag || '', a.serial, a.empId ? empName(a.empId) : '',
                a.purchased || '', assetAge(a).toFixed(1), String(bookValue(a)), String(modelOf(a.type).cost)]),
            ))}>⤓ Export refresh plan</button>}>
        {refresh.length ? (
          <div className="tbl-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Asset</th><th>Holder</th><th>Purchased</th><th className="num">Age</th><th className="num">Book value</th><th className="num">Replacement</th><th>Warranty</th></tr>
              </thead>
              <tbody>
                {refresh.map((a) => (
                  <tr key={a.id}>
                    <td><b>{a.type}</b><div className="mt">{a.tag}</div></td>
                    <td className="nowrap">{a.empId ? empName(a.empId) : '—'}</td>
                    <td className="nowrap">{fmtD(a.purchased)}</td>
                    <td className="num">{assetAge(a).toFixed(1)} yrs</td>
                    <td className="num">{inr(bookValue(a))}</td>
                    <td className="num">{inr(modelOf(a.type).cost)}</td>
                    <td>{inWarranty(a) ? <Badge kind="good">Covered</Badge> : <Badge kind="warn">Expired</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="Nothing is past its refresh cycle" icon="✓" />}
      </Card>
    </div>
  );
}

/* ---------------- Policy & entitlement ---------------- */

function AsPolicy() {
  const grades = Object.keys(GRADES) as Grade[];
  return (
    <div className="grid g-2-1">
      <Card title="Entitlement by grade" sub="What each grade may hold as standard" flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Grade</th><th>Standard kit</th><th className="num">Items</th></tr></thead>
            <tbody>
              {grades.map((g) => (
                <tr key={g}>
                  <td><b>{GRADES[g].label}</b></td>
                  <td>{ASSET_POLICY.entitlement[g].join(' · ')}</td>
                  <td className="num">{ASSET_POLICY.entitlement[g].length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Policy" sub="Approval, refresh and recovery">
        <div className="stack" style={{ gap: 11, fontSize: 13 }}>
          {([
            ['Second approval', `Anything above ${inr(ASSET_POLICY.approvalOver)} also needs Finance sign-off.`],
            ['Refresh cycles', Object.entries(ASSET_POLICY.refreshYears).map(([k, v]) => `${acatOf(k).n} ${v}y`).join(' · ')],
            ['Damage or loss', ASSET_POLICY.damageRecovery],
            ['Work-from-home setup', `One-time ${inr(ASSET_POLICY.wfhAllowance)} allowance for desk and chair.`],
            ['Personal devices', ASSET_POLICY.byodAllowed ? 'BYOD permitted with MDM enrolment.' : 'BYOD is not permitted for company data.'],
            ['Return', 'All kit returns to IT on or before the last working day; the balance is recovered at written-down value.'],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{k}</div>
              <div className="muted">{v}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'reg' | 'req' | 'alloc' | 'stock' | 'life' | 'pol';

const TABS: { v: Tab; label: string }[] = [
  { v: 'reg', label: 'Asset Register' }, { v: 'req', label: 'Requests' }, { v: 'alloc', label: 'Allocation' },
  { v: 'stock', label: 'Stock & Procurement' }, { v: 'life', label: 'Lifecycle & Depreciation' },
  { v: 'pol', label: 'Policy & Entitlement' },
];

const MINE_TABS: { v: 'kit' | 'req'; label: string }[] = [
  { v: 'kit', label: 'My Assets' }, { v: 'req', label: 'My Requests' },
];

function Assets() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('reg');
  const [mineTab, setMineTab] = useState<'kit' | 'req'>('kit');

  if (app.role === 'employee') {
    return (
      <>
        <Tabs value={mineTab} options={MINE_TABS} onChange={setMineTab} />
        {mineTab === 'kit' ? <AsMine /> : <AsRequests />}
      </>
    );
  }

  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'reg' && <AsRegister />}
      {tab === 'req' && <AsRequests />}
      {tab === 'alloc' && <AsAlloc />}
      {tab === 'stock' && <AsStock />}
      {tab === 'life' && <AsLife />}
      {tab === 'pol' && <AsPolicy />}
    </>
  );
}

registerModule({
  key: 'assets',
  title: TITLES.assets,
  subtitle: (c) => {
    const k = assetKPI();
    return c.role === 'employee'
      ? 'Equipment issued to you'
      : `${k.total} assets tracked · ${mbS(k.net)} net book value`;
  },
  Component: Assets,
});

export { entitledTo };
