/**
 * The offer letter, and releasing it.
 *
 * Making an offer and sending it are two decisions. An offer is created as a
 * draft, and this is where somebody reads the letter back before it reaches the
 * candidate — which is the whole point of the draft state, and the reason the
 * salary is shown in words as well as figures.
 *
 * **The letter is the server's, not this screen's.** It is rendered from the
 * stored offer, and frozen onto it at the moment of release. What is shown here
 * after release is the text that was sent, not a re-render of an offer whose
 * salary may have moved since.
 */

import { useState } from 'react';
import type { Candidate } from '../../services';
import { inr } from '../../lib/format';
import { fmtD } from '../../lib/dates';
import { Badge, Banner, EmptyState } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { useOfferLetter, useReleaseOffer } from './data';
import { Icon } from '../../components/icons';

export function OfferLetter({ c, onDone }: { c: Candidate; onDone?: () => void }) {
  const { data: body, loading, error } = useOfferLetter(c.id);
  const release = useReleaseOffer();
  const app = useApp();
  const [busy, setBusy] = useState(false);

  const offer = c.offer;
  if (!offer) return <EmptyState msg="That candidate has no offer" icon={<Icon n="document" size="lg" />} />;
  const draft = offer.status === 'Draft';

  const send = async () => {
    setBusy(true);
    try {
      await release.mutate(c.id);
      app.toast(`Offer released to ${c.name}`, 'ok');
      onDone?.();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not release the offer', 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge kind={draft ? 'mute' : offer.status === 'Accepted' ? 'good' : 'info'}>
          {offer.status}
        </Badge>
        <span className="muted" style={{ fontSize: 12 }}>
          {inr(offer.ctc)} p.a. · joining {fmtD(offer.doj)}
          {offer.sentOn ? ` · sent ${fmtD(offer.sentOn)}` : ''}
        </span>
      </div>

      {draft ? (
        <Banner kind="warn" icon={<Icon n="note" size="lg" />} title="Not yet released">
          The candidate has not seen this. Read the figures back before sending —
          once released, the letter is frozen as it stands here.
        </Banner>
      ) : (
        <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="Released">
          This is the letter as it was sent. Later changes to the offer do not
          alter it.
        </Banner>
      )}

      {error ? <EmptyState msg={error.message} icon={<Icon n="warn" size="lg" />} />
        : loading && body === undefined ? <EmptyState msg="Loading the letter…" />
          : (
            <pre style={{
              margin: 0, padding: '18px 20px', whiteSpace: 'pre-wrap', overflowX: 'auto',
              font: '13px/1.7 ui-serif, Georgia, serif', color: 'var(--ink-1)',
              background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8,
            }}>{body}</pre>
          )}

      {draft && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={busy} onClick={send}>
            {busy ? 'Releasing…' : 'Release to candidate'}
          </button>
        </div>
      )}
    </div>
  );
}
