/**
 * Document collection — the chasing list.
 *
 * Scoped to one joiner or one employee, and used from both the onboarding
 * screen and the documents module, because it is the same question in two
 * places: what have we asked for, and what is still missing.
 *
 * **Every transition goes to the server.** Rejecting needs a reason and
 * verifying records who checked it; the screen sends the intent and re-reads
 * the row it gets back. A tick this screen drew itself would be a tick with
 * nobody behind it, which is precisely what a document audit looks for.
 */

import { useState } from 'react';
import type { DocRequest } from '../../services';
import { fmtD, TODAY, ymd } from '../../lib/dates';
import { Badge, Banner, Card, EmptyState } from '../../components/ui';
import { ListRow } from '../../components/common';
import { useApp } from '../../state/AppContext';
import {
  useDocRequests, useDocSummary, useRequestDocument, useSetDocStatus, useVisiblePeople,
} from './data';
import { Icon } from '../../components/icons';

const LABEL: Record<string, string> = {
  pending: 'Pending', received: 'Received', verified: 'Verified',
  rejected: 'Rejected', waived: 'Waived',
};

const TONE: Record<string, 'good' | 'warn' | 'crit' | 'info' | 'mute'> = {
  pending: 'warn', received: 'info', verified: 'good', rejected: 'crit', waived: 'mute',
};

/** What can be done next, given where a request currently stands. */
const NEXT: Record<string, { to: string; label: string }[]> = {
  pending: [
    { to: 'received', label: 'Mark received' },
    { to: 'waived', label: 'Waive' },
  ],
  received: [
    { to: 'verified', label: 'Verify' },
    { to: 'rejected', label: 'Reject' },
  ],
  rejected: [{ to: 'received', label: 'Re-received' }],
  waived: [{ to: 'pending', label: 'Ask again' }],
  verified: [],
};

export type DocScope = { journeyId?: string; empId?: string };

export function DocumentCollection({ scope, title }: { scope: DocScope; title?: string }) {
  const { data: rows = [] } = useDocRequests(scope);
  const { data: summary } = useDocSummary(scope);
  const setStatus = useSetDocStatus();
  const ask = useRequestDocument();
  const dir = useVisiblePeople();
  const app = useApp();

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [mandatory, setMandatory] = useState(true);

  const move = async (r: DocRequest, to: string) => {
    /*
     * A rejection without a reason is refused by the server, so ask for one
     * here rather than sending a request that cannot succeed.
     */
    let note: string | undefined;
    if (to === 'rejected') {
      const said = window.prompt(`Why is “${r.label}” being rejected?`);
      if (said === null) return;
      if (!said.trim()) {
        app.toast('A rejection needs a reason', 'err');
        return;
      }
      note = said.trim();
    }
    try {
      await setStatus.mutate(r.id, to, note);
      app.toast(`${r.label} — ${LABEL[to].toLowerCase()}`, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not update the document', 'err');
    }
  };

  const submitNew = async () => {
    if (!label.trim()) { app.toast('Say which document', 'err'); return; }
    try {
      await ask.mutate({
        ...scope,
        /* The kind is the label's slug; it is what uniqueness is checked on. */
        kind: label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        label: label.trim(),
        mandatory,
      });
      app.toast('Requested ' + label.trim(), 'ok');
      setLabel('');
      setAdding(false);
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not request the document', 'err');
    }
  };

  const blocking = summary?.mandatoryOutstanding ?? 0;

  return (
    <Card
      title={title ?? 'Document collection'}
      sub={summary
        ? `${summary.verified} verified · ${summary.received} to check · ${summary.outstanding} outstanding`
        : `${rows.length} documents`}
      flush
      actions={
        <button className="btn sm" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : '+ Request another'}
        </button>
      }>

      {adding && (
        <div className="row" style={{ gap: 8, padding: '10px 14px', flexWrap: 'wrap' }}>
          <input className="in" style={{ flex: 1, minWidth: 200 }} value={label} autoFocus
            placeholder="e.g. Work visa" onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); }} />
          <label className="row muted" style={{ gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
            Mandatory
          </label>
          <button className="btn sm primary" onClick={submitNew}>Request</button>
        </div>
      )}

      {blocking > 0 && (
        <div style={{ padding: '10px 14px 0' }}>
          <Banner kind="warn" icon={<Icon n="goal" size="lg" />}>
            {blocking} mandatory {blocking === 1 ? 'document is' : 'documents are'} still outstanding.
          </Banner>
        </div>
      )}

      {rows.length ? rows.map((r) => {
        const overdue = r.status === 'pending' && !!r.due && r.due < ymd(TODAY);
        return (
          <ListRow key={r.id}>
            <span>{r.status === 'verified' ? '✅' : r.status === 'rejected' ? '⚠️' : '📄'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                {r.label}
                {r.mandatory
                  ? <span className="muted" style={{ fontWeight: 400 }}> · required</span>
                  : <span className="muted" style={{ fontWeight: 400 }}> · optional</span>}
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {r.status === 'verified' && r.verifiedOn
                  ? `Verified by ${dir.name(r.verifiedBy ?? '')} on ${fmtD(r.verifiedOn)}`
                  : r.receivedOn
                    ? `Received ${fmtD(r.receivedOn)}`
                    : r.due ? `Due ${fmtD(r.due)}` : 'No due date'}
                {r.note ? ` · ${r.note}` : ''}
              </div>
            </div>
            {overdue ? <Badge kind="crit">Overdue</Badge> : <Badge kind={TONE[r.status]}>{LABEL[r.status]}</Badge>}
            {(NEXT[r.status] ?? []).map((n) => (
              <button key={n.to} className="btn sm" onClick={() => move(r, n.to)}>{n.label}</button>
            ))}
          </ListRow>
        );
      }) : <EmptyState msg="Nothing has been requested yet" icon={<Icon n="document" size="lg" />} />}
    </Card>
  );
}
