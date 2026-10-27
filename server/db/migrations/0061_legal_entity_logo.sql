-- ---------------------------------------------------------------------------
-- A pointer from a legal entity to its logo.
--
-- The same shape as `employee.photo_document_id` from 0059, for the same
-- reasons, and this comment will not repeat them: the bytes and their
-- metadata live in `document`, a replaced logo is purged rather than deleted,
-- and a single pointer is what makes one of several rows current.
--
-- ## Why the entity and not the tenant
--
-- A tenant may hold several legal entities, and a logo is a filing identity
-- rather than a brand: the mark on a payslip is the mark of the company that
-- employs the person and pays them, which is the entity. Putting it on
-- `tenant` would be one logo for a group that may file in three countries.
--
-- The app header is the one place that wants a single answer, and it takes the
-- default entity's — `legal_entity.is_default` already exists to answer
-- exactly that kind of question.
--
-- ## Composite foreign key, again
--
-- `(tenant_id, logo_document_id)` against `document (tenant_id, id)`. A
-- single-column reference would let one tenant point at another tenant's
-- document: the database would be satisfied and the logo would be somebody
-- else's. 0059 says the same thing about photos and the reasoning has not
-- changed.
--
-- ## ON DELETE SET NULL
--
-- Hard-deleting a document is not the normal path — purging is — but if a row
-- ever does go, the entity should lose its logo rather than the delete being
-- refused. The product falls back to the built-in mark, which is a different
-- logo and not a broken page.
--
-- Nullable, no default, no backfill: nobody has uploaded one, and an entity
-- without a logo is the ordinary case rather than an incomplete record.
-- ---------------------------------------------------------------------------

ALTER TABLE legal_entity
  ADD COLUMN logo_document_id uuid;

ALTER TABLE legal_entity
  ADD CONSTRAINT legal_entity_logo_document_fkey
  FOREIGN KEY (tenant_id, logo_document_id)
  REFERENCES document (tenant_id, id)
  ON DELETE SET NULL;

-- Partial: most entities have no logo, and an index over a mostly-null column
-- is mostly wasted. There are few entities per tenant, so this earns its keep
-- only for the join from the header's default-entity lookup.
CREATE INDEX legal_entity_logo_document_idx
  ON legal_entity (tenant_id, logo_document_id)
  WHERE logo_document_id IS NOT NULL;

COMMENT ON COLUMN legal_entity.logo_document_id IS
  'The current logo, as a document row with kind=''logo''. Null is the '
  'ordinary case; the product falls back to its built-in mark. Replaced logos '
  'are purged rather than deleted, so this pointer is what makes one current.';

-- ---------------------------------------------------------------------------
-- Who signs a letter.
--
-- Every letter body in `src/modules/documents/Letter.tsx` prints
-- `ctx.signatory.name` and `ctx.signatory.designation`, and the schema has
-- nowhere to put either — so the signature block has only ever been filled
-- from the demo dataset. A letter that goes to a bank or a landlord cannot be
-- signed by a fictional person, which is why the five pay-free letters cannot
-- go live without these two columns.
--
-- On `legal_entity` rather than `tenant`, for the reason the logo is: the
-- person who signs an employment letter signs for the company that employs
-- and pays the reader, and a group filing in three countries has three of
-- them.
--
-- Nullable and with no default, deliberately. A signatory is a named human
-- with a real title, and inventing one here — "Authorised Signatory", say —
-- would put a plausible-looking lie on a legal document. Null means the letter
-- screens must say the signatory is not configured yet, which is the honest
-- state until somebody enters it.
-- ---------------------------------------------------------------------------

ALTER TABLE legal_entity
  ADD COLUMN signatory_name  text,
  ADD COLUMN signatory_title text;

COMMENT ON COLUMN legal_entity.signatory_name IS
  'The person who signs letters for this entity. Null until configured; the '
  'letter screens must refuse to print an unsigned letter rather than invent '
  'a signatory.';
