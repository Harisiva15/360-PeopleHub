/**
 * Your own photo: upload, replace, remove.
 *
 * ## What the browser does and what it does not promise
 *
 * The file is resized to a 256px square before it is sent, which is four times
 * the largest size anything renders it at. That is a courtesy to bandwidth and
 * **not a guarantee** — see `lib/resize.ts`. The server has no image decoder,
 * so it cannot verify dimensions; it enforces what it can check against the
 * bytes, which is the byte count and the type's magic number. If the resize
 * fails for any reason the original is sent and the server applies its limits
 * to that instead.
 *
 * ## Why there is no success toast
 *
 * The photo appearing *is* the confirmation, and it is unambiguous in a way a
 * toast is not. `checks/no-fake-success.ts` exists because twenty-eight
 * handlers in this product said a thing had happened and did no work; a toast
 * over a picture that visibly changed adds nothing and would be one more place
 * for that to go wrong.
 *
 * Errors are shown and kept until the next attempt, because an upload that
 * failed is the case where a person needs to read something.
 */

import { useRef, useState } from 'react';
import { Avatar, Card } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useMutation } from '../../services/react';
import { usePhotoUrl } from '../../services/photos';
import { PHOTO_TYPES, resizeForPhoto } from '../../lib/resize';

const useSetPhoto = () =>
  useMutation((s, empId: string, blob: Blob, mimeType: string) =>
    s.employees.setPhoto(empId, blob, mimeType));

const useRemovePhoto = () =>
  useMutation((s, empId: string) => s.employees.removePhoto(empId));

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function ProfilePhoto({ empId, name }: { empId: string; name: string }) {
  const photo = usePhotoUrl(empId);
  const set = useSetPhoto();
  const remove = useRemovePhoto();
  const file = useRef<HTMLInputElement>(null);

  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /*
   * The URL shown, which is the one the upload just returned rather than a
   * refetch. The signed URL comes back from `setPhoto`, so showing it costs
   * nothing and avoids a round trip that would briefly render initials over a
   * photo that is already stored.
   */
  const [justSet, setJustSet] = useState<string | null>(null);

  const url = justSet ?? photo.data ?? null;
  const has = Boolean(url);

  const choose = async (chosen: File | undefined) => {
    if (!chosen) return;
    setErr('');

    /*
     * Name what was chosen.
     *
     * "That has to be a PNG or a JPEG" does not tell somebody holding a photo
     * from their phone what is wrong with it — an iPhone hands over
     * `image/heic` and the sentence reads like a contradiction. Saying the
     * type makes the refusal actionable, and an empty type (which some
     * browsers report for an unfamiliar extension) is worth saying out loud
     * rather than rendering as a blank.
     */
    if (!(PHOTO_TYPES as readonly string[]).includes(chosen.type)) {
      setErr(`That file is ${chosen.type || 'of a type this browser could not identify'}. `
        + 'A photo has to be a PNG or a JPEG — on an iPhone, Settings → Camera → '
        + 'Formats → Most Compatible, or export the picture first.');
      return;
    }

    setBusy(true);
    try {
      const { bytes, mimeType } = await resizeForPhoto(chosen);
      const { url: next } = await set.mutate(empId, bytes, mimeType);
      setJustSet(next);
    } catch (e) {
      setErr(msg(e, 'That photo could not be saved.'));
    } finally {
      setBusy(false);
      /* Clear the input so choosing the same file again still fires onChange. */
      if (file.current) file.current.value = '';
    }
  };

  const clear = async () => {
    setErr('');
    setBusy(true);
    try {
      await remove.mutate(empId);
      setJustSet(null);
    } catch (e) {
      setErr(msg(e, 'That photo could not be removed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Your photo" sub="Shown beside your name across the product">
      <div className="row" style={{ gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <Avatar name={name} size="xl" src={url} />

        <div className="stack" style={{ gap: 6, minWidth: 220 }}>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              <Icon n="attachment" size="lg" /> {has ? 'Replace photo' : 'Upload a photo'}
            </button>
            {has && (
              <button className="btn" disabled={busy} onClick={clear}>
                Remove
              </button>
            )}
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            PNG or JPEG, up to 2 MB. It is cropped to a square and scaled down
            before it is sent.
          </div>

          {busy && <div className="muted" style={{ fontSize: 12 }}>Saving…</div>}
          {err && <div className="pw-reason" role="alert">{err}</div>}
        </div>

        {/*
          * Hidden, driven by the button above: a bare file input cannot be
          * styled and reads as a different control on every browser.
          */}
        <input
          ref={file}
          type="file"
          accept={PHOTO_TYPES.join(',')}
          style={{ display: 'none' }}
          onChange={(e) => { void choose(e.target.files?.[0]); }}
        />
      </div>
    </Card>
  );
}
