/**
 * Custom reports.
 *
 * The eleven reports under Reports are the ones the product ships. These are
 * the ones somebody wrote, and the difference that matters is on every screen
 * here: **a saved report is a question, not an answer.** Running one asks the
 * export centre as whoever pressed the button, so a report an administrator
 * shared and a manager opens returns the manager's line.
 *
 * The builder is deliberately small. A report here is a dataset, some columns,
 * optionally a thing to group by and some sums — which covers the questions
 * people actually save, and stops well short of being a query language nobody
 * will learn.
 */

import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { fmtD } from '../../lib/dates';
import { inr } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { AGGREGATIONS } from '../../services';
import type {
  Aggregation, Dataset, ReportDraft, ReportFilterClause, ReportMeasure,
  ReportResult, ReportRow,
} from '../../services';
import { Badge, Banner, Card, EmptyState, StatRow, Tabs, Tile } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useCreateReport, useDuplicateReport, useRemoveReport, useReportDatasets,
  useReports, useRunReport, useUpdateReport,
} from './data';

type Tab = 'all' | 'mine';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const OPS: ReportFilterClause['op'][] = ['is', 'is not', 'contains', 'greater than', 'less than'];

/** Money columns read as money; everything else as itself. */
const MONEY = ['annualCost', 'wastedCost', 'cost', 'unitCost'];
const cell = (v: unknown, key: string) => {
  if (v === null || v === undefined || v === '') return '—';
  if (MONEY.includes(key) && typeof v === 'number') return inr(v);
  return String(v);
};

/* ---------------- the builder ---------------- */

