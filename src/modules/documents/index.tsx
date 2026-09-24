import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { fmtD, monthKey, TODAY } from '../../lib/dates';
import { pct } from '../../lib/format';


import { deptOf } from '../../data/org';
import { LETTER_TYPES } from '../../data/letters';
import { HBar, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Badge, Banner, Card, EmptyState, PersonCell, Table, TableWrap, Tabs, Tile, StatRow } from '../../components/ui';
import { notBacked } from '../../components/NotBacked';
import { Chip, ListRow } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { DocumentCollection } from './collection';
import { useShowLetter } from './Letter';
import { RequestLetterForm } from './RequestLetter';
import {
  useAllEmployees, useDocuments, useDocumentTypes, useIssueLetter, useLetterRequests,
  useLetterTypes, useRejectLetter, useVisiblePeople,
} from './data';
import { Icon } from '../../components/icons';

type Tab = 'gen' | 'mine' | 'queue' | 'repo';

const letterName = (id: string) => LETTER_TYPES.find((t) => t.id === id)?.n || id;

/** Documents an employee can upload themselves, outside the HR-issued set. */

/** Document types this person has not filed, over rows already fetched. */
const missingFor = (empId: string, types: string[], docs: { empId: string; type: string }[]) =>
  types.filter((t) => !docs.some((d) => d.empId === empId && d.type === t));

/* ---------- Generate / request ---------- */

