/**
 * The company's logo, and the person who signs its letters.
 *
 * Two cards on Company Profile rather than fields inside the entity form,
 * because neither is edited the way the rest of it is: a logo is a file and
 * has no draft state worth cancelling, and a signatory is read by the letter
 * screens whether or not anybody is editing the company's address.
 *
 * ## Why there is no success toast
 *
 * The same reason `ProfilePhoto` gives: the picture changing *is* the
 * confirmation, and a toast on top of it is noise. `checks/no-fake-success.ts`
 * exists because handlers in this product once said a thing had happened and
 * did no work — so the rule here is that the screen shows the new state or it
 * shows the error, and never a reassurance instead of either.
 *
 * ## What the browser checks, and what it does not
 *
 * The type is checked here so an obvious mistake is answered immediately, and
 * SVG is named specifically because that refusal has a reason worth giving
 * before a round trip. None of it is a guarantee: the server re-checks the
 * bytes against their magic number, the 2 MB cap and the SVG rule in
 * `branding/service.ts`, which is where the enforcement lives. This is
 * courtesy, not security.
 */

import { useEffect, useRef, useState } from 'react';
import { Banner, Card } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useApp } from '../../state/AppContext';
import {
  useLogoUrl, useSetLogo, useRemoveLogo, useSignatory, useSetSignatory,
} from './data';