function ReportForm({ existing, close }: { existing?: ReportRow; close: () => void }) {
  const app = useApp();
  const create = useCreateReport();
  const update = useUpdateReport();
  const { data: datasets = [] } = useReportDatasets();
  const r = existing?.report;

  const [d, setD] = useState<ReportDraft>({
    n: r?.n ?? '',
    desc: r?.desc ?? '',
    datasetId: r?.datasetId ?? '',
    columns: r?.columns ?? [],
    groupBy: r?.groupBy ?? null,
    measures: r?.measures ?? [],
    filters: r?.filters ?? [],
    sort: r?.sort ?? null,
    shared: r?.shared ?? false,
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof ReportDraft>(k: K, v: ReportDraft[K]) => setD({ ...d, [k]: v });

  const ds: Dataset | undefined = datasets.find((x) => x.id === d.datasetId);

  const pickDataset = (id: string) =>
    /* Changing the dataset invalidates every column reference, so they reset. */
    setD({ ...d, datasetId: id, columns: [], groupBy: null, measures: [], filters: [], sort: null });

  const toggleCol = (k: string) => set('columns',
    (d.columns ?? []).includes(k)
      ? (d.columns ?? []).filter((x) => x !== k)
      : [...(d.columns ?? []), k]);

  const addMeasure = () => set('measures',
    [...(d.measures ?? []), { col: '*', agg: 'count' as Aggregation }]);
  const setMeasure = (i: number, m: ReportMeasure) =>
    set('measures', (d.measures ?? []).map((x, j) => (j === i ? m : x)));
  const dropMeasure = (i: number) =>
    set('measures', (d.measures ?? []).filter((_, j) => j !== i));

  const addFilter = () => ds && set('filters',
    [...(d.filters ?? []), { col: ds.columns[0]!.k, op: 'is' as const, value: '' }]);
  const setFilter = (i: number, f: ReportFilterClause) =>
    set('filters', (d.filters ?? []).map((x, j) => (j === i ? f : x)));
  const dropFilter = (i: number) =>
    set('filters', (d.filters ?? []).filter((_, j) => j !== i));

  const save = async () => {
    setErr('');
    try {
      if (r) await update.mutate(r.id, d);
      else await create.mutate(d);
      app.toast(r ? 'Report saved' : 'Report created', 'ok');
      close();
    } catch (e) { setErr(msg(e, 'Could not save the report')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not saved">{err}</Banner>}

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 2 }}>
          <label>What is it called <span className="req">*</span></label>
          <input className="input" value={d.n} autoFocus placeholder="Headcount by department"
            onChange={(e) => set('n', e.target.value)} />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label>Report on <span className="req">*</span></label>
          <select className="input" value={d.datasetId} onChange={(e) => pickDataset(e.target.value)}>
            <option value="">Choose something</option>
            {sortBy(datasets, (x) => x.n).map((x) => (
              <option key={x.id} value={x.id}>{x.n}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>What it answers</label>
        <input className="input" value={d.desc ?? ''}
          placeholder="How many people sit in each department, for the monthly pack."
          onChange={(e) => set('desc', e.target.value)} />
      </div>

      {!ds ? (
        <Banner kind="info" icon={<Icon n="info" size="lg" />} title="Choose something to report on">
          The list above is the same set the export centre offers you, so a report
          can never reach further than an export would.
        </Banner>
      ) : (
        <>
          <div className="field">
            <label>Group by</label>
            <select className="input" value={d.groupBy ?? ''}
              onChange={(e) => set('groupBy', e.target.value || null)}>
              <option value="">Don&rsquo;t group — list every row</option>
              {ds.columns.map((c) => <option key={c.k} value={c.k}>{c.n}</option>)}
            </select>
          </div>

          {d.groupBy ? (
            <div className="field">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ margin: 0 }}>Summarise</label>
                <button className="btn sm" type="button" onClick={addMeasure}>
                  <Icon n="add" size="lg" /> Add
                </button>
              </div>
              {(d.measures ?? []).length === 0 && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                  Nothing chosen, so it will simply count the rows in each group.
                </div>
              )}
              {(d.measures ?? []).map((m, i) => (
                <div className="row" key={i} style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <select className="input sm" value={m.agg} style={{ flex: 1 }}
                    onChange={(e) => setMeasure(i, { ...m, agg: e.target.value as Aggregation })}>
                    {AGGREGATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <select className="input sm" value={m.col} style={{ flex: 2 }}
                    onChange={(e) => setMeasure(i, { ...m, col: e.target.value })}>
                    <option value="*">rows</option>
                    {ds.columns.map((c) => <option key={c.k} value={c.k}>{c.n}</option>)}
                  </select>
                  <button className="btn ghost icon sm" type="button"
                    aria-label="Remove this summary" onClick={() => dropMeasure(i)}>
                    <Icon n="remove" size="sm" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="field">
              <label>Columns</label>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
                Choose none and it shows every column.
              </div>
              <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
                {ds.columns.map((c) => (
                  <button key={c.k} type="button"
                    className={'chip' + ((d.columns ?? []).includes(c.k) ? ' on' : '')}
                    aria-pressed={(d.columns ?? []).includes(c.k)}
                    onClick={() => toggleCol(c.k)}>
                    {c.n}{c.personal && ' ·'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ margin: 0 }}>Only rows where</label>
              <button className="btn sm" type="button" onClick={addFilter}>
                <Icon n="add" size="lg" /> Add
              </button>
            </div>
            {(d.filters ?? []).map((f, i) => (
              <div className="row" key={i} style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
                <select className="input sm" value={f.col} style={{ flex: 2 }}
                  onChange={(e) => setFilter(i, { ...f, col: e.target.value })}>
                  {ds.columns.map((c) => <option key={c.k} value={c.k}>{c.n}</option>)}
                </select>
                <select className="input sm" value={f.op} style={{ flex: 1.4 }}
                  onChange={(e) => setFilter(i, { ...f, op: e.target.value as ReportFilterClause['op'] })}>
                  {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input className="input sm" value={f.value} style={{ flex: 2 }} placeholder="value"
                  onChange={(e) => setFilter(i, { ...f, value: e.target.value })} />
                <button className="btn ghost icon sm" type="button"
                  aria-label="Remove this condition" onClick={() => dropFilter(i)}>
                  <Icon n="remove" size="sm" />
                </button>
              </div>
            ))}
          </div>

          <div className="field">
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={d.shared ?? false}
                onChange={(e) => set('shared', e.target.checked)} />
              <span>Share it with everybody who can read this data</span>
            </label>
            {d.shared && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                Sharing shares the question, not the answer — each person who runs it
                sees their own rows.
              </div>
            )}
          </div>
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!d.n || !d.datasetId || create.pending || update.pending}
          onClick={save}>
          {r ? 'Save report' : 'Create report'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- the result ---------------- */

function ResultView({ res }: { res: ReportResult }) {
  const cols = res.grouped
    ? []
    : (res.report.columns.length ? res.report.columns : res.dataset.columns.map((c) => c.k));

  const exportCsv = () => downloadCSV(
    `${res.report.n.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.csv`,
    [res.header, ...res.rows],
  );

  return (
    <div className="stack">
      <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="These are your rows">
        The report was run as you. Somebody else opening the same saved report sees
        what they can see — the definition is shared, the data is not.
      </Banner>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {res.grouped
            ? `${res.rows.length} group(s) from ${res.total} row(s)`
            : `${res.rows.length} row(s)`}
        </span>
        <button className="btn sm" onClick={exportCsv} disabled={!res.rows.length}>
          <Icon n="download" size="lg" /> Export
        </button>
      </div>

      {res.rows.length ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                {res.header.map((h, i) => (
                  <th key={h} className={res.grouped && i > 0 ? 'num' : undefined}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {res.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((v, j) => (
                    <td key={j} className={res.grouped && j > 0 ? 'num' : undefined}>
                      {cell(v, res.grouped ? (res.report.measures[j - 1]?.col ?? '') : (cols[j] ?? ''))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={<Icon n="filter" size="xl" />}
          msg="Nothing matched — the filters may be narrower than you meant" />
      )}
    </div>
  );
}

/* ---------------- the page ---------------- */

function CustomReportsView() {
  const app = useApp();
  const layer = useLayer();
  const [tab, setTab] = useTabFromUrl<Tab>('all', ['all', 'mine']);
  const { data: reports = [], loading, error } = useReports();
  const run = useRunReport();
  const remove = useRemoveReport();
  const duplicate = useDuplicateReport();

  if (error) {
    return (
      <Card title="Custom reports">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const rows = tab === 'mine' ? reports.filter((r) => r.mine) : reports;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); app.toast(done, 'ok'); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  const open = async (r: ReportRow) => {
    try {
      const res = await run.mutate(r.report.id);
      layer.drawer({
        title: r.report.n,
        sub: r.report.desc || r.dataset?.n,
        body: <ResultView res={res} />,
      });
    } catch (e) { app.toast(msg(e, 'The report did not run'), 'err'); }
  };

  const edit = (r?: ReportRow) => layer.modal({
    title: r ? 'Edit the report' : 'New report',
    sub: r?.report.n,
    body: (close) => <ReportForm existing={r} close={close} />,
    footer: null,
  });

  const shared = reports.filter((r) => r.report.shared).length;
  const neverRun = reports.filter((r) => r.report.runCount === 0).length;

  return (
    <div className="stack">
      <PageActions>
        <button className="btn primary" onClick={() => edit()}>
          <Icon n="add" size="lg" /> New report
        </button>
      </PageActions>

      <StatRow cols={4}>
        <Tile icon={<Icon n="reports" size="lg" />} label="Saved reports" value={reports.length}
          foot={`${shared} shared`} />
        <Tile icon={<Icon n="person" size="lg" />} label="Yours"
          value={reports.filter((r) => r.mine).length} foot="Written by you" />
        <Tile icon={<Icon n="refresh" size="lg" />} label="Runs"
          value={reports.reduce((n, r) => n + r.report.runCount, 0)} foot="All time" />
        <Tile icon={<Icon n="pending" size="lg" />} label="Never run" value={neverRun}
          foot="Saved and not opened since" />
      </StatRow>

      <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="A report is a question, not an answer">
        Running one asks the same scoped data an export would, as the person who
        pressed the button. Nothing here stores rows, so sharing a report can never
        share data somebody could not otherwise see.
      </Banner>

      <Tabs
        value={tab}
        options={[
          { v: 'all' as const, label: `All (${reports.length})` },
          { v: 'mine' as const, label: `Mine (${reports.filter((r) => r.mine).length})` },
        ]}
        onChange={setTab}
      />

      {rows.length ? (
        <div className="stack">
          {rows.map((r) => (
            <Card
              key={r.report.id}
              title={<button className="linkish" onClick={() => open(r)}>{r.report.n}</button>}
              sub={r.report.desc}
              actions={
                <div className="row" style={{ gap: 6 }}>
                  {r.report.shared ? <Badge kind="info">Shared</Badge> : <Badge kind="mute">Private</Badge>}
                  {!r.runnable && <Badge kind="warn">Not for your role</Badge>}
                </div>
              }
            >
              <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 11.5, flex: 1, minWidth: 180 }}>
                  {r.dataset?.n ?? 'A dataset that no longer exists'}
                  {r.report.groupBy && ' · grouped'}
                  {r.report.filters.length > 0 && ` · ${r.report.filters.length} condition(s)`}
                  {' · by '}{r.owner}
                  {r.report.lastRunOn
                    ? ` · last run ${fmtD(r.report.lastRunOn)}`
                    : ' · never run'}
                </span>
                <div className="row" style={{ gap: 7 }}>
                  <button className="btn sm primary" disabled={!r.runnable || run.pending}
                    onClick={() => open(r)}>
                    <Icon n="next" size="lg" /> Run
                  </button>
                  <button className="btn sm" onClick={() =>
                    act(() => duplicate.mutate(r.report.id), 'Copied to your reports')}>
                    Duplicate
                  </button>
                  {(r.mine || app.role === 'admin') && (
                    <>
                      <button className="btn sm" onClick={() => edit(r)}>
                        <Icon n="tool" size="lg" /> Edit
                      </button>
                      <button className="btn ghost icon sm" aria-label={`Delete ${r.report.n}`}
                        onClick={() => act(() => remove.mutate(r.report.id), 'Report deleted')}>
                        <Icon n="remove" size="sm" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card title={tab === 'mine' ? 'Your reports' : 'Reports'}>
          <EmptyState
            icon={<Icon n="reports" size="xl" />}
            msg={loading
              ? 'Loading…'
              : tab === 'mine'
                ? 'You have not written one yet'
                : 'Nobody has saved a report yet'}
          />
        </Card>
      )}
    </div>
  );
}

registerModule({
  key: 'customreports',
  title: TITLES.customreports,
  Component: CustomReportsView,
});

export { CustomReportsView };
