import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { fmtD, monthKey, TODAY } from '../../lib/dates';
import { pct } from '../../lib/format';


import { deptOf } from '../../data/org';
import { LETTER_TYPES } from '../../data/letters';
import { HBar, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Badge, Banner, Card, EmptyState, PersonCell, Table, TableWrap, Tabs, Tile } from '../../components/ui';
import { Chip, ListRow } from '../../components/common';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useShowLetter } from './Letter';
import {
  useAllEmployees, useDocuments, useDocumentTypes, useIssueLetter, useLetterRequests,
  useVisiblePeople,
} from './data';

type Tab = 'gen' | 'mine' | 'queue' | 'repo';

const letterName = (id: string) => LETTER_TYPES.find((t) => t.id === id)?.n || id;

/** Documents an employee can upload themselves, outside the HR-issued set. */
const UPLOADABLE = ['PAN Card', 'Aadhaar', 'Passport', 'Degree Certificate', 'Previous Relieving Letter', 'Address Proof'];

/** Document types this person has not filed, over rows already fetched. */
const missingFor = (empId: string, types: string[], docs: { empId: string; type: string }[]) =>
  types.filter((t) => !docs.some((d) => d.empId === empId && d.type === t));

/* ---------- Generate / request ---------- */

function GenTab() {
  const app = useApp();
  const showLetter = useShowLetter();
  const [forId, setForId] = useState(app.meId);
  const target = app.role === 'employee' ? app.meId : forId;

  return (
    <div className="stack">
      <Banner kind="info" icon="📄" title="Self-service letters">
        Letters marked “instant” are generated immediately with your live employment data and a digital signature.
        Others go to HR and are usually issued within 2–3 working days.
      </Banner>

      {app.role !== 'employee' && (
        <div className="toolbar">
          <label style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--ink-2)' }}>Generate for</label>
          <select
            className="input"
            style={{ width: 'auto', maxWidth: 340 }}
            value={forId}
            onChange={(ev) => setForId(ev.target.value)}
          >
            {sortBy(app.visibleEmps(), (e) => e.name).map((e) => (
              <option key={e.id} value={e.id}>{e.name} — {e.code}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))' }}>
        {LETTER_TYPES.map((t) => (
          <Card key={t.id}>
            <div className="row" style={{ gap: 9, marginBottom: 8 }}>
              <div style={{ fontSize: 20 }}>📄</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t.n}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{t.self ? 'Instant' : 'HR issued · ' + t.sla}</div>
              </div>
              <Badge kind={t.self ? 'good' : 'info'}>{t.self ? 'Instant' : 'Request'}</Badge>
            </div>
            <div className="muted" style={{ fontSize: 12.5, minHeight: 38 }}>{t.d}</div>
            <button
              className={'btn sm' + (t.self ? ' primary' : '')}
              style={{ width: '100%', marginTop: 10, justifyContent: 'center' }}
              onClick={() => showLetter(t.id, target)}
            >
              {t.self ? 'Generate now' : 'Request'}
            </button>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ---------- My documents ---------- */

function MineTab() {
  const app = useApp();
  const { data: docs = [] } = useDocuments([app.meId]);
  const { data: allReqs = [] } = useLetterRequests();
  const reqs = allReqs.filter((l) => l.empId === app.meId);

  return (
    <div className="stack">
      <div className="grid g2">
        <Card title="Employment documents" sub={`${docs.length} on file`} flush>
          {docs.length ? (
            docs.map((d) => (
              <ListRow key={d.id}>
                <span>📄</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{d.type}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>Uploaded {fmtD(d.on)}</div>
                </div>
                <Badge kind={d.verified ? 'good' : 'warn'}>{d.verified ? 'Verified' : 'Pending'}</Badge>
                <button className="btn sm ghost" onClick={() => app.toast(d.type + ' downloaded', 'ok')}>⤓</button>
              </ListRow>
            ))
          ) : (
            <EmptyState msg="No documents on file" />
          )}
        </Card>

        <Card title="My letter requests" sub={`${reqs.length} requests`} flush>
          {reqs.length ? (
            reqs.map((l) => (
              <ListRow key={l.id}>
                <span>✉️</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{letterName(l.type)}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{l.purpose} · requested {fmtD(l.requestedOn)}</div>
                </div>
                <Badge kind={l.status === 'Issued' ? 'good' : 'warn'}>{l.status === 'Issued' ? 'Issued' : 'Pending'}</Badge>
              </ListRow>
            ))
          ) : (
            <EmptyState msg="No requests yet" icon="✉️" />
          )}
        </Card>
      </div>

      <Card title="Upload a document" sub="Certificates, proofs and personal records">
        <div className="grid g3">
          {UPLOADABLE.map((d) => (
            <div key={d} style={{ cursor: 'pointer' }} onClick={() => app.toast(d + ' uploaded — pending HR verification', 'ok')}>
              <Banner icon="📎" title={d}>
                <span className="muted" style={{ fontSize: 11.5 }}>Click to upload · PDF or image</span>
              </Banner>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------- HR letter queue ---------- */

function QueueTab() {
  const app = useApp();
  const showLetter = useShowLetter();
  const { data: LETTER_REQS = [] } = useLetterRequests();
  const dir = useVisiblePeople();
  const issueLetter = useIssueLetter();
  const pend = LETTER_REQS.filter((l) => l.status === 'Pending');
  const thisMonth = LETTER_REQS.filter((l) => l.issuedOn && monthKey(l.issuedOn) === monthKey(TODAY)).length;

  const markIssued = async (id: string) => {
    try {
      await issueLetter.mutate(id);
      app.toast('Letter issued and emailed to the employee', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not issue the letter', 'err');
    }
  };

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Pending requests" value={pend.length} foot="Awaiting HR issue" />
        <Tile label="Issued this month" value={thisMonth} foot="Letters generated" />
        <Tile label="Avg turnaround" value="1.8 days" foot="Against a 2-day SLA" />
        <Tile label="Self-service share" value="68%" foot="Letters generated without HR" />
      </div>

      <Card title="Letter requests" sub={`${LETTER_REQS.length} total`} flush>
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Request</th><th>Employee</th><th>Letter</th><th>Purpose</th>
                <th>Requested</th><th>Status</th><th className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortBy(LETTER_REQS, (l) => l.requestedOn, 'desc').map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.id}</td>
                  <td>{dir.byId(l.empId) && <PersonCell e={dir.byId(l.empId)!} />}</td>
                  <td>{letterName(l.type)}</td>
                  <td>{l.purpose}</td>
                  <td className="nowrap">{fmtD(l.requestedOn)}</td>
                  <td><Badge kind={l.status === 'Issued' ? 'good' : 'warn'}>{l.status === 'Issued' ? 'Issued' : 'Pending'}</Badge></td>
                  <td className="right nowrap">
                    {l.status === 'Pending' ? (
                      <>
                        <button className="btn sm primary" onClick={() => showLetter(l.type, l.empId)}>Generate</button>{' '}
                        <button className="btn sm" onClick={() => markIssued(l.id)}>Mark issued</button>
                      </>
                    ) : (
                      <button className="btn sm" onClick={() => showLetter(l.type, l.empId)}>View</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>
    </div>
  );
}

/* ---------- Document repository ---------- */

function RepoTab() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const { data: DOCS = [] } = useDocuments();
  const { data: DOC_TYPES = [] } = useDocumentTypes();
  const { data: everyone = [] } = useAllEmployees();
  const byType: HBarRow[] = DOC_TYPES.map((t, i) => ({ k: t, c: PAL[i % 8], v: DOCS.filter((d) => d.type === t).length }));
  const missing = everyone.filter((e) => missingFor(e.id, DOC_TYPES, DOCS).length > 2);
  const verified = DOCS.filter((d) => d.verified).length;

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Documents on file" value={DOCS.length.toLocaleString('en-IN')} foot={`Across ${everyone.length} employees`} />
        <Tile label="Verified" value={pct(verified, Math.max(1, DOCS.length)) + '%'} foot={`${DOCS.length - verified} pending verification`} />
        <Tile label="Incomplete files" value={missing.length} foot="Missing 3 or more documents" />
        <Tile label="Retention policy" value="7 years" foot="After the last working day" />
      </div>

      <div className="grid g-2-1">
        <Card
          title="Employees with missing documents"
          sub={`${missing.length} people`}
          actions={
            <button className="btn sm" onClick={() => app.toast('Reminder emails sent to employees with incomplete files', 'ok')}>
              📧 Send reminders
            </button>
          }
          flush
        >
          <div style={{ maxHeight: 520, overflow: 'auto' }}>
            <TableWrap>
              <Table>
                <thead>
                  <tr><th>Employee</th><th>Department</th><th>Joined</th><th>Missing</th></tr>
                </thead>
                <tbody>
                  {missing.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => showEmp(e.id)}>
                      <td><PersonCell e={e} /></td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td className="nowrap">{fmtD(e.doj)}</td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                          {missingFor(e.id, DOC_TYPES, DOCS).map((t) => <Chip key={t}>{t}</Chip>)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        </Card>

        <Card title="Documents by type" sub="Coverage across the organisation">
          <HBar rows={sortBy(byType, (r) => -r.v)} />
        </Card>
      </div>
    </div>
  );
}

/* ---------- Shell ---------- */

const EMPLOYEE_TABS: { v: Tab; label: string }[] = [
  { v: 'gen', label: 'Request a Letter' },
  { v: 'mine', label: 'My Documents' },
];

const HR_TABS: { v: Tab; label: string }[] = [
  { v: 'gen', label: 'Generate a Letter' },
  { v: 'mine', label: 'My Documents' },
  { v: 'queue', label: 'Letter Requests' },
  { v: 'repo', label: 'Document Repository' },
];

const BODIES: Record<Tab, () => React.JSX.Element> = { gen: GenTab, mine: MineTab, queue: QueueTab, repo: RepoTab };

function DocumentsView() {
  const app = useApp();
  const tabs = app.role === 'employee' ? EMPLOYEE_TABS : HR_TABS;
  const [tab, setTab] = useState<Tab>('gen');

  /* A role switch can take the open tab away. */
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;
  const Body = BODIES[active];

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      <Body />
    </>
  );
}

registerModule({
  key: 'documents',
  title: TITLES.documents,
  /* Static: the registry's callbacks are synchronous and cannot await. */
  subtitle: () => 'Self-service letters and the document repository',
  Component: DocumentsView,
});
