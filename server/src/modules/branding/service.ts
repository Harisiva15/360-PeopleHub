/**
 * The company's own mark, and the person who signs its letters.
 *
 * Both hang off `legal_entity` (migration 0061) for the same reason: they
 * belong to the company that employs and pays the reader, not to the group.
 * A tenant filing in three countries has three logos and three signatories,
 * and the app header asks the default entity because `is_default` exists to
 * answer exactly that.
 *
 * The logo is a `document` row with `kind = 'logo'` plus a pointer, which is
 * the shape `photos/service.ts` established for profile photos in 0059. That
 * module's header explains why a parallel table would have been a second copy
 * of the checksum, the size and the retention column, and this one will not
 * repeat it. What differs is below.
 *
 * ## Who may change it, and who may see it
 *
 * Writing — upload, replace, remove, and setting the signatory — is `settings`
 * write at `all`, which is **company_admin alone**: hr_admin holds nothing on
 * `settings`, by the standing decision that users, roles and settings are one
 * job. **Reading is open to any signed-in caller**, because the mark renders
 * in the header of every page, so everybody reads it. A read is therefore not
 * gated here at all beyond the tenancy the context already applies.
 *
 * That asymmetry was a correction, not the first draft: an earlier version of
 * the plan had a non-company_admin refused on both, which cannot be right for
 * something drawn on every screen.
 *
 * ## SVG is refused, and the message says why
 *
 * PNG and JPG only, checked against the bytes in `storage/` rather than
 * against what the browser claimed. SVG gets its own refusal ahead of that,
 * with its own reason, because "that type is not allowed" invites somebody to
 * convert it and try again when the objection is not about the format's
 * fitness: an SVG is executable markup. It can carry script and fetch remote
 * content, and this file is served to every signed-in person in the header.
 * The server has no image decoder (phase 0, decision 12) and so cannot
 * sanitise one either.
 *
 * ## A logo is served as supplied, on every ground
 *
 * The bundled mark has a reversed variant derived at build time by
 * `scripts/reverse-logo.mjs`. Nothing re-runs that against a customer's file,
 * and one upload was the approved decision, so an uploaded logo appears as
 * given — including on the navy rail. Artwork with dark ink in it will be hard
 * to read there. That is a known consequence with a known cheap mitigation (a
 * white plate behind the mark on dark grounds, CSS only), not a surprise.
 *
 * ## Why the signatory may not be invented
 *
 * `signatory_name` and `signatory_title` are nullable with no default, and
 * this module will not substitute a plausible placeholder such as "Authorised
 * Signatory". A letter that goes to a bank or a landlord carries a real name
 * and a real title or it does not go: `signatoryOf` returns null and the
 * letter screens refuse to print. Null is the honest state until somebody
 * enters it.
 */

import { reaches } from '../../auth/can.ts';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import { storage } from '../../storage/index.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class BrandingError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'BrandingError';
    this.code = code;
  }
}

/** What a logo may be. Stated here; enforced against the bytes in `storage/`. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg'] as const;

/** How long a logo URL lives. Short: the page re-asks, and a leak expires. */
const URL_TTL_SECONDS = 300;

/**
 * May this caller change the company's branding?
 *
 * One question, not two: unlike a photo there is no "it is mine" case — a
 * legal entity is nobody's own record.
 */
function mayConfigure(caller: Caller): void {
  if (!reaches(caller, 'settings', 'write', 'all')) {
    throw new BrandingError(
      'Only a company administrator may change company branding.', 'forbidden');
  }
}

/**
 * Refuse an SVG before the type check does, so the reason is the real one.
 *
 * Both halves matter. The declared type catches the honest upload; the first
 * bytes catch a file renamed to `.png`, which is the case a type allow-list
 * alone would wave through to `storage/`'s sniffer and report as a mismatch
 * rather than as a policy.
 */
function refuseSvg(mimeType: string, bytes: Buffer): void {
  const declared = mimeType.trim().toLowerCase();
  const head = bytes.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  const looksLikeSvg = head.startsWith('<svg') || head.startsWith('<?xml');

  if (declared.startsWith('image/svg') || looksLikeSvg) {
    throw new BrandingError(
      'SVG is not accepted. An SVG is executable markup — it can carry script '
      + 'and fetch remote content — and this file is shown to everybody who '
      + 'signs in. Export the logo as PNG, which keeps transparency, or JPG.',
      'svg_refused');
  }
}

