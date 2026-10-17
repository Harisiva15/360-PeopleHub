/**
 * One person's working pattern, and the history of it.
 *
 * Lives in the lifecycle drawer because that is already where somebody's record
 * is read and changed — their stage, their tasks, their history. A schedule is
 * another effective-dated fact about them, so it belongs beside those rather than
 * in a screen of its own.
 *
 * ## `valid_to` is inclusive, and the UI says so
 *
 * Migration 0054 chose inclusive bounds, deliberately differing from the half-open
 * ranges in 0048. So 15 October to 16 October are adjacent periods, not
 * overlapping ones, and the wording here is "through" rather than "until" — an
 * off-by-one in a reader's head is as expensive as one in the code.
 *
 * ## Nothing here decides anything
 *
 * Supersession, overlap, backdating into a settled period, exited employees,
 * inactive patterns — every one of those rules is in
 * `server/src/modules/schedules/service.ts`, and this screen's job is to send the
 * request and show what came back. In particular it does **not** reimplement the
 * same-day amend: when a change starts on the day the open period began, the
 * service amends that period rather than writing a zero-day row, and this simply
 * renders the state it returns.
 *
 * The one thing the form does prevent is the obvious overlap — a start date at or
 * before the open period's start — because being told that after pressing Save is
 * a worse experience than not being offered it. The service still checks.
 *
 * ## "Not assigned" is a real answer
 *
 * Phase 2h-E deliberately does not default an unassigned employee onto the
 * tenant's `DEFAULT_MF` row; it answers from a constant Monday-to-Friday rule and
 * reports `schedule: null`. So this screen says "Not assigned" and explains what
 * happens in the meantime, rather than naming a pattern nobody put them on.
 */

import { useState } from 'react';
import { Badge, Banner, Card, EmptyState } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useApp } from '../../state/AppContext';
import { useLayer } from '../../components/Layer';
import { fmtD, TODAY, ymd } from '../../lib/dates';
import type { EmployeeSchedule } from '../../services';
import {
  useAssignEmployeeSchedule, useCloseEmployeeSchedule, useEmployeeSchedules,
  useWorkSchedules,
} from './data';

/** The open period, if there is one. At most one can exist. */
const openOf = (rows: EmployeeSchedule[]) => rows.find((r) => r.validTo === null) ?? null;

/** The period covering today, which is what "current" means to a reader. */
function currentOf(rows: EmployeeSchedule[]): EmployeeSchedule | null {
  const today = ymd(TODAY);
  return rows.find((r) => r.validFrom <= today && (r.validTo === null || today <= r.validTo))
    ?? null;
}

function AssignForm(
  { empId, rows, close, done }: {
    empId: string; rows: EmployeeSchedule[]; close: () => void; done: () => void;
  },
) {
  const app = useApp();
  const { data: patterns = [] } = useWorkSchedules();
  const assign = useAssignEmployeeSchedule();

  const open = openOf(rows);
  const [code, setCode] = useState('');
  const [from, setFrom] = useState(ymd(TODAY));
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);

  /* Only patterns the service would accept for a new assignment. */
  const offerable = patterns.filter((p) => p.active);

  /*
   * The one overlap the form can see without guessing at the service's rules: a
   * start on or before the open period's own start. Everything subtler — a
   * settled period, a concurrent write — is the service's to refuse, and it does.
   */
  const backdated = open && from && from < open.validFrom
    ? `${open.scheduleCode} already runs from ${fmtD(open.validFrom)}. A new period must`
      + ' start on or after that date.'
    : null;
  const reversed = to && to < from ? 'The end date cannot be before the start date.' : null;
  const bad = backdated ?? reversed;

  return (
    <div className="stack" style={{ gap: 13 }}>
      {open && (
        <Banner kind="info" icon={<Icon n="schedule" size="lg" />} title="Currently">
          {open.scheduleName} ({open.scheduleCode}) from {fmtD(open.validFrom)}, open-ended.
          Starting a new period on {fmtD(open.validFrom)} replaces it; any later date
          closes it the day before.
        </Banner>
      )}

      <div className="field">
        <label htmlFor="asg-code">Work schedule<span className="req">*</span></label>
        <select id="asg-code" className="input" value={code}
          onChange={(e) => setCode(e.target.value)}>
          <option value="">Choose a pattern…</option>
          {offerable.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name} ({p.days.filter((d) => d.working).length} days)
            </option>
          ))}
        </select>
        {!offerable.length && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            No pattern is in use. Add one under Shifts &amp; work schedules first.
          </div>
        )}
      </div>

      <div className="grid g2">
        <div className="field">
          <label htmlFor="asg-from">Effective from<span className="req">*</span></label>
          <input id="asg-from" className="input" type="date" value={from}
            aria-invalid={backdated ? true : undefined}
            aria-describedby={backdated ? 'asg-from-err' : undefined}
            onChange={(e) => setFrom(e.target.value)} />
          {backdated && (
            <div id="asg-from-err" style={{ fontSize: 11.5, color: 'var(--crit-text)' }}>
              {backdated}
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="asg-to">Effective through</label>
          <input id="asg-to" className="input" type="date" value={to}
            aria-invalid={reversed ? true : undefined}
            aria-describedby="asg-to-hint"
            onChange={(e) => setTo(e.target.value)} />
          <div className="muted" id="asg-to-hint" style={{ fontSize: 11.5 }}>
            {reversed
              ? <span style={{ color: 'var(--crit-text)' }}>{reversed}</span>
              : <>Inclusive — the pattern applies <b>on</b> this date. Leave blank for open-ended.</>}
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 9, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!code || !from || Boolean(bad) || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await assign.mutate(empId, {
                scheduleCode: code, validFrom: from, validTo: to || null,
              });
              app.toast('Working pattern assigned', 'ok');
              done();
              close();
            } catch (e) {
              /*
               * The service's own sentence. It names the clashing dates for an
               * overlap, says why a settled period is not rewritten, and refuses
               * an exited employee — none of which this form tries to restate.
               */
              app.toast(e instanceof Error ? e.message : 'Could not assign the pattern', 'err');
            } finally {
              setBusy(false);
            }
          }}>{busy ? 'Saving…' : 'Assign'}</button>
      </div>
    </div>
  );
}

