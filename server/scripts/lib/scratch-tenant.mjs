/**
 * A tenant that exists for one test run and takes everything with it.
 *
 * Behavioural tests need real rows — employees, memberships, leave requests,
 * timesheets — because the thing under test is whether the services behave, and
 * a stub proves nothing about a recursive scope clause or a row-level policy.
 * Until now those rows were written into the live tenant and deleted afterwards
 * by hand, table by table, in a list somebody had to keep correct.
 *
 * That list is the problem. It drifted the first time a test met a real defect:
 * `audit_log` references the employee twice — once as subject, once as actor —
 * the cleanup only knew about the subject, the delete failed on a NOT NULL, and
 * five employees, their memberships and their audit rows stayed in the
 * production database until somebody noticed.
 *
 * ## What replaces it
 *
 * Nothing new. The schema already has the mechanism: every one of the 126
 * tenant-scoped tables declares
 *
 *     tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE
 *
 * so removing one row removes everything that belongs to it, in one statement,
 * atomically, whatever the test managed to create first. There is no list to
 * keep correct because there is no list. A table added next year is covered the
 * day it is created, because the cascade is a property of the schema rather
 * than of this file.
 *
 * The live tenant is never written to at all — not created-then-deleted, not
 * touched. Its row counts are identical before and after because nothing in the
 * run ever addressed it.
 *
 * ## What a scratch tenant needs
 *
 * Only the reference data the services look up by code: a legal entity, a
 * department, a site, a shift, a leave type, a project, and one administrator
 * to act as. Deliberately minimal — this is not a second seed script, and
 * anything a test needs beyond it should be created by the test, through the
 * product, where it is also being proven.
 *
 * `country` and `currency` are global and already exist; the scratch tenant
 * references them and never writes to them.
 *
 * ## Leftovers
 *
 * A run killed outright — a lost connection, Ctrl-C — can still leave its
 * tenant. `sweepScratchTenants` removes any it finds, and each run calls it
 * first, so the worst case is one stale tenant until the next run rather than
 * rows scattered through the live one. They are identifiable by slug: every
 * scratch tenant's is prefixed `zz-scratch-`.
 */

/** Every scratch tenant's slug starts with this. Nothing else may. */
export const SCRATCH_PREFIX = 'zz-scratch-';

/**
 * Remove every scratch tenant, and report how many.
 *
 * One DELETE per tenant, each cascading through all 126 tenant-scoped tables.
 * Safe to call at any time: it matches on the slug prefix, which the live
 * tenant cannot have.
 */
export async function sweepScratchTenants(db) {
  const { rows } = await db.query(
    'SELECT id, slug FROM tenant WHERE slug LIKE $1', [`${SCRATCH_PREFIX}%`]);
  for (const t of rows) {
    await db.query('DELETE FROM tenant WHERE id = $1', [t.id]);
  }
  return rows.map((t) => t.slug);
}

/**
 * Create a scratch tenant, run `body` inside it, then delete it.
 *
 * `db` is an admin connection (MIGRATE_DATABASE_URL) — creating a tenant is
 * not something the application does, and RLS would refuse it anyway.
 *
 * `body` receives the ids and codes it needs to build callers and drafts. It is
 * run inside try/finally, and the finally is a single DELETE, so there is no
 * ordering to get wrong and nothing to leave behind on any failure path.
 */
export async function withScratchTenant(db, body) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const slug = `${SCRATCH_PREFIX}${suffix}`;

  const tenant = (await db.query(
    `INSERT INTO tenant (slug, legal_name, display_name, home_country,
                         base_currency, fiscal_year_start_month, status)
     VALUES ($1::citext, 'ZZ Scratch Tenant', 'ZZ Scratch', 'IN', 'INR', 4, 'active')
     RETURNING id`, [slug])).rows[0].id;

  try {
    /*
     * Reference data, written with an explicit tenant_id rather than through
     * the current_tenant_id() default: this connection is the migration role
     * and has no tenant setting, which is the whole reason it may create one.
     */
    const one = async (sql, params) => (await db.query(sql, [tenant, ...params])).rows[0];

    const entity = await one(
      `INSERT INTO legal_entity (tenant_id, code, legal_name, country, currency, is_default)
       VALUES ($1, 'ZZ01', 'ZZ Scratch Entity', 'IN', 'INR', true) RETURNING id`, []);

    const dept = await one(
      `INSERT INTO department (tenant_id, code, name, active)
       VALUES ($1, 'ZZENG', 'ZZ Engineering', true) RETURNING id, code`, []);

    const site = await one(
      `INSERT INTO site (tenant_id, code, name, country, timezone, active)
       VALUES ($1, 'ZZBLR', 'ZZ Bengaluru', 'IN', 'Asia/Kolkata', true)
       RETURNING id, code`, []);

    const shift = await one(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, active)
       VALUES ($1, 'IN', 'ZZ India Shift', '09:30', '18:30', true) RETURNING id`, []);

    const leaveType = await one(
      `INSERT INTO leave_type (tenant_id, code, name, annual_quota, active)
       VALUES ($1, 'ZZEL', 'ZZ Earned Leave', 18, true) RETURNING id, code`, []);

    const project = await one(
      `INSERT INTO project (tenant_id, code, name, billable, active)
       VALUES ($1, 'ZZPRJ', 'ZZ Scratch Project', true, true) RETURNING id, code`, []);

    /*
     * An administrator to act as. Every service takes a Caller, and the audit
     * writer joins the actor to `employee`, so this has to be a real row rather
     * than an invented uuid.
     */
    const admin = await one(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role,
          department_id, site_id, legal_entity_id, shift_id, joined_on, currency)
       VALUES ($1, 'ZZ001', 'ZZ Scratch Admin', $2, 'active', 'admin',
               $3, $4, $5, $6, CURRENT_DATE, 'INR')
       RETURNING id`,
      [`zz-scratch-admin-${suffix}@360.technology`, dept.id, site.id, entity.id, shift.id]);

    /*
     * `invited`, not `active`.
     *
     * `tenant_membership_user_once_usable` requires a `user_id` on any status
     * beyond pending_approval / invited / deleted, and there is no auth user
     * here — creating one would mean talking to Supabase, which is the one
     * thing these tests deliberately never do.
     *
     * It costs nothing: a service takes a `Caller` and authorises from its
     * role, so the membership row exists to satisfy the foreign keys and the
     * audit writer, not to be re-read as a permission.
     */
    await db.query(
      `INSERT INTO tenant_membership (tenant_id, user_id, role, employee_id, status)
       VALUES ($1, NULL, 'admin', $2, 'invited')`, [tenant, admin.id]);

    return await body({
      tenant,
      slug,
      adminEmployeeId: admin.id,
      dept: dept.code,
      site: site.code,
      leaveType: leaveType.code,
      project: project.code,
      entityId: entity.id,
      shiftId: shift.id,
    });
  } finally {
    /*
     * One statement, and it cannot be incomplete. Whatever the body created —
     * employees, memberships, leave, timesheets, audit rows, tables added long
     * after this was written — goes with the tenant.
     */
    await db.query('DELETE FROM tenant WHERE id = $1', [tenant]);
  }
}