/**
 * The audit row, written locally as every other module writes its own.
 *
 * `category` is `config`, not `people`: this is a change to how the tenant is
 * set up. `subject_table` is `legal_entity` and the id resolves against it, so
 * the trail can be followed back to the entity rather than to a document row
 * that may since have been purged.
 */
async function writeAudit(
  db: TenantClient,
  caller: Caller,
  action: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                            subject_table, subject_id, detail)
     SELECT 'config', $1, 'notice', $2,
            COALESCE((SELECT full_name FROM employee WHERE id = $2), 'system'),
            'legal_entity', $3, jsonb_build_object('summary', $4::text)`,
    [action, caller.employeeId, entityId, summary]);
}

interface EntityRow {
  id: string;
  code: string;
  logo_document_id: string | null;
  signatory_name: string | null;
  signatory_title: string | null;
  storage_key: string | null;
  purged_at: Date | null;
}

/**
 * The entity a request is about: the one named, or the tenant's default.
 *
 * `is_default` rather than "the only one", because a tenant may hold several
 * and the header still needs a single answer.
 */
const ENTITY = `
  SELECT le.id, le.code, le.logo_document_id, le.signatory_name, le.signatory_title,
         d.storage_key, d.purged_at
    FROM legal_entity le
    LEFT JOIN document d ON d.id = le.logo_document_id
   WHERE ($1::text IS NULL AND le.is_default) OR le.code = $1::text`;

const entityOr404 = async (
  db: TenantClient, code: string | null,
): Promise<EntityRow> => {
  const { rows } = await db.query<EntityRow>(ENTITY, [code]);
  const row = rows[0];
  if (!row) {
    throw new BrandingError(
      code ? `No legal entity with code ${code}` : 'This tenant has no default legal entity',
      'not_found');
  }
  return row;
};

/**
 * A URL for the logo, or null when there is none.
 *
 * Null rather than an error, for the reason `photoUrl` gives: not having one
 * is the ordinary case, and the caller's answer is to draw the built-in mark
 * rather than to show a failure. No permission check — every signed-in person
 * sees the header.
 */
export async function logoUrl(
  caller: Caller, entityCode: string | null = null,
): Promise<string | null> {
  const key = await withTenantReadOnly(caller, async (db) => {
    const row = await entityOr404(db, entityCode);
    if (!row.logo_document_id || !row.storage_key) return null;
    /* A purged document's bytes are gone; the row survives for the trail. */
    if (row.purged_at !== null) return null;
    return row.storage_key;
  });
  if (!key) return null;
  return storage().signedUrl(key, URL_TTL_SECONDS);
}

/**
 * Upload or replace the logo.
 *
 * Bytes to storage first, database second — the less bad order, and
 * `setPhoto` explains why at length. On a failure after the upload this makes
 * a best-effort attempt to take the orphan back out.
 */
export async function setLogo(
  caller: Caller,
  entityCode: string | null,
  bytes: Buffer,
  mimeType: string,
): Promise<{ url: string }> {
  mayConfigure(caller);
  refuseSvg(mimeType, bytes);

  const put = await storage().put({
    prefix: 'branding',
    tenantId: caller.tenantId,
    bytes,
    mimeType,
    maxBytes: LOGO_MAX_BYTES,
    allow: LOGO_TYPES,
  });

  let storageKey: string | null = put.storageKey;
  try {
    await withTenant(caller, async (db) => {
      /* Lock the entity so two uploads cannot both think they are replacing
         the same previous logo and leave one orphaned. */
      const { rows } = await db.query<EntityRow>(
        `${ENTITY} FOR UPDATE OF le`, [entityCode]);
      const entity = rows[0];
      if (!entity) throw new BrandingError('No such legal entity', 'not_found');

      const previousId = entity.logo_document_id;
      const previousKey = entity.storage_key;

      /*
       * `employee_id` is null: a logo belongs to the company, not to a person.
       * The column is nullable precisely so a document need not have a subject.
       */
      const { rows: made } = await db.query<{ id: string }>(
        `INSERT INTO document
           (tenant_id, employee_id, kind, title, storage_key, mime_type,
            size_bytes, checksum, uploaded_by)
         VALUES (current_tenant_id(), NULL, 'logo', 'Company logo', $1, $2, $3, $4, $5)
         RETURNING id`,
        [put.storageKey, put.mimeType, put.sizeBytes, put.checksum, caller.employeeId]);

      await db.query(
        'UPDATE legal_entity SET logo_document_id = $2 WHERE id = $1',
        [entity.id, made[0]!.id]);

      if (previousId) {
        await db.query(
          'UPDATE document SET purged_at = now() WHERE id = $1 AND purged_at IS NULL',
          [previousId]);
      }

      await writeAudit(db, caller, 'legal_entity.logo_changed', entity.id,
        previousId ? `replaced the logo for ${entity.code}` : `set a logo for ${entity.code}`);

      /* Committed, so the new key is no longer the orphan candidate. */
      storageKey = null;

      if (previousKey) {
        /* Best effort: bytes nobody points at are waste, not a fault, and
           failing the whole change over them would undo a good upload. */
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
 * Remove the logo.
 *
 * Clears the pointer and purges the document; the product falls back to its
 * built-in mark, which is a different logo rather than a broken image.
 */
export async function removeLogo(
  caller: Caller, entityCode: string | null = null,
): Promise<void> {
  mayConfigure(caller);

  const key = await withTenant(caller, async (db) => {
    const { rows } = await db.query<EntityRow>(`${ENTITY} FOR UPDATE OF le`, [entityCode]);
    const entity = rows[0];
    if (!entity) throw new BrandingError('No such legal entity', 'not_found');
    if (!entity.logo_document_id) return null;

    await db.query('UPDATE legal_entity SET logo_document_id = NULL WHERE id = $1',
      [entity.id]);
    await db.query(
      'UPDATE document SET purged_at = now() WHERE id = $1 AND purged_at IS NULL',
      [entity.logo_document_id]);
    await writeAudit(db, caller, 'legal_entity.logo_removed', entity.id,
      `removed the logo for ${entity.code}`);
    return entity.storage_key;
  });

  if (key) await storage().remove(key).catch(() => {});
}

export interface Signatory {
  name: string;
  title: string;
}

/**
 * Who signs this entity's letters, or null when nobody has been named.
 *
 * Null is what makes a letter refuse to print. No permission check: a letter
 * is rendered for the person reading it, and the signature block is part of
 * the letter rather than a configuration screen.
 */
export async function signatoryOf(
  caller: Caller, entityCode: string | null = null,
): Promise<Signatory | null> {
  return withTenantReadOnly(caller, async (db) => {
    const row = await entityOr404(db, entityCode);
    const name = row.signatory_name?.trim();
    const title = row.signatory_title?.trim();
    /* Both or neither. Half a signature block is not a signature. */
    if (!name || !title) return null;
    return { name, title };
  });
}

/**
 * Name the person who signs, or clear them.
 *
 * Both fields together, or both empty. A name with no title prints a blank
 * line under a real person's name, and a title with no name is not a
 * signatory at all — so the pair is set as a pair, and `signatoryOf` reads it
 * as a pair.
 */
export async function setSignatory(
  caller: Caller,
  entityCode: string | null,
  name: string | null,
  title: string | null,
): Promise<Signatory | null> {
  mayConfigure(caller);

  const cleanName = name?.trim() ?? '';
  const cleanTitle = title?.trim() ?? '';

  if (Boolean(cleanName) !== Boolean(cleanTitle)) {
    throw new BrandingError(
      'A signatory needs both a name and a title, or neither. '
      + 'A letter signed by a name with no title, or a title with no name, '
      + 'is not signed.', 'incomplete');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<EntityRow>(`${ENTITY} FOR UPDATE OF le`, [entityCode]);
    const entity = rows[0];
    if (!entity) throw new BrandingError('No such legal entity', 'not_found');

    const next = cleanName ? { name: cleanName, title: cleanTitle } : null;

    await db.query(
      'UPDATE legal_entity SET signatory_name = $2, signatory_title = $3 WHERE id = $1',
      [entity.id, next?.name ?? null, next?.title ?? null]);

    /*
     * The summary names the title and not just that something changed: who
     * signs a company's letters is the kind of change somebody later wants to
     * read out of the trail without joining back to a row that has moved on.
     */
    await writeAudit(db, caller, 'legal_entity.signatory_changed', entity.id,
      next
        ? `set the signatory for ${entity.code} to ${next.name}, ${next.title}`
        : `cleared the signatory for ${entity.code}`);

    return next;
  });
}
