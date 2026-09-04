import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { sum } from '../../lib/collections';
import { fmtD, tenure, yearsSince } from '../../lib/dates';
import { inr, pct } from '../../lib/format';
import { countryOf, mbS, money, toBase } from '../../data/countries';
import { deptOf, GRADES, siteOf } from '../../data/org';
import type { EmployeeProfile } from '../../services';
import { getServices } from '../../services';
import { useProfile } from './data';
import { Avatar, Badge, Banner, KV } from '../../components/ui';
import { Chip, ListRow, StatusBadge } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h4 style={{ margin: '0 0 8px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink-3)' }}>
      {children}
    </h4>
  );
}

function MiniTile({ label, value, foot }: { label: string; value: React.ReactNode; foot?: string }) {
  return (
    <div className="tile">
      <div className="lbl">{label}</div>
      <div className="val" style={{ fontSize: 19 }}>{value}</div>
      {foot && <div className="foot">{foot}</div>}
    </div>
  );
}

function ProfileBody({ id, jump }: { id: string; jump: (nextId: string) => void }) {
  const { data: p } = useProfile(id);
  if (!p) return <div className="muted">Loading profile…</div>;
  return <ProfileView p={p} jump={jump} />;
}

function ProfileView({ p, jump }: { p: EmployeeProfile; jump: (id: string) => void }) {
  const app = useApp();
  const e = p.employee;
  const isSelf = e.id === app.meId;

  /* compensation is HR-and-self only; personal details also open to the line manager */
  const canSeeComp = app.role === 'admin' || isSelf;
  const canSeePersonal = canSeeComp || (app.role === 'manager' && app.isMyReport(e.id));

  const s = p.salary;
  const ctry = countryOf(e.country);
  const m = (a: number) => money(a, e.ccy);

  const recs = p.attendanceThisMonth;
  const present = recs.filter((r) => r.status === 'P' || r.status === 'W').length;
  const work = recs.filter((r) => ['P', 'W', 'A', 'L'].includes(r.status)).length;

  const bals = p.leaveBalances.filter((b) => b.quota + b.carry > 0);
  const assets = p.assets;
  const docs = p.documents;
  const reports = p.reports;
  const myGoals = p.goals;
  const myClaims = p.claims;
  const myTickets = p.tickets;
  const loans = p.loans;
  const ex = p.exit;

  /* national identifiers differ by country — show whichever this person has */
  const ids: [string, string | null | undefined][] = [
    ['PAN', e.pan], ['UAN', e.uan], ['PF number', e.pf], ['ESI number', e.esi],
    ['SSN', e.ssn], ['SIN', e.sin], ['National Insurance No.', e.nino], ['Emirates ID', e.eid],
  ];

  return (
    <>
      <div className="row" style={{ gap: 14, marginBottom: 16 }}>
        <Avatar name={e.name} size="xl" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 750, letterSpacing: '-.4px' }}>{e.name}</div>
          <div className="muted" style={{ fontSize: 13 }}>{e.designation}</div>
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            <StatusBadge status={e.status} />
            <Chip>{deptOf(e.dept).name}</Chip>
            <Chip>{GRADES[e.grade].label}</Chip>
            {e.probation && <Badge kind="warn">On probation</Badge>}
          </div>
        </div>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <MiniTile label="Tenure" value={tenure(e.doj)} />
        <MiniTile label="Attendance" value={pct(present, Math.max(1, work)) + '%'} />
        <MiniTile label="Leave left" value={sum(bals, (b) => b.avail).toFixed(0) + ' d'} />
      </div>

      <SectionHead>Work</SectionHead>
      <div style={{ marginBottom: 16 }}>
        <KV rows={[
          ['Employee code', <span className="mono">{e.code}</span>],
          ['Department', deptOf(e.dept).name],
          ['Reporting to', e.managerId
            ? <a onClick={() => jump(e.managerId!)} style={{ cursor: 'pointer' }}>{p.managerName}</a>
            : '—'],
          ['Location', `${siteOf(e.site).name} · ${ctry.flag} ${ctry.name}`],
          ['Legal entity', ctry.entity],
          ['Shift', e.shift],
          ['Employment type', e.empType],
          ['Date of joining', fmtD(e.doj)],
          ...(e.dol ? [['Last working day', `${fmtD(e.dol)} · ${e.exitReason || ''}`] as [string, string]] : []),
          ['Work email', <a href={'mailto:' + e.email}>{e.email}</a>],
          ['Skills', <>{e.skills.map((sk) => <Chip key={sk}>{sk}</Chip>)}</>],
        ]} />
      </div>

      {canSeePersonal && (
        <>
          <SectionHead>Personal</SectionHead>
          <div style={{ marginBottom: 16 }}>
            <KV rows={[
              ['Date of birth', `${fmtD(e.dob)} (${yearsSince(e.dob)} yrs)`],
              ['Gender', e.gender === 'F' ? 'Female' : 'Male'],
              ['Blood group', e.blood],
              ['Mobile', <span className="mono">{e.phone}</span>],
              ['Address', e.address],
              ['Emergency contact', e.emergency],
            ]} />
          </div>
        </>
      )}

      {canSeeComp ? (
        <>
          <SectionHead>Compensation &amp; statutory</SectionHead>
          <div style={{ marginBottom: 16 }}>
            <KV rows={[
              [ctry.wage, <><b>{m(e.ctc)}</b> <span className="muted">({e.ccy} · {mbS(toBase(e.ctc, e.ccy))} base)</span></>],
              ['Monthly gross', m(s.grossA / 12)],
              [e.country === 'IN' ? 'Basic / HRA' : 'Basic / allowances',
                `${m(p.compMonthly.basic)} / ${m(p.compMonthly.allowance)} per month`],
              ...ids.filter(([, v]) => v).map(([k, v]) => [k, <span className="mono">{v}</span>] as [string, React.ReactNode]),
              ...(e.workAuth ? [['Work authorisation', e.workAuth] as [string, React.ReactNode]] : []),
              ['Bank', `${e.bank} · ${e.acct} · ${e.ifsc}`],
              ['Tax regime', `${p.taxRegime} · ${p.taxStatus}`],
            ]} />
          </div>
        </>
      ) : (
        <>
          <Banner icon="🔒">Compensation details are visible to HR administrators and the employee only.</Banner>
          <div style={{ height: 16 }} />
        </>
      )}

      {reports.length > 0 && (
        <>
          <SectionHead>Direct reports ({reports.length})</SectionHead>
          <div style={{ marginBottom: 16 }}>
            {reports.map((r) => (
              <ListRow key={r.id} onClick={() => jump(r.id)} style={{ padding: '8px 0' }}>
                <Avatar name={r.name} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{r.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{r.designation}</div>
                </div>
              </ListRow>
            ))}
          </div>
        </>
      )}

      <SectionHead>Career timeline</SectionHead>
      <div className="tl" style={{ marginBottom: 16 }}>
        {p.lifecycle.map((ev, i) => (
          <div key={i} className={'tl-i ' + (ev.type === 'Promotion' ? 'alt' : ev.type === 'Salary Revision' ? '' : 'warn')}>
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>{ev.type}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{fmtD(ev.on)} · {ev.note}</div>
            {(ev.from || ev.to) && (
              <div style={{ fontSize: 12, marginTop: 2 }}>
                {ev.from ? ev.from + ' → ' : ''}<b>{ev.to || ''}</b>
              </div>
            )}
          </div>
        ))}
      </div>

      {(app.role !== 'employee' || isSelf) && (
        <>
          <SectionHead>Across the system</SectionHead>
          <div className="grid g3" style={{ marginBottom: 16 }}>
            <MiniTile label="Goals"
              value={Math.round(sum(myGoals, (g) => g.progress * g.weight) / Math.max(1, sum(myGoals, (g) => g.weight))) + '%'}
              foot={`${myGoals.length} goals`} />
            <MiniTile label="Learning" value={p.coursesCompleted} foot="courses done" />
            <MiniTile label="Praise" value={p.praiseReceived} foot="recognitions" />
          </div>
          {(myClaims.length > 0 || myTickets.length > 0 || loans.length > 0) && (
            <div className="row wrap" style={{ gap: 7, marginBottom: 16 }}>
              {myClaims.length > 0 && <Chip>🧾 {myClaims.length} expense claims</Chip>}
              {myTickets.length > 0 && <Chip>🎫 {myTickets.length} helpdesk tickets</Chip>}
              {loans.length > 0 && <Chip>🏦 {inr(sum(loans, (l) => l.outstanding))} loan outstanding</Chip>}
              {ex && <Badge kind="warn">Serving notice · LWD {fmtD(ex.lwd)}</Badge>}
            </div>
          )}
        </>
      )}

      <SectionHead>Assets issued ({assets.length})</SectionHead>
      <div style={{ marginBottom: 16 }}>
        {assets.length ? assets.map((a) => (
          <ListRow key={a.id} style={{ padding: '8px 0' }}>
            <span>💻</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650, fontSize: 12.5 }}>{a.type}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>{a.serial} · issued {fmtD(a.issued)}</div>
            </div>
            <Badge kind="good">{a.status}</Badge>
          </ListRow>
        )) : <div className="muted">No assets issued</div>}
      </div>

      {canSeePersonal && (
        <>
          <SectionHead>Documents ({docs.length})</SectionHead>
          <div>
            {docs.map((d) => (
              <ListRow key={d.id} style={{ padding: '8px 0' }}>
                <span>📄</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{d.type}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>Uploaded {fmtD(d.on)}</div>
                </div>
                <Badge kind={d.verified ? 'good' : 'warn'}>{d.verified ? 'Verified' : 'Pending'}</Badge>
              </ListRow>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Opens the employee profile drawer. Shared across modules — anywhere a person
 * is listed, clicking through lands here.
 */
export function useShowEmployee() {
  const layer = useLayer();
  const app = useApp();
  const nav = useNavigate();

  /* The header needs the person before the drawer opens, so resolve them first
     — the body then fetches the rest of the profile on its own. */
  const show = useCallback(
    async (id: string) => {
      const e = await getServices().employees.byId(id);
      if (!e) return;
      layer.drawer({
        title: e.name,
        sub: e.designation + ' · ' + e.code,
        body: <ProfileBody id={id} jump={show} />,
        footer: (close) => (
          <>
            <button className="btn" onClick={close}>Close</button>
            {app.role !== 'employee' && (
              <button className="btn" onClick={() => { close(); nav('/attendance'); }}>Attendance</button>
            )}
          </>
        ),
      });
    },
    [layer, app.role, nav],
  );

  return show;
}
