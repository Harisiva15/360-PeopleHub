-- ---------------------------------------------------------------------------
-- 0036 — company events
--
-- **An event has a room with a number of chairs in it.** That is the whole
-- difference between this and everything nearby. A birthday happens to
-- somebody whether or not anybody responds; an announcement is read and
-- forgotten. An event needs an audience, a capacity, an answer from each
-- person and, afterwards, a register of who actually came.
--
-- **A "Maybe" does not hold a seat.** Counting maybes makes the number look
-- healthier and makes the capacity wrong, which is the one thing a capacity
-- must not be. Only 'Going' occupies a chair; 'Waitlisted' is what a full
-- event does with a Going, and it is waiting for one.
--
-- **Waitlisted is not something a person can choose.** The CHECK below does
-- not try to enforce that — a status column cannot know who wrote it — but the
-- service refuses it, and this comment is here so the next person to add a
-- value to the list knows the rule exists.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (btrim(title) <> ''),
  kind          text NOT NULL CHECK (kind IN (
    'Town hall', 'Training', 'Offsite', 'Celebration', 'Wellness',
    'Hackathon', 'Community', 'Social'
  )),
  description   text NOT NULL DEFAULT '',
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  -- Local to the venue, and text rather than time because "all day" has no
  -- clock and a nullable time pair invites two ways to say the same thing.
  start_at      text NOT NULL DEFAULT '',
  end_at        text NOT NULL DEFAULT '',
  all_day       boolean NOT NULL DEFAULT false,
  -- Where it happens. Null site with online = true is the online case.
  site_id       uuid,
  venue         text NOT NULL DEFAULT '',
  online        boolean NOT NULL DEFAULT false,
  -- Null means no limit — a town hall on a call has no chairs.
  capacity      integer CHECK (capacity IS NULL OR capacity > 0),
  organiser_id  uuid NOT NULL,
  -- Empty means everybody. Both narrow together: a Chennai engineering event
  -- is for engineers in Chennai, not for every engineer and everyone in
  -- Chennai.
  for_sites     uuid[] NOT NULL DEFAULT '{}',
  for_departments uuid[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'Draft'
    CHECK (status IN ('Draft', 'Published', 'Cancelled')),
  -- After this the organiser needs a headcount and the list closes.
  rsvp_by       date,
  -- People put this in their calendar; they are owed a reason.
  cancelled_reason text NOT NULL DEFAULT '',
  created_on    date NOT NULL DEFAULT CURRENT_DATE,
  CHECK (ends_on >= starts_on),
  CHECK (rsvp_by IS NULL OR rsvp_by <= starts_on),
  -- Somewhere to be, or explicitly nowhere.
  CHECK (online OR site_id IS NOT NULL),
  -- A cancellation says why.
  CHECK (status <> 'Cancelled' OR btrim(cancelled_reason) <> ''),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES site (tenant_id, id),
  FOREIGN KEY (tenant_id, organiser_id) REFERENCES employee (tenant_id, id)
);

-- The calendar: what is coming up, soonest first. Every landing read.
CREATE INDEX IF NOT EXISTS company_event_upcoming_idx
  ON company_event (tenant_id, starts_on)
  WHERE status = 'Published';

CREATE INDEX IF NOT EXISTS company_event_organiser_idx
  ON company_event (tenant_id, organiser_id);

SELECT apply_tenant_isolation('company_event');

-- ---------------------------------------------------------------------------
-- who is coming
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event_rsvp (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  event_id    uuid NOT NULL,
  employee_id uuid NOT NULL,
  response    text NOT NULL CHECK (response IN (
    'Going',        -- holds a chair
    'Waitlisted',   -- wants one; assigned by the service, never chosen
    'Maybe',        -- holds nothing
    'Not going'
  )),
  responded_on date NOT NULL DEFAULT CURRENT_DATE,
  -- Null until somebody marks the register, which only happens afterwards.
  -- Deliberately three-valued: "not marked" is a different answer from "did
  -- not come", and collapsing them makes every unmarked event look like a
  -- disaster.
  attended    boolean,
  UNIQUE (tenant_id, id),
  -- One answer each. Changing your mind updates the row; it does not add one.
  UNIQUE (tenant_id, event_id, employee_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES company_event (tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
    ON DELETE CASCADE
);

-- Counting the going, and the waitlist in the order people joined it.
CREATE INDEX IF NOT EXISTS event_rsvp_event_idx
  ON event_rsvp (tenant_id, event_id, response);

-- The waitlist is served strictly oldest first, so it is indexed that way.
CREATE INDEX IF NOT EXISTS event_rsvp_waitlist_idx
  ON event_rsvp (tenant_id, event_id, responded_on)
  WHERE response = 'Waitlisted';

-- "What have I said yes to", on everybody's own page.
CREATE INDEX IF NOT EXISTS event_rsvp_employee_idx
  ON event_rsvp (tenant_id, employee_id)
  WHERE response <> 'Not going';

SELECT apply_tenant_isolation('event_rsvp');

COMMENT ON COLUMN event_rsvp.attended IS
  'Three-valued on purpose: null is "register not marked", which is a '
  'different answer from false. See 0036.';
