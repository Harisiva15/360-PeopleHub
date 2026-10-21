/**
 * Profile photos.
 *
 * A photo is a `document` row with `kind = 'photo'` plus a pointer from the
 * employee, which is migration 0059. `document` already carries the checksum,
 * the size, the MIME type and the retention column, so a parallel table would
 * have been a second copy of all of it; what `document` cannot say on its own
 * is which of somebody's photos is the current one, and that is what the
 * pointer is for.
 *
 * ## Who may change whose
 *
 * Your own goes through `account`, which every role holds as `own` — a person
 * may always change their own picture. Somebody else's goes through
 * `employees` **write**, which is hr_admin and company_admin. That leaves
 * finance_admin and a manager able to see a photo and not to replace one,
 * which is the approved matrix rather than a choice made here.
 *
 * Asked as two questions rather than one `||`, because "it is mine" and "I
 * administer people" are different permissions and the error should say which
 * one was missing.
 *
 * ## What the server cannot check
 *
 * The browser resizes to 256px before uploading. The server **cannot verify
 * that** — it has no image decoder, and adding one to read two integers out of
 * a header is a dependency and an attack surface for a guarantee nobody is
 * relying on. So the resize is a courtesy to bandwidth, not a constraint, and
 * the real limits are the ones that can be enforced: the byte count and the
 * type, both checked against the bytes themselves in `storage/`.
 *
 * Anything that matters downstream must therefore tolerate a photo of any
 * dimensions. `Avatar` renders it in a fixed circle with `object-fit: cover`,
 * so a 4000px square and a 40px one both come out as the same circle.
 */

import { createHash } from 'node:crypto';
import { reaches } from '../../auth/can.ts';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import { storage, StorageError } from '../../storage/index.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class PhotoError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PhotoError';
    this.code = code;
  }
}

/** What a profile photo may be. Stated here; enforced against the bytes. */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_TYPES = ['image/png', 'image/jpeg'] as const;

/** How long a photo URL lives. Short: the page re-asks, and a leak expires. */
const URL_TTL_SECONDS = 300;

/**
 * May this caller change that employee's photo?
 *
 * Throws rather than returning false, so the message can name which of the two
 * permissions was missing instead of a single "forbidden" that leaves an
 * administrator guessing whether the rule is about them or about the subject.
 */
function mayChange(caller: Caller, employeeId: string): void {
  const own = caller.employeeId !== null && caller.employeeId === employeeId;
  if (own) {
    if (!reaches(caller, 'account', 'write', 'own')) {
      throw new PhotoError('Your role cannot change your own account', 'forbidden');
    }
    return;
  }
  if (!reaches(caller, 'employees', 'write', 'all')) {
    throw new PhotoError(
      'Only an administrator can change somebody else\'s photo', 'forbidden');
  }
}

/** May this caller see it? Reading a photo is reading the person's record. */
function maySee(caller: Caller, employeeId: string): void {
  const own = caller.employeeId !== null && caller.employeeId === employeeId;
  if (own) return;
  if (!reaches(caller, 'employees', 'read', 'all')
      && !reaches(caller, 'employees', 'read', 'team')) {
    throw new PhotoError('That is not yours to see', 'forbidden');
  }
}

interface PhotoRow {
  photo_document_id: string | null;
  storage_key: string | null;
  purged_at: Date | null;
}

/**
 * The audit row, written locally as every other module writes its own.
 *
 * `subject_table` is `employee`, not `tenant_membership`: a photo belongs to
 * the person's record rather than to their sign-in, and the subject id has to
 * be resolvable against the table it names or the trail cannot be followed
 * back. `category` is `people` for the same reason — this is not an access
 * event, and filing it under one would put it in the security screen's feed
 * alongside things that are.
 *
 * Severity is the only column with a CHECK behind it; category and action are
 * free text.
 */
