-- ---------------------------------------------------------------------------
-- 0064 — no day between two shift periods belongs to nobody
--
-- 0063 can leave a hole. Its tail insert starts the current period on the date
-- the audit entry says the move took effect, which is right, but it closes the
-- preceding period on the last day *attendance* measured — and those two dates
-- are not adjacent. Everything in between is covered by no row.
--
-- ## Why a hole is worse than a missing answer
--
-- The reader this table is for resolves a date as
--
--   COALESCE((SELECT shift_id FROM employee_shift WHERE <range> @> date),
--            (SELECT shift_id FROM employee))
--
-- so an uncovered day does not error and does not come back empty. It comes
-- back as the employee's **current** roster. For a day worked before a move
-- that is the wrong answer, delivered silently, and it is the precise failure
-- 0063 was written to prevent — reached from the other side.
--
-- Measured against production on 5 November 2026, before 0063 was applied:
-- VHM007's last measured day is 22 October and his move into the US roster is
-- audited effective 4 November, so 23 October to 3 November — twelve days he
-- worked on India hours — would have resolved to America/New_York. Ten and a
-- half hours out, with nothing in the data to say so.
--
-- ## Why this is a separate migration rather than a fix inside 0063
--
-- 0063 is committed, and `migrate.mjs` refuses any migration whose checksum no
-- longer matches the one it recorded — so an edited 0063 could never be applied
-- to a database that had already run it. `check:migrations` asserts that
-- property on every file. Editing 0063 would have meant overriding a guard to
-- avoid writing eight lines of SQL.
--
-- ## Why it closes gaps generally rather than reconstructing 0063's reasoning
--
-- The end of a hole is already stated by the period that follows it, whatever
-- put that period there. So this does not re-read `audit_log` and does not need
-- to know which of 0063's three sources produced either side: it extends the
-- earlier period forward to meet the later one. That makes it correct for any
-- gap, including one from a path written later, rather than only for the shape
-- 0063 happens to produce.
--
-- ## Safety
--
-- One INSERT. No row is altered, nothing is dropped, no column is added, and
-- attendance is not touched. Re-running is a no-op: once a gap is filled there
-- is no gap to find, so the WHERE clause matches nothing. Rolling it back is a
-- DELETE of the rows it wrote, which `source = 'audit'` alone does not identify
-- — 0063 writes that source too — so roll back by dropping the table and
-- re-running both, which is what 0063's own rollback already is.
-- ---------------------------------------------------------------------------

-- >>> BACKFILL BEGIN — shift-history.test.mjs runs everything between these
-- two markers, after 0063's own marked section, so the suite exercises the SQL
-- that ships rather than a copy of it.

/*
 * The shift carried across the hole is the one on its *earlier* side: the
 * roster they were still on until the move took effect. Labelled `audit`
 * because that is what dates the far edge — the boundary is somebody's
 * recorded act, not a day anybody was measured on.
 *
 * `valid_to IS NOT NULL` skips an open period, which has no far side. A NULL
 * `valid_to` would also make `valid_to + 1` NULL and the row would be refused
 * by the NOT NULL on `valid_from`, so this is correctness rather than tidiness.
 */
INSERT INTO employee_shift
  (tenant_id, employee_id, shift_id, valid_from, valid_to, source)
SELECT g.tenant_id, g.employee_id, g.shift_id,
       g.valid_to + 1, g.next_from - 1, 'audit'
  FROM (
    SELECT es.tenant_id, es.employee_id, es.shift_id, es.valid_to,
           LEAD(es.valid_from) OVER (PARTITION BY es.tenant_id, es.employee_id
                                         ORDER BY es.valid_from) AS next_from
      FROM employee_shift es
  ) g
 WHERE g.valid_to IS NOT NULL
   AND g.next_from IS NOT NULL
   -- Strictly beyond the next day, or the two periods already meet and there
   -- is nothing in between: `valid_to` would land before `valid_from` and the
   -- employee_shift_dates_ordered CHECK would refuse the row.
   AND g.next_from > g.valid_to + 1;

-- <<< BACKFILL END
