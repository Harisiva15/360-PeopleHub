/**
 * The one query behind every employee read.
 *
 * All of them — directory, profile, team, a single lookup — need the same
 * shape, so they share a projection and differ only in their WHERE clause.
 * Writing it once means a field added to the contract is added in one place
 * rather than six, and cannot end up populated on some screens and blank on
 * others.
 */

/**
 * Config tables are joined to turn uuids into the codes the screens expect.
 * `skills` and `reports` come from lateral aggregates rather than a second
 * round trip — a directory of 500 people should be one query, not 501.
 */
export const EMPLOYEE_PROJECTION = `
  SELECT e.id,
         e.code,
         e.full_name,
         e.gender,
         e.date_of_birth,
         e.joined_on,
         e.left_on,
         e.work_email,
         e.phone,
         d.code  AS dept_code,
         e.designation,
         g.code  AS grade_code,
         s.code  AS site_code,
         le.country AS entity_country,
         e.currency,
         e.manager_id,
         e.status,
         e.employment_type,
         e.ctc,
         e.blood_group,
         e.address,
         e.emergency_contact,
         e.app_role,
         sh.code AS shift_code,
         e.on_probation,
         e.exit_reason,
         e.notice_days,
         sk.skills,
         rp.reports
    FROM employee e
    LEFT JOIN department   d  ON d.id  = e.department_id
    LEFT JOIN site         s  ON s.id  = e.site_id
    LEFT JOIN grade_band   g  ON g.id  = e.grade_id
    LEFT JOIN shift        sh ON sh.id = e.shift_id
    LEFT JOIN legal_entity le ON le.id = e.legal_entity_id
    LEFT JOIN LATERAL (
      SELECT array_agg(sk2.skill ORDER BY sk2.skill) AS skills
        FROM employee_skill sk2 WHERE sk2.employee_id = e.id
    ) sk ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(r.id) AS reports
        FROM employee r WHERE r.manager_id = e.id AND r.status <> 'exited'
    ) rp ON true`;

/**
 * Who the caller may see, as a predicate rather than a filter applied after
 * the rows arrive.
 *
 * Row-level security keeps other tenants out entirely; it says nothing about
 * which of *this* tenant's people a manager may see. That is this function's
 * job, and getting it wrong shows one manager another's team — a smaller
 * breach than crossing tenants, and still a breach.
 */
export function scopeClause(
  role: 'admin' | 'manager' | 'employee',
  employeeId: string | null,
): { sql: string; params: unknown[] } {
  if (role === 'admin') return { sql: 'TRUE', params: [] };

  if (role === 'manager') {
    return {
      sql: `e.id = $1 OR e.id IN (
              WITH RECURSIVE reports AS (
                SELECT id FROM employee WHERE manager_id = $1
                UNION ALL
                SELECT c.id FROM employee c JOIN reports r ON c.manager_id = r.id
              )
              SELECT id FROM reports
            )`,
      params: [employeeId],
    };
  }
  return { sql: 'e.id = $1', params: [employeeId] };
}
