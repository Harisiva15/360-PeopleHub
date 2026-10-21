-- ---------------------------------------------------------------------------
-- A pointer from an employee to their profile photo.
--
-- The bytes and all the metadata already have a home: `document` has carried
-- `storage_key`, `mime_type`, `size_bytes`, `checksum`, `uploaded_by`,
-- `uploaded_at` and `purged_at` since migration 0007, and migration 0058's
-- predecessor gave this deployment a storage adapter to fill them. A photo is
-- a stored file like any other, so it is a `document` row with
-- `kind = 'photo'` rather than a parallel table that would need its own copy
-- of retention, checksums and MIME.
--
-- What `document` cannot answer on its own is *which* one is current. An
-- employee may have several photo rows over time — a replaced photo is purged,
-- not hard-deleted, so the audit trail keeps the fact that it existed. Picking
-- the newest un-purged row by date would make "their photo" a query whose
-- answer depends on clock skew and on nothing having gone wrong. A single
-- pointer is the fact itself.
--
-- ## Why the foreign key is composite
--
-- `(tenant_id, photo_document_id)` against `document (tenant_id, id)`, which
-- is why that UNIQUE exists on `document`. A single-column FK to `document.id`
-- would allow one tenant's employee to point at another tenant's document —
-- the database would be satisfied and the photo would be somebody else's. The
-- rest of the schema uses composite keys for exactly this reason.
--
-- ## ON DELETE SET NULL
--
-- Hard-deleting a document is not the normal path; purging is. But if a row
-- ever does go, the employee should lose their photo rather than the delete
-- being refused — the `Avatar` falls back to initials, which is a worse
-- picture and not a broken page.
--
-- Nullable, with no default and no backfill: nobody has a photo yet, and an
-- employee without one is the ordinary case rather than an incomplete record.
-- ---------------------------------------------------------------------------

ALTER TABLE employee
  ADD COLUMN photo_document_id uuid;

ALTER TABLE employee
  ADD CONSTRAINT employee_photo_document_fkey
  FOREIGN KEY (tenant_id, photo_document_id)
  REFERENCES document (tenant_id, id)
  ON DELETE SET NULL;

-- Finding everybody's photo in one query, for the directory and the org chart,
-- without a scan per row. Partial: most employees have no photo, and an index
-- over a column that is mostly null is mostly wasted.
CREATE INDEX employee_photo_document_idx
  ON employee (tenant_id, photo_document_id)
  WHERE photo_document_id IS NOT NULL;

COMMENT ON COLUMN employee.photo_document_id IS
  'The current profile photo, as a document row with kind=''photo''. Null is '
  'the ordinary case; Avatar falls back to initials. Replaced photos are '
  'purged rather than deleted, so this pointer is what makes one of them current.';