function GenTab() {
  const app = useApp();
  const showLetter = useShowLetter();
  const dir = useVisiblePeople();
  const [forId, setForId] = useState(app.meId);
  const target = app.role === 'employee' ? app.meId : forId;

  return (
    <div className="stack">
      <Banner kind="info" icon={<Icon n="document" size="lg" />} title="Self-service letters">
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
            {sortBy(dir.list, (e) => e.name).map((e) => (
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
  const layer = useLayer();
  const { data: docs = [] } = useDocuments([app.meId]);
  const { data: allReqs = [] } = useLetterRequests();
  const { data: types = [] } = useLetterTypes();
  const reqs = allReqs.filter((l) => l.empId === app.meId);

  const askForLetter = () => layer.modal({
    title: 'Request a letter',
    sub: 'Instant letters are generated straight away',
    size: 'narrow',
    body: (close: () => void) => <RequestLetterForm close={close} types={types} />,
    footer: null,
  });

  return (
    <div className="stack">
      <div className="grid g2">
        <Card title="Employment documents" sub={`${docs.length} on file`} flush>
          {docs.length ? (
            docs.map((d) => (
              <ListRow key={d.id}>
                <span><Icon n="document" size="lg" /> </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{d.type}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>Uploaded {fmtD(d.on)}</div>
                </div>
                <Badge kind={d.verified ? 'good' : 'warn'}>{d.verified ? 'Verified' : 'Pending'}</Badge>
                <button className="btn sm ghost"
                  {...notBacked('the repository records that a document exists; the file itself is not stored yet')}
                >⤓</button>
              </ListRow>
            ))
          ) : (
            <EmptyState msg="No documents on file" />
          )}
        </Card>

        <Card title="My letter requests" sub={`${reqs.length} requests`} flush
          actions={
            <button className="btn sm primary" onClick={askForLetter}><Icon n="add" size="lg" /> Request a letter</button>
          }>
          {reqs.length ? (
            reqs.map((l) => (
              <ListRow key={l.id}>
                <span><Icon n="mail" size="lg" /> ️</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{letterName(l.type)}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {l.status === 'Rejected' && l.declineReason
                      ? l.declineReason
                      : l.reference
                        ? `${l.reference} · issued ${fmtD(l.issuedOn!)}`
                        : `${l.purpose || 'No purpose given'} · requested ${fmtD(l.requestedOn)}`}
                  </div>
                </div>
                <Badge kind={l.status === 'Issued' ? 'good' : l.status === 'Rejected' ? 'crit' : 'warn'}>
                  {l.status}
                </Badge>
              </ListRow>
            ))
          ) : (
            <EmptyState msg="No requests yet" icon={<Icon n="mail" size="lg" />} />
          )}
        </Card>
      </div>

      <Card title="Documents HR asks for" sub="What is outstanding, and what has been checked">
        <DocumentCollection scope={{ empId: app.meId }} />
        <Banner kind="info" icon={<Icon n="attachment" size="lg" />} title="Attachments are not stored yet">
          HR tracks what has been received and verified here. Handing the file over
          still happens outside the system — there is no document storage in this
          deployment, and a button claiming to keep your degree certificate would
          be lying about where it went.
        </Banner>
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
  const rejectLetter = useRejectLetter();
  const pend = LETTER_REQS.filter((l) => l.status === 'Pending');
  const thisMonth = LETTER_REQS.filter((l) => l.issuedOn && monthKey(l.issuedOn) === monthKey(TODAY)).length;

  const markIssued = async (id: string) => {
    try {
      const done = await issueLetter.mutate(id);
      app.toast(done.reference ? `Letter issued · ${done.reference}` : 'Letter issued', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not issue the letter', 'err');
    }
  };

  /*
   * A refusal the employee can act on. Prompting rather than a silent reject:
   * the reason is shown to them, and the service refuses an empty one.
   */
  const refuse = async (id: string) => {
    const reason = window.prompt('Why is this being refused? The employee sees this.');
    if (reason === null) return;
    try {
      await rejectLetter.mutate(id, reason);
      app.toast('Request refused', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not refuse the request', 'err');
    }
  };

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Pending requests" value={pend.length} foot="Awaiting HR issue" />
        <Tile label="Issued this month" value={thisMonth} foot="Letters generated" />
        <Tile label="Avg turnaround" value="1.8 days" foot="Against a 2-day SLA" />
        <Tile label="Self-service share" value="68%" foot="Letters generated without HR" />
      </StatRow>

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
                  <td>
                    {l.purpose || <span className="muted">—</span>}
                    {l.status === 'Rejected' && l.declineReason && (
                      <div className="muted" style={{ fontSize: 11.5 }}>Refused: {l.declineReason}</div>
                    )}
                  </td>
                  <td className="nowrap">{fmtD(l.requestedOn)}</td>
                  <td>
                    <Badge kind={l.status === 'Issued' ? 'good' : l.status === 'Rejected' ? 'crit' : 'warn'}>
                      {l.status}
                    </Badge>
                    {l.reference && (
                      <div className="mono muted" style={{ fontSize: 10.5 }}>{l.reference}</div>
                    )}
                  </td>
                  <td className="right nowrap">
                    {l.status === 'Pending' ? (
                      <>
                        <button className="btn sm" onClick={() => refuse(l.id)}>Refuse</button>{' '}
                        <button className="btn sm primary" onClick={() => markIssued(l.id)}>Issue</button>
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
  const showEmp = useShowEmployee();
  const { data: DOCS = [] } = useDocuments();
  const { data: DOC_TYPES = [] } = useDocumentTypes();
  const { data: everyone = [] } = useAllEmployees();
  const byType: HBarRow[] = DOC_TYPES.map((t, i) => ({ k: t, c: PAL[i % 8], v: DOCS.filter((d) => d.type === t).length }));
  const missing = everyone.filter((e) => missingFor(e.id, DOC_TYPES, DOCS).length > 2);
  const verified = DOCS.filter((d) => d.verified).length;

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Documents on file" value={DOCS.length.toLocaleString('en-IN')} foot={`Across ${everyone.length} employees`} />
        <Tile label="Verified" value={pct(verified, Math.max(1, DOCS.length)) + '%'} foot={`${DOCS.length - verified} pending verification`} />
        <Tile label="Incomplete files" value={missing.length} foot="Missing 3 or more documents" />
        <Tile label="Retention policy" value="7 years" foot="After the last working day" />
      </StatRow>

      <div className="grid g-2-1">
        <Card
          title="Employees with missing documents"
          sub={`${missing.length} people`}
          actions={
            <button className="btn sm"
              {...notBacked('there is no path from here to the mail server yet')}
            >
              <Icon n="mail" size="lg" /> Send reminders
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
  Component: DocumentsView,
});