async function writeAudit(
  db: TenantClient,
  caller: Caller,
  action: string,
  subjectId: string,
  summary: string,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                            subject_table, subject_id, detail)
     SELECT 'people', $1, 'notice', $2,
            COALESCE((SELECT full_name FROM employee WHERE id = $2), 'system'),
            'employee', $3, jsonb_build_object('summary', $4::text)`,
    [action, caller.employeeId, subjectId, summary]);
}

const CURRENT = `
  SELECT e.photo_document_id, d.storage_key, d.purged_at
    FROM employee e
    LEFT JOIN document d ON d.id = e.photo_document_id
   WHERE e.id = $1`;

/**
 * A URL for somebody's photo, or null if they have none.
 *
 * Null rather than an error: not having a photo is the ordinary case, and the
 * caller's answer to it is to render initials, not to show a failure.
 */
export async function photoUrl(caller: Caller, employeeId: string): Promise<string | null> {
  maySee(caller, employeeId);
  const key = await withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<PhotoRow>(CURRENT, [employeeId]);
    const row = rows[0];
    if (!row || !row.photo_document_id || !row.storage_key) return null;
    /* A purged document's bytes are gone; the row survives for the audit
       trail. Signing a URL for it would produce a broken image. */
    if (row.purged_at !== null) return null;
    return row.storage_key;
  });
  if (!key) return null;
  return storage().signedUrl(key, URL_TTL_SECONDS);
}

/**
 * Replace somebody's photo.
 *
 * The bytes go to storage first and the database second, which is the less bad
 * order. Fail after the upload and the result is bytes nobody points at —
 * waste, cleaned up by the retention job. Fail the other way round and the
 * pointer names an object that is not there, which is a broken image on every
 * screen that renders the person. On the first kind of failure this makes a
 * best-effort attempt to take the orphan back out.
 */
export async function setPhoto(
  caller: Caller,
  employeeId: string,
  bytes: Buffer,
  mimeType: string,
): Promise<{ url: string }> {
  mayChange(caller, employeeId);

  const put = await storage().put({
    prefix: 'photos',
    tenantId: caller.tenantId,
    bytes,
    mimeType,
    maxBytes: PHOTO_MAX_BYTES,
    allow: PHOTO_TYPES,
  });

  let storageKey: string | null = put.storageKey;
  try {
    await withTenant(caller, async (db) => {
      /* Lock the row so two uploads at once cannot both think they are
         replacing the same previous photo and leave one orphaned. */
      const { rows: before } = await db.query<PhotoRow>(
        `${CURRENT} FOR UPDATE OF e`, [employeeId]);
      if (!before[0]) throw new PhotoError('No such employee', 'not_found');
      const previousId = before[0].photo_document_id;
      const previousKey = before[0].storage_key;

      const { rows: made } = await db.query<{ id: string }>(
        `INSERT INTO document
           (tenant_id, employee_id, kind, title, storage_key, mime_type,
            size_bytes, checksum, uploaded_by)
         VALUES (current_tenant_id(), $1, 'photo', 'Profile photo', $2, $3, $4, $5, $6)
         RETURNING id`,
        [employeeId, put.storageKey, put.mimeType, put.sizeBytes, put.checksum,
          caller.employeeId]);

      await db.query(
        'UPDATE employee SET photo_document_id = $2 WHERE id = $1',
        [employeeId, made[0]!.id]);

      /*
       * The one it replaced is purged, not deleted: `document.purged_at` exists
       * so the audit trail keeps the fact that a file was once there. The bytes
       * do go.
       */
      if (previousId) {
        await db.query(
          'UPDATE document SET purged_at = now() WHERE id = $1 AND purged_at IS NULL',
          [previousId]);
      }

      await writeAudit(db, caller, 'employee.photo_changed', employeeId,
        previousId ? 'replaced the profile photo' : 'set a profile photo');

      /* Committed, so the new key is no longer the orphan candidate. */
      storageKey = null;

      if (previousKey) {
        /* Best effort. A photo nobody points at is waste, not a fault, and
           failing the whole change over it would undo a good upload. */
        await storage().remove(previousKey).catch(() => {});
      }
    });
  } catch (e) {
    if (storageKey) await storage().remove(storageKey).catch(() => {});
    throw e;
  }

  return { url: await storage().signedUrl(put.storageKey, URL_TTL_SECONDS) };
}

/**
 * Take somebody's photo away.
 *
 * Clears the pointer and purges the document; `Avatar` falls back to initials.
 * Removing a photo nobody has is not an error — the end state is the one asked
 * for either way.
 */
export async function removePhoto(caller: Caller, employeeId: string): Promise<void> {
  mayChange(caller, employeeId);
  const key = await withTenant(caller, async (db) => {
    const { rows } = await db.query<PhotoRow>(`${CURRENT} FOR UPDATE OF e`, [employeeId]);
    const row = rows[0];
    if (!row) throw new PhotoError('No such employee', 'not_found');
    if (!row.photo_document_id) return null;

    await db.query('UPDATE employee SET photo_document_id = NULL WHERE id = $1', [employeeId]);
    await db.query(
      'UPDATE document SET purged_at = now() WHERE id = $1 AND purged_at IS NULL',
      [row.photo_document_id]);
    await writeAudit(db, caller, 'employee.photo_removed', employeeId, 'removed the profile photo');
    return row.storage_key;
  });
  if (key) await storage().remove(key).catch(() => {});
}

/** Re-export so the HTTP layer can map a storage refusal without importing it. */
export { StorageError };

/** The sha256 of some bytes, for callers that want to compare before uploading. */
export const checksumOf = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