/** What the server will accept. Stated here; enforced against the bytes there. */
const LOGO_TYPES = ['image/png', 'image/jpeg'] as const;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function CompanyLogoCard({ entityCode }: { entityCode: string | null }) {
  const app = useApp();
  const admin = app.reaches('settings', 'write', 'all');
  const logo = useLogoUrl(entityCode);
  const set = useSetLogo();
  const remove = useRemoveLogo();
  const file = useRef<HTMLInputElement>(null);

  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /*
   * The URL the upload just returned, shown instead of refetching. `setLogo`
   * hands back the signed URL, so using it avoids a round trip that would
   * briefly draw the built-in mark over a logo already stored.
   */
  const [justSet, setJustSet] = useState<string | null>(null);

  const url = justSet ?? logo.data ?? null;

  const choose = async (chosen: File | undefined) => {
    if (!chosen || !entityCode) return;
    setErr('');

    /* Named before the generic type check, because the reason is specific. */
    if (chosen.type === 'image/svg+xml' || /\.svg$/i.test(chosen.name)) {
      setErr('SVG is not accepted. An SVG is executable markup — it can carry '
        + 'script and fetch remote content — and this file is shown to everybody '
        + 'who signs in. Export the logo as PNG, which keeps transparency, or JPG.');
      return;
    }
    if (!(LOGO_TYPES as readonly string[]).includes(chosen.type)) {
      setErr('That has to be a PNG or a JPEG.');
      return;
    }
    if (chosen.size > LOGO_MAX_BYTES) {
      setErr(`That file is ${(chosen.size / 1024 / 1024).toFixed(1)} MB and the limit is 2 MB.`);
      return;
    }

    setBusy(true);
    try {
      const { url: next } = await set.mutate(entityCode, chosen, chosen.type);
      setJustSet(next);
    } catch (e) {
      setErr(msg(e, 'That logo could not be saved.'));
    } finally {
      setBusy(false);
      /* Clear the input so choosing the same file again still fires onChange. */
      if (file.current) file.current.value = '';
    }
  };

  const clear = async () => {
    if (!entityCode) return;
    setErr('');
    setBusy(true);
    try {
      await remove.mutate(entityCode);
      setJustSet(null);
    } catch (e) {
      setErr(msg(e, 'That logo could not be removed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Company logo" sub="Shown in the header, on letters and on payslips">
      <div className="row" style={{ gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="logo-plate" aria-hidden={url ? undefined : true}>
          {url
            ? <img src={url} alt="The company logo" className="logo-plate-img" />
            : <Icon n="building" size="xl" />}
        </div>

        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {url
              ? 'PNG or JPG, up to 2 MB.'
              : 'No logo uploaded, so the product shows its own mark. PNG or JPG, up to 2 MB.'}
          </div>
          {/*
            * Said plainly rather than discovered on a dark screen: there is one
            * upload and no reversed variant, so artwork with dark ink in it is
            * hard to read on the navy rail. The built-in mark has a reversed
            * version derived at build time; nothing can do that to a file the
            * server cannot decode.
            */}
          {url && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Used as supplied on every background, including the dark sidebar.
            </div>
          )}

          {admin && entityCode && (
            <div className="row" style={{ gap: 6, marginTop: 10 }}>
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => file.current?.click()}
              >
                {busy ? 'Working…' : url ? 'Replace' : 'Upload'}
              </button>
              {url && (
                <button className="btn sm ghost" disabled={busy} onClick={() => void clear()}>
                  Remove
                </button>
              )}
            </div>
          )}

          <input
            ref={file}
            type="file"
            accept={LOGO_TYPES.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => { void choose(e.target.files?.[0]); }}
          />
        </div>
      </div>

      {err && <div style={{ marginTop: 12 }}><Banner kind="warn">{err}</Banner></div>}
    </Card>
  );
}

/**
 * Who signs. Both fields or neither, which the server also enforces.
 *
 * The empty state says what the absence costs — letters will not print —
 * because "not set" on its own reads as optional, and this one is not.
 */
export function SignatoryCard({ entityCode }: { entityCode: string | null }) {
  const app = useApp();
  const admin = app.reaches('settings', 'write', 'all');
  const current = useSignatory(entityCode);
  const save = useSetSignatory();

  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  /* Seed the fields from the server's answer, once it arrives. */
  useEffect(() => {
    if (editing) return;
    setName(current.data?.name ?? '');
    setTitle(current.data?.title ?? '');
  }, [current.data, editing]);

  const commit = async () => {
    if (!entityCode) return;
    setErr('');
    const cleanName = name.trim();
    const cleanTitle = title.trim();
    if (Boolean(cleanName) !== Boolean(cleanTitle)) {
      setErr('A signatory needs both a name and a title, or neither. '
        + 'A letter signed by a name with no title is not signed.');
      return;
    }
    setBusy(true);
    try {
      await save.mutate(entityCode, cleanName || null, cleanTitle || null);
      setEditing(false);
    } catch (e) {
      setErr(msg(e, 'That signatory could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const who = current.data;

  return (
    <Card
      title="Letter signatory"
      sub="Printed in the signature block of every letter this entity issues"
      actions={admin && entityCode && (
        editing
          ? (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" disabled={busy} onClick={() => { setEditing(false); setErr(''); }}>
                Cancel
              </button>
              <button className="btn sm primary" disabled={busy} onClick={() => void commit()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )
          : <button className="btn sm" onClick={() => setEditing(true)}>Edit</button>
      )}
    >
      {!editing && !who && (
        <Banner kind="warn">
          No signatory is set, so letters will not print. Add the name and title of
          the person who signs for this entity.
        </Banner>
      )}

      {!editing && who && (
        <div className="stack" style={{ gap: 2 }}>
          <div style={{ fontWeight: 600 }}>{who.name}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{who.title}</div>
        </div>
      )}

      {editing && (
        <div className="grid g2" style={{ gap: '0 14px' }}>
          <div className="field">
            <label htmlFor="signatory-name">Name</label>
            <input
              id="signatory-name"
              className="input"
              value={name}
              placeholder="As it should appear above the signature"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="signatory-title">Title</label>
            <input
              id="signatory-title"
              className="input"
              value={title}
              placeholder="Director, Head of HR, …"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="muted" style={{ fontSize: 12, gridColumn: '1 / -1' }}>
            Clear both to remove the signatory. Letters will stop printing until
            one is set again.
          </div>
        </div>
      )}

      {err && <div style={{ marginTop: 12 }}><Banner kind="warn">{err}</Banner></div>}
    </Card>
  );
}
