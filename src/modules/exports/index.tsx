/**
 * Export centre.
 *
 * Two halves that answer opposite questions. The left is "get me the data" —
 * pick a dataset, pick columns, take the file. The right is "who has been
 * taking data" — the register, which is the half that matters to whoever has
 * to answer for it later.
 *
 * The screen says twice what the service enforces once: an export sees exactly
 * what you see, and the fact of it is recorded. Both are worth saying out
 * loud, because people assume the opposite of each.
 */

import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { fmtD } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import type { Dataset, ExportFilter, ExportOutcome } from '../../services';
import {
  Avatar, Badge, Banner, Card, EmptyState, StatRow, Tabs, Tile,
} from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useDatasets, useExportHistory, useExportStats, useRunExport,
} from './data';

type Tab = 'take' | 'register';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const OUTCOME_TONE: Record<ExportOutcome, 'good' | 'crit'> = {
  Completed: 'good', Refused: 'crit',
};

/* ---------------- taking one ---------------- */

/**
 * The dialog that actually runs an export.
 *
 * Columns default to all of them, because the common case is "the whole
 * thing" and making somebody tick nine boxes to get what they asked for is a
 * toll. Unticking the personal ones is one button, because that is the choice
 * worth making easy.
 */
function RunExport({ d, close }: { d: Dataset; close: () => void }) {
  const app = useApp();
  const run = useRunExport();
  const [cols, setCols] = useState<string[]>(d.columns.map((c) => c.k));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [err, setErr] = useState('');

  const toggle = (k: string) =>
    setCols(cols.includes(k) ? cols.filter((x) => x !== k) : [...cols, k]);

  const personalCols = d.columns.filter((c) => c.personal).map((c) => c.k);
  const takingPersonal = cols.some((k) => personalCols.includes(k));

  const go = async () => {
    setErr('');
    try {
      const res = await run.mutate({ datasetId: d.id, columns: cols, from, to });
      downloadCSV(res.filename, [res.header, ...res.rows]);
      app.toast(`${res.rows.length} rows exported`, 'ok');
      close();
    } catch (e) { setErr(msg(e, 'The export did not run')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not exported">{err}</Banner>}

      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.55, margin: 0 }}>{d.desc}</p>

      <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="You will get what you can see">
        This is built by asking the same service the screen asks, with you as the
        caller — so it contains your rows and nobody else&rsquo;s. The fact that you
        ran it is recorded in the register; the rows themselves are not kept.
      </Banner>

      {d.dated && (
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>From</label>
            <input className="input" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>To</label>
            <input className="input" type="date" value={to}
              onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      )}

      <div className="field">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <label style={{ margin: 0 }}>Columns</label>
          <div className="row" style={{ gap: 6 }}>
            {personalCols.length > 0 && (
              <button className="btn sm" type="button"
                onClick={() => setCols(cols.filter((k) => !personalCols.includes(k)))}>
                Leave out personal details
              </button>
            )}
            <button className="btn sm" type="button"
              onClick={() => setCols(d.columns.map((c) => c.k))}>
              All
            </button>
          </div>
        </div>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap', marginTop: 8 }}>
          {d.columns.map((c) => (
            <button key={c.k} type="button"
              className={'chip' + (cols.includes(c.k) ? ' on' : '')}
              aria-pressed={cols.includes(c.k)}
              onClick={() => toggle(c.k)}>
              {c.n}{c.personal && ' ·'}
            </button>
          ))}
        </div>
      </div>

      {takingPersonal && (
        <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="This file will name people">
          The columns marked · identify individuals. Once it is on your machine it is
          outside everything this product controls — the register will say you took
          it, and nothing more.
        </Banner>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!cols.length || run.pending} onClick={go}>
          <Icon n="download" size="lg" /> {run.pending ? 'Building…' : 'Export CSV'}
        </button>
      </div>
    </div>
  );
}

function DatasetCard({ d, onRun }: { d: Dataset; onRun: () => void }) {
  return (
    <Card
      title={d.n}
      sub={d.desc}
      actions={
        <div className="row" style={{ gap: 6 }}>
          {d.personal && <Badge kind="warn">Personal data</Badge>}
          {d.scope === 'admin-only' && <Badge kind="info">Whole company</Badge>}
        </div>
      }
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {d.columns.length} columns{d.dated ? ' · takes a date range' : ''}
        </span>
        <button className="btn sm primary" onClick={onRun}>
          <Icon n="download" size="lg" /> Export
        </button>
      </div>
    </Card>
  );
}

/* ---------------- the page ---------------- */

function ExportsView() {
  const app = useApp();
  const layer = useLayer();
  const [tab, setTab] = useTabFromUrl<Tab>('take', ['take', 'register']);
  const [f, setF] = useState<ExportFilter>({});

  const { data: datasets = [], loading: dsLoading } = useDatasets();
  const { data: history = [], loading, error } = useExportHistory(f);
  const { data: all = [] } = useExportHistory({});
  const { data: stats } = useExportStats();

  if (error) {
    return (
      <Card title="Export centre">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const open = (d: Dataset) => layer.modal({
    title: `Export ${d.n.toLowerCase()}`,
    sub: d.personal ? 'Contains personal data' : undefined,
    body: (close) => <RunExport d={d} close={close} />,
    footer: null,
  });

  const exportRegister = () => downloadCSV('export_register.csv', [
    ['When', 'Dataset', 'By', 'Role', 'Outcome', 'Rows', 'Columns',
      'Range', 'Personal data', 'Note'],
    ...history.map((r) => [
      r.run.at, r.run.datasetName, r.run.byName, r.run.byRole, r.run.outcome,
      r.run.rows, r.run.columns, r.run.filters, r.run.personal ? 'Yes' : 'No',
      r.run.note,
    ]),
  ]);

  const one = (k: keyof ExportFilter) => (v: string) => setF({ ...f, [k]: v || undefined });
  const filtered = Object.values(f).some((v) => v != null && v !== '' && v !== false);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile icon={<Icon n="download" size="lg" />} label="Exports"
          value={stats?.runs ?? '—'}
          foot={stats ? `${stats.thisMonth} this month` : ''} />
        <Tile icon={<Icon n="grid" size="lg" />} label="Rows taken"
          value={stats?.rows?.toLocaleString('en-IN') ?? '—'}
          foot={stats ? `across ${stats.datasets} dataset(s)` : ''} />
        <Tile icon={<Icon n="people" size="lg" />} label="Naming people"
          value={stats?.personal ?? '—'} foot="Exports carrying personal data" />
        <Tile icon={<Icon n="blocked" size="lg" />} label="Refused"
          value={stats?.refused ?? '—'} foot="Attempts a role could not run" />
      </StatRow>

      <Tabs
        value={tab}
        options={[
          { v: 'take' as const, label: `What you can export (${datasets.length})` },
          { v: 'register' as const, label: app.role === 'admin' ? 'Register' : 'Your exports' },
        ]}
        onChange={setTab}
      />

      {tab === 'take' && (
        <>
          <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="Only what you can already see">
            Every export here is built by asking the same service the screen asks,
            with you as the caller. There is no dataset that returns more than the
            matching page would — the two that could not be narrowed that way are
            restricted to administrators instead of being quietly widened.
          </Banner>

          {datasets.length ? (
            <div className="stack">
              {sortBy(datasets, (d) => d.n).map((d) => (
                <DatasetCard key={d.id} d={d} onRun={() => open(d)} />
              ))}
            </div>
          ) : (
            <Card title="Nothing to export">
              <EmptyState icon={<Icon n="download" size="xl" />}
                msg={dsLoading ? 'Loading…' : 'No dataset is available to your role'} />
            </Card>
          )}
        </>
      )}

      {tab === 'register' && (
        <>
          <Banner kind="info" icon={<Icon n="policy" size="lg" />} title="What this keeps, and what it does not">
            The register records that an export happened — the dataset, the person,
            the time, the row count. It does not keep the rows. A log holding the
            files would be the largest collection of personal data in the product,
            behind whatever permissions this page happens to have.
          </Banner>

          <div className="toolbar">
            <div className="gsearch" style={{ width: 230, flex: '0 0 auto' }}>
              <span className="gsearch-ic" aria-hidden="true"><Icon n="search" /></span>
              <input className="gsearch-in" type="search" value={f.q ?? ''}
                placeholder="Dataset or person…" aria-label="Search the register"
                onChange={(e) => one('q')(e.target.value)} />
            </div>
            <select className="input sm" value={f.datasetId ?? ''} aria-label="Dataset"
              onChange={(e) => one('datasetId')(e.target.value)}>
              <option value="">All datasets</option>
              {sortBy([...new Set(all.map((r) => r.run.datasetId))]).map((id) => (
                <option key={id} value={id}>
                  {all.find((r) => r.run.datasetId === id)!.run.datasetName}
                </option>
              ))}
            </select>
            {app.role === 'admin' && (
              <select className="input sm" value={f.byId ?? ''} aria-label="Person"
                onChange={(e) => one('byId')(e.target.value)}>
                <option value="">Anybody</option>
                {sortBy([...new Set(all.map((r) => r.run.byId))],
                  (id) => all.find((r) => r.run.byId === id)!.run.byName).map((id) => (
                  <option key={id} value={id}>
                    {all.find((r) => r.run.byId === id)!.run.byName}
                  </option>
                ))}
              </select>
            )}
            <select className="input sm" value={f.outcome ?? ''} aria-label="Outcome"
              onChange={(e) => one('outcome')(e.target.value)}>
              <option value="">Any outcome</option>
              <option value="Completed">Completed</option>
              <option value="Refused">Refused</option>
            </select>
            <button className={'btn sm' + (f.personalOnly ? ' primary' : '')}
              aria-pressed={!!f.personalOnly}
              onClick={() => setF({ ...f, personalOnly: f.personalOnly ? undefined : true })}>
              Personal data only
            </button>
            <div className="spacer" />
            {filtered && <button className="btn sm" onClick={() => setF({})}>Reset</button>}
            <button className="btn sm" onClick={exportRegister} disabled={!history.length}>
              <Icon n="download" size="lg" /> Export the register
            </button>
          </div>

          <Card
            title={app.role === 'admin' ? 'Everything that has left' : 'What you have taken'}
            sub={`${history.length} of ${all.length} · newest first`}
            flush
          >
            {history.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>When</th><th>Dataset</th>
                      {app.role === 'admin' && <th>By</th>}
                      <th className="num">Rows</th><th className="num">Columns</th>
                      <th>Range</th><th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((r) => (
                      <tr key={r.run.id}>
                        <td className="nowrap mono" style={{ fontSize: 11.5 }}>
                          {fmtD(r.run.at.slice(0, 10))}
                          <span className="muted"> {r.run.at.slice(11)}</span>
                        </td>
                        <td>
                          <div style={{ fontWeight: 650, fontSize: 12.5 }}>
                            {r.run.datasetName}
                          </div>
                          {r.run.personal && (
                            <div className="muted" style={{ fontSize: 11 }}>
                              Named individuals
                            </div>
                          )}
                        </td>
                        {app.role === 'admin' && (
                          <td>
                            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                              <Avatar name={r.run.byName} />
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 650, fontSize: 12.5 }}>
                                  {r.run.byName}
                                </div>
                                <div className="muted" style={{ fontSize: 11 }}>
                                  {r.run.byRole}
                                </div>
                              </div>
                            </div>
                          </td>
                        )}
                        <td className="num">{r.run.rows || '—'}</td>
                        <td className="num">{r.run.columns}</td>
                        <td className="muted nowrap" style={{ fontSize: 11.5 }}>
                          {r.run.filters}
                        </td>
                        <td>
                          <Badge kind={OUTCOME_TONE[r.run.outcome]}>{r.run.outcome}</Badge>
                          {r.run.note && (
                            <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                              {r.run.note}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={<Icon n="policy" size="xl" />}
                msg={loading
                  ? 'Loading the register…'
                  : all.length
                    ? 'Nothing matches this filter'
                    : 'Nothing has been exported yet'}
              />
            )}
          </Card>

          {app.role === 'admin' && stats != null && stats.refused > 0 && (
            <Banner kind="warn" icon={<Icon n="blocked" size="lg" />} title="Refused attempts are kept too">
              {stats.refused} export(s) were refused because the role could not run
              them. Those are recorded deliberately — a register holding only the
              permitted exports has answered a narrower question than it looks.
 Repeated refusals from one person are worth a conversation.
            </Banner>
          )}
        </>
      )}
    </div>
  );
}

registerModule({
  key: 'exports',
  title: TITLES.exports,
  Component: ExportsView,
});

export { ExportsView };

