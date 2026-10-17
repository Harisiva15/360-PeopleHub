/**
 * Job titles.
 *
 * The catalogue existed implicitly: every employee carries a `designation`
 * string drawn from a department-by-grade table. What it could not do is carry
 * anything *about* a title, so a designation was a string that happened to
 * repeat. Making it a record is the module — a title can be retired without
 * touching the people who hold it, and "how many Senior Engineers are there"
 * becomes a question with an answer.
 *
 * **What each role gets is different in kind, not degree.** An administrator
 * configures the catalogue; a manager reads it; an employee reads the single
 * record they hold. The third is not a filtered list — filtering would still
 * expose the codes and levels of everything they matched, which is not what
 * "view their own job title" means.
 */

import { useState } from 'react';
import { sortBy, uniq } from '../../lib/collections';
import { fmtD } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import { DEPTS, deptOf } from '../../data/org';
import { JOB_EMP_TYPES, JOB_FAMILIES, JOB_LEVELS, levelOf } from '../../services';
import type {
  JobTitle, JobTitleDraft, JobTitleFilter, JobTitleStatus,
} from '../../services';
import {
  Avatar, Badge, Banner, Card, EmptyState, KV, PersonCell, StatRow, Tabs, Tile,
} from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { Menu } from '../../components/Menu';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useCreateJobTitle, useDeleteJobTitle, useJobTitle, useJobTitles, useMyJobTitle,
  useSetJobTitleStatus, useUpdateJobTitle,
} from './data';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const Req = () => <span className="req" aria-hidden="true">*</span>;

const STATUS_TONE: Record<JobTitleStatus, 'good' | 'warn' | 'mute'> = {
  Active: 'good', Inactive: 'warn', Archived: 'mute',
};

const StatusBadge = ({ s }: { s: JobTitleStatus }) => (
  <Badge kind={STATUS_TONE[s]}>{s}</Badge>
);

/* ---------------- the form ---------------- */