export function EmployeeScheduleCard({ empId }: { empId: string }) {
  const app = useApp();
  const layer = useLayer();
  const { data: rows = [], loading, error, refetch } = useEmployeeSchedules(empId);
  const closeOne = useCloseEmployeeSchedule();

  /*
   * Who may change this is the service's decision — an admin anybody, a manager
   * their own line, an employee nobody including themselves. This only decides
   * what is offered; the call is refused either way.
   */
  const mayAssign = app.role === 'admin' || app.role === 'manager';
  const own = app.meId === empId;

  if (error) {
    return (
      <Card title="Working pattern">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const current = currentOf(rows);
  const open = openOf(rows);

  const endIt = (row: EmployeeSchedule) => {
    let on = ymd(TODAY);
    layer.modal({
      title: `End the ${row.scheduleName} period`,
      body: (
        <div className="stack" style={{ gap: 11 }}>
          <div className="field">
            <label htmlFor="end-on">Effective through</label>
            <input id="end-on" className="input" type="date" defaultValue={on}
              onChange={(e) => { on = e.target.value; }} />
            <div className="muted" style={{ fontSize: 11.5 }}>
              Inclusive — the pattern still applies on this date. Nothing replaces it,
              so from the next day they have no assigned pattern.
            </div>
          </div>
        </div>
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            try {
              await closeOne.mutate(empId, row.id, on);
              app.toast('Period ended', 'ok');
              refetch();
              close();
            } catch (e) {
              app.toast(e instanceof Error ? e.message : 'Could not end the period', 'err');
            }
          }}>End it</button>
        </>
      ),
    });
  };

  return (
    <div className="stack">
      <Card title="Working pattern"
        sub="Which days this person is expected in — the hours come from their shift"
        actions={mayAssign && !own && (
          <button className="btn sm" onClick={() => layer.modal({
            title: 'Assign a working pattern',
            size: 'wide',
            body: (close) => (
              <AssignForm empId={empId} rows={rows} close={close} done={refetch} />
            ),
          })}>
            <Icon n="add" size="lg" /> {open ? 'Change' : 'Assign'}
          </button>
        )}>
        {loading && !rows.length
          ? <EmptyState msg="Reading the pattern…" />
          : current
            ? (
              <div className="stack" style={{ gap: 7 }}>
                <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 750, fontSize: 15 }}>{current.scheduleName}</span>
                  <Badge kind="mute">{current.scheduleCode}</Badge>
                  {!current.scheduleActive && <Badge kind="warn">Pattern withdrawn</Badge>}
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  From {fmtD(current.validFrom)}
                  {current.validTo
                    ? <> through {fmtD(current.validTo)} <i>(inclusive)</i></>
                    : ' · no end date'}
                </div>
              </div>
            )
            : (
              /*
               * Not assigned, said plainly. The server answers their calendar from
               * a constant Monday-to-Friday rule in this state and reports no
               * schedule, so naming DEFAULT_MF here would claim an assignment
               * nobody made.
               */
              <div className="stack" style={{ gap: 7 }}>
                <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 750, fontSize: 15 }}>Not assigned</span>
                  <Badge kind="warn">No pattern</Badge>
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Their calendar falls back to Monday&ndash;Friday until a pattern is
                  assigned. Nothing is wrong with that, but it is an assumption rather
                  than a decision anybody recorded.
                </div>
              </div>
            )}
      </Card>

      <Card title="Pattern history" sub={`${rows.length} period${rows.length === 1 ? '' : 's'}`} flush>
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Pattern</th><th>From</th><th>Through</th><th>Status</th>
                  {mayAssign && !own && <th className="right">&nbsp;</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isCurrent = current?.id === r.id;
                  return (
                    <tr key={r.id}>
                      <td>
                        <b>{r.scheduleName}</b> <Badge kind="mute">{r.scheduleCode}</Badge>
                        {!r.scheduleActive && <> <Badge kind="mute">Withdrawn</Badge></>}
                      </td>
                      <td className="mono">{fmtD(r.validFrom)}</td>
                      <td className="mono">
                        {r.validTo
                          ? fmtD(r.validTo)
                          : <span className="muted">Current</span>}
                      </td>
                      <td>
                        {isCurrent
                          ? <Badge kind="good">Applies today</Badge>
                          : r.validTo === null
                            ? <Badge kind="info">Starts later</Badge>
                            : <Badge kind="mute">Ended</Badge>}
                      </td>
                      {mayAssign && !own && (
                        <td className="right nowrap">
                          {r.validTo === null
                            ? <button className="btn sm ghost" onClick={() => endIt(r)}>End</button>
                            : <span className="muted" style={{ fontSize: 11.5 }}>History</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<Icon n="schedule" size="lg" />}
            msg="No pattern has ever been assigned to this person" />
        )}
      </Card>

      {own && (
        <Badge kind="info">
          This is your own record — your manager or an administrator sets the pattern.
        </Badge>
      )}
    </div>
  );
}