function TitleForm({ existing, close }: { existing?: JobTitle; close: () => void }) {
  const app = useApp();
  const create = useCreateJobTitle();
  const update = useUpdateJobTitle();

  const [n, setN] = useState(existing?.n ?? '');
  const [code, setCode] = useState(existing?.code ?? '');
  const [dept, setDept] = useState(existing?.dept ?? '');
  const [family, setFamily] = useState(existing?.family ?? JOB_FAMILIES[0]);
  const [level, setLevel] = useState(existing?.level ?? 'L3');
  const [empType, setEmpType] = useState(existing?.empType ?? JOB_EMP_TYPES[0]);
  const [desc, setDesc] = useState(existing?.desc ?? '');
  const [resp, setResp] = useState((existing?.responsibilities ?? []).join('\n'));
  const [required, setRequired] = useState((existing?.required ?? []).join(', '));
  const [preferred, setPreferred] = useState((existing?.preferred ?? []).join(', '));
  const [status, setStatus] = useState<JobTitleStatus>(existing?.status ?? 'Active');
  const [err, setErr] = useState('');

  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    setErr('');
    const draft: JobTitleDraft = {
      n, code, dept, family, level, empType, desc,
      responsibilities: lines(resp),
      required: csv(required),
      preferred: csv(preferred),
      status,
    };
    try {
      if (existing) { await update.mutate(existing.id, draft); app.toast('Job title updated', 'ok'); }
      else { await create.mutate(draft); app.toast('Job title added', 'ok'); }
      close();
    } catch (e) { setErr(msg(e, 'Could not save')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not saved">{err}</Banner>}

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 2 }}>
          <label>Job title <Req /></label>
          <input className="input" value={n} placeholder="Senior Software Engineer"
            onChange={(e) => setN(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Job code <Req /></label>
          <input className="input" value={code} placeholder="TECH-001"
            onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </div>
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Department <Req /></label>
          <select className="input" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">Choose…</option>
            {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Job family</label>
          <select className="input" value={family} onChange={(e) => setFamily(e.target.value)}>
            {JOB_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Level <Req /></label>
          <select className="input" value={level}
            onChange={(e) => setLevel(e.target.value as typeof level)}>
            {JOB_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.n}</option>)}
          </select>
          <div className="hint">Pays against grade {levelOf(level).grade}.</div>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Employment type</label>
          <select className="input" value={empType} onChange={(e) => setEmpType(e.target.value)}>
            {JOB_EMP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Status</label>
          <select className="input" value={status}
            onChange={(e) => setStatus(e.target.value as JobTitleStatus)}>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Archived">Archived</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label>Description</label>
        <textarea className="input" rows={2} value={desc}
          placeholder="What this role is for."
          onChange={(e) => setDesc(e.target.value)} />
      </div>

      <div className="field">
        <label>Responsibilities</label>
        <textarea className="input" rows={4} value={resp}
          placeholder={'One per line'}
          onChange={(e) => setResp(e.target.value)} />
        <div className="hint">One per line.</div>
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Required skills</label>
          <input className="input" value={required} placeholder="Java, Kubernetes"
            onChange={(e) => setRequired(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Preferred skills</label>
          <input className="input" value={preferred} placeholder="Terraform"
            onChange={(e) => setPreferred(e.target.value)} />
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={create.pending || update.pending} onClick={save}>
          {existing ? 'Save changes' : 'Add job title'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- the detail drawer ---------------- */

function TitleDetail({ id }: { id: string }) {
  const { data: d, loading, error } = useJobTitle(id);
  const [tab, setTab] = useState<'overview' | 'people' | 'history'>('overview');

  if (error) return <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />;
  if (!d) return <EmptyState msg={loading ? 'Loading…' : 'No such job title'} />;

  const t = d.title;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
        <StatusBadge s={t.status} />
        <Badge kind="info">{levelOf(t.level).n}</Badge>
        <Badge kind="mute">{t.code}</Badge>
      </div>

      <StatRow cols={3}>
        <Tile label="Employees" value={d.employees} foot="Holding this title" />
        <Tile label="Open positions" value={d.openPositions} foot="Hiring into it" />
        <Tile label="Level" value={t.level} foot={`Grade ${levelOf(t.level).grade}`} />
      </StatRow>

      <Tabs
        value={tab}
        options={[
          { v: 'overview' as const, label: 'Overview' },
          { v: 'people' as const, label: `Employees (${d.holders.length})` },
          { v: 'history' as const, label: 'History' },
        ]}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <>
          <KV rows={[
            ['Job title', t.n],
            ['Job code', t.code],
            ['Department', deptOf(t.dept).name],
            ['Job family', t.family],
            ['Level', levelOf(t.level).n],
            ['Employment type', t.empType],
            ['Created', fmtD(t.createdOn)],
            ['Last updated', t.modifiedOn ? fmtD(t.modifiedOn) : '—'],
          ]} />
          {t.desc && (
            <p style={{ margin: '12px 0 0', fontSize: 13.5, lineHeight: 1.6 }}>{t.desc}</p>
          )}
          {t.responsibilities.length > 0 && (
            <Card title="Responsibilities" style={{ marginTop: 12 }}>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
                {t.responsibilities.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </Card>
          )}
          {(t.required.length > 0 || t.preferred.length > 0) && (
            <Card title="Skills" style={{ marginTop: 12 }}>
              <KV rows={[
                ['Required', t.required.length ? t.required.join(', ') : '—'],
                ['Preferred', t.preferred.length ? t.preferred.join(', ') : '—'],
              ]} />
            </Card>
          )}
        </>
      )}

      {tab === 'people' && (
        d.holders.length ? (
          <div className="stack">
            {d.holders.map((e) => (
              <div key={e.id} className="row" style={{ gap: 10, alignItems: 'center' }}>
                <PersonCell e={e} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Icon n="people" size="xl" />}
            msg="Nobody in your scope holds this title" />
        )
      )}

      {tab === 'history' && (
        d.history.length ? (
          <div className="tl">
            {d.history.map((h) => (
              <div className="tl-row" key={h.id}>
                <div className="tl-time mono">{h.at.slice(11, 16)}</div>
                <div className="tl-mark" aria-hidden="true">
                  <i style={{ background: 'var(--brand)' }} />
                </div>
                <div className="tl-body">
                  <div className="tl-k">{h.action.split('.').pop()}</div>
                  <div className="tl-s">{h.summary}</div>
                  <div className="tl-who muted">{h.actorLabel} · {fmtD(h.at.slice(0, 10))}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Icon n="clock" size="xl" />}
            msg="Nothing has changed on this title yet" />
        )
      )}
    </div>
  );
}

/* ---------------- the page ---------------- */

/** What an employee gets: the one title they hold. */
function MyTitle() {
  const { data: row, loading } = useMyJobTitle();

  if (!row) {
    return (
      <Card title="Your job title">
        <EmptyState icon={<Icon n="briefcase" size="xl" />}
          msg={loading
            ? 'Loading…'
            : 'Your designation is not in the job-title catalogue yet.'} />
      </Card>
    );
  }

  const t = row.title;
  return (
    <div className="stack">
      <Card title={t.n} sub={`${deptOf(t.dept).name} · ${t.family}`}>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>
          <Badge kind="info">{levelOf(t.level).n}</Badge>
          <Badge kind="mute">{t.code}</Badge>
          <Badge kind="mute">{t.empType}</Badge>
        </div>
        {t.desc && <p style={{ margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.6 }}>{t.desc}</p>}
        {t.responsibilities.length > 0 && (
          <>
            <div className="muted" style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Responsibilities
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
              {t.responsibilities.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </>
        )}
      </Card>
      <Card title="Skills">
        <KV rows={[
          ['Required', t.required.length ? t.required.join(', ') : '—'],
          ['Preferred', t.preferred.length ? t.preferred.join(', ') : '—'],
        ]} />
      </Card>
    </div>
  );
}

function JobTitlesView() {
  const app = useApp();
  const layer = useLayer();
  const [f, setF] = useState<JobTitleFilter>({});

  const { data: rows = [], loading, error } = useJobTitles(f);
  const { data: all = [] } = useJobTitles({});
  const setStatus = useSetJobTitleStatus();
  const remove = useDeleteJobTitle();

  /* An employee gets their own record, not the catalogue. */
  if (app.role === 'employee') return <MyTitle />;

  if (error) {
    return (
      <Card title="Job titles">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const canWrite = app.role === 'admin';

  const act = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); app.toast(done, 'ok'); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  const openForm = (t?: JobTitle) => layer.drawer({
    title: t ? 'Edit job title' : 'Add job title',
    sub: t?.n ?? 'A new position in the catalogue',
    body: (close) => <TitleForm existing={t} close={close} />,
    footer: null,
  });

  const openDetail = (t: JobTitle) => layer.drawer({
    title: t.n,
    sub: `${t.code} · ${deptOf(t.dept).name}`,
    body: <TitleDetail id={t.id} />,
  });

  const exportCsv = () => downloadCSV('job_titles.csv', [
    ['Job Title', 'Job Code', 'Department', 'Job Family', 'Level', 'Employment Type',
      'Employees', 'Open Positions', 'Status', 'Created'],
    ...rows.map((r) => [
      r.title.n, r.title.code, deptOf(r.title.dept).name, r.title.family,
      r.title.level, r.title.empType, r.employees, r.openPositions,
      r.title.status, r.title.createdOn,
    ]),
  ]);

  const one = (k: keyof JobTitleFilter) => (v: string) => setF({ ...f, [k]: v || undefined });
  const count = (s: JobTitleStatus) => all.filter((r) => r.title.status === s).length;
  const staffed = all.reduce((n, r) => n + r.employees, 0);

  return (
    <div className="stack">
      <PageActions>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
          <Icon n="download" size="lg" /> Export
        </button>
        {canWrite && (
          <button className="btn primary" onClick={() => openForm()}>
            <Icon n="add" size="lg" /> Add Job Title
          </button>
        )}
      </PageActions>

      <StatRow cols={4}>
        <Tile icon={<Icon n="briefcase" size="lg" />} label="Job titles"
          value={all.length} foot="In the catalogue" />
        <Tile icon={<Icon n="done" size="lg" />} label="Active"
          value={count('Active')} foot="Still hired into" />
        <Tile icon={<Icon n="people" size="lg" />} label="Employees mapped"
          value={staffed} foot="Holding a catalogued title" />
        <Tile icon={<Icon n="blocked" size="lg" />} label="Retired"
          value={count('Inactive') + count('Archived')} foot="No longer hired into" />
      </StatRow>

      <div className="toolbar">
        <div className="gsearch" style={{ width: 250, flex: '0 0 auto' }}>
          <span className="gsearch-ic" aria-hidden="true"><Icon n="search" /></span>
          <input className="gsearch-in" type="search" value={f.q ?? ''}
            placeholder="Title, code or skill…" aria-label="Search job titles"
            onChange={(e) => one('q')(e.target.value)} />
        </div>
        <select className="input sm" value={f.dept ?? ''} aria-label="Department"
          onChange={(e) => one('dept')(e.target.value)}>
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="input sm" value={f.family ?? ''} aria-label="Job family"
          onChange={(e) => one('family')(e.target.value)}>
          <option value="">All families</option>
          {sortBy(uniq(all.map((r) => r.title.family)), (x) => x)
            .map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <select className="input sm" value={f.level ?? ''} aria-label="Level"
          onChange={(e) => one('level')(e.target.value)}>
          <option value="">All levels</option>
          {JOB_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.n}</option>)}
        </select>
        <select className="input sm" value={f.status ?? ''} aria-label="Status"
          onChange={(e) => one('status')(e.target.value)}>
          <option value="">All statuses</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="Archived">Archived</option>
        </select>
        <div className="spacer" />
        {Object.values(f).some(Boolean) && (
          <button className="btn sm" onClick={() => setF({})}>Reset</button>
        )}
      </div>

      <Card title="Job titles" sub={`${rows.length} of ${all.length}`} flush>
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Job title</th><th>Code</th><th>Department</th><th>Family</th>
                  <th>Level</th><th>Type</th>
                  <th className="num">Employees</th><th className="num">Open</th>
                  <th>Status</th><th>Created</th><th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ title: t, employees, openPositions }) => (
                  <tr key={t.id}>
                    <td>
                      <div style={{ fontWeight: 650, fontSize: 13 }}>{t.n}</div>
                      {t.desc && (
                        <div className="muted" style={{ fontSize: 11.5, maxWidth: 260 }}>
                          {t.desc.slice(0, 64)}{t.desc.length > 64 ? '…' : ''}
                        </div>
                      )}
                    </td>
                    <td className="mono nowrap">{t.code}</td>
                    <td className="nowrap">{deptOf(t.dept).name}</td>
                    <td className="nowrap">{t.family}</td>
                    <td className="nowrap">{t.level}</td>
                    <td className="nowrap">{t.empType}</td>
                    <td className="num strong">{employees}</td>
                    <td className="num">{openPositions || '—'}</td>
                    <td><StatusBadge s={t.status} /></td>
                    <td className="nowrap muted">{fmtD(t.createdOn)}</td>
                    <td className="right nowrap">
                      <button className="btn ghost sm" onClick={() => openDetail(t)}>View</button>
                      {canWrite && (
                        <>
                          <button className="btn ghost sm" onClick={() => openForm(t)}>Edit</button>
                          <Menu label={`More actions for ${t.n}`}
                            icon={<Icon n="more" size="lg" />} width={220}>
                            {(close) => (
                              <>
                                {t.status === 'Active' ? (
                                  <button className="menu-row" onClick={() => {
                                    close();
                                    act(() => setStatus.mutate(t.id, 'Inactive'),
                                      'Job title retired');
                                  }}>
                                    <span className="gs-ic"><Icon n="blocked" /></span> Deactivate
                                  </button>
                                ) : (
                                  <button className="menu-row" onClick={() => {
                                    close();
                                    act(() => setStatus.mutate(t.id, 'Active'), 'Job title reactivated');
                                  }}>
                                    <span className="gs-ic"><Icon n="done" /></span> Activate
                                  </button>
                                )}
                                <button className="menu-row" onClick={() => {
                                  close();
                                  act(() => setStatus.mutate(t.id, 'Archived'), 'Job title archived');
                                }}>
                                  <span className="gs-ic"><Icon n="box" /></span> Archive
                                </button>
                                <div className="menu-sep" />
                                <button className="menu-row" onClick={() => {
                                  close();
                                  act(() => remove.mutate(t.id), 'Job title deleted');
                                }}>
                                  <span className="gs-ic"><Icon n="remove" /></span> Delete
                                </button>
                              </>
                            )}
                          </Menu>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Icon n="briefcase" size="xl" />}
            msg={loading
              ? 'Loading the catalogue…'
              : all.length
                ? 'No job titles match this filter'
                : 'No job titles yet — add the first one'}
          />
        )}
      </Card>
    </div>
  );
}

registerModule({
  key: 'jobtitles',
  title: TITLES.jobtitles,
  Component: JobTitlesView,
});

export { JobTitlesView };
export { Avatar };
