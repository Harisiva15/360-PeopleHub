/**
 * Seeds a database from empty to usable: reference data, one tenant, and the
 * configuration that tenant needs before anybody can be added to it.
 *
 * Idempotent — safe to re-run. Everything upserts on a natural key, so this can
 * be run again after adding a department without duplicating the other eight.
 *
 * Deliberately does NOT create fake employees. The demo has 5,000 fabricated
 * people and that is the right place for them; a real database starts with the
 * real org chart or it starts empty.
 *
 *   node scripts/seed.mjs                          # reference data + tenant + config
 *   node scripts/seed.mjs --admin you@example.com  # also creates an admin employee
 *   node scripts/seed.mjs --link <auth-user-uuid>  # links a Supabase login to it
 */

import pg from 'pg';
import { loadEnv } from './env.mjs';
import { sslConfig } from './ssl.mjs';

loadEnv();

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('MIGRATE_DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const adminEmail = arg('--admin');
const linkUserId = arg('--link');

/* Mirrors src/data/org.ts, so the database and the screens agree on what a
   department or a grade is called. */
const COUNTRIES = [
  ['IN', 'India', 'INR', '🇮🇳', 30],
  ['US', 'United States', 'USD', '🇺🇸', 14],
  ['GB', 'United Kingdom', 'GBP', '🇬🇧', 30],
  ['CA', 'Canada', 'CAD', '🇨🇦', 14],
  ['AE', 'United Arab Emirates', 'AED', '🇦🇪', 30],
];
const CURRENCIES = [
  ['INR', 'Indian Rupee', '₹', 2],
  ['USD', 'US Dollar', '$', 2],
  ['GBP', 'Pound Sterling', '£', 2],
  ['CAD', 'Canadian Dollar', 'C$', 2],
  ['AED', 'UAE Dirham', 'د.إ', 2],
];
const DEPARTMENTS = [
  ['ENG', 'Engineering'], ['QA', 'Quality Assurance'], ['DEVOPS', 'DevOps & Cloud'],
  ['PROD', 'Product & Design'], ['SALES', 'Sales & Marketing'], ['SUP', 'Customer Support'],
  ['HR', 'Human Resources'], ['FIN', 'Finance & Admin'],
];
const SITES = [
  ['CHN', 'Chennai HQ', 'Chennai', 'IN', 12.9911, 80.2503, 250],
  ['BLR', 'Bengaluru Office', 'Bengaluru', 'IN', 12.9352, 77.6245, 220],
  ['HYD', 'Hyderabad Office', 'Hyderabad', 'IN', 17.4435, 78.3772, 200],
  ['NJ', 'New Jersey Office', 'Jersey City', 'US', null, null, null],
  ['LON', 'London Office', 'London', 'GB', null, null, null],
  ['DXB', 'Dubai Office', 'Dubai', 'AE', null, null, null],
  ['WFH', 'Work From Home', null, 'IN', null, null, null],
];
const GRADES = [
  ['L1', 'L1 · Associate', 1, 450000, 750000],
  ['L2', 'L2 · Engineer', 2, 750000, 1300000],
  ['L3', 'L3 · Senior', 3, 1300000, 2100000],
  ['L4', 'L4 · Lead / Manager', 4, 2100000, 3500000],
  ['L5', 'L5 · Head', 5, 3500000, 6000000],
  ['L6', 'L6 · Leadership', 6, 6000000, 12000000],
];
const LEAVE_TYPES = [
  ['CL', 'Casual Leave', 12, 0, false],
  ['SL', 'Sick Leave', 12, 0, false],
  ['EL', 'Earned / Privilege Leave', 15, 30, true],
  ['CO', 'Comp Off', 0, 0, false],
  ['ML', 'Maternity Leave', 182, 0, false],
  ['PL', 'Paternity Leave', 5, 0, false],
  ['LOP', 'Loss of Pay', 0, 0, false],
];
const SHIFTS = [
  ['GEN', 'General', '09:30', '18:30', false],
  ['EARLY', 'Early', '06:00', '15:00', false],
  ['NIGHT', 'Night', '21:30', '06:30', true],
  ['FLEX', 'Flexible', null, null, false],
];

const client = new pg.Client({ connectionString: url, ssl: sslConfig() });
await client.connect();

const q = (sql, params = []) => client.query(sql, params);
let created = [];

try {
  await q('BEGIN');

  /* ---- global reference data ---- */
  for (const [code, name, ccy, flag, notice] of COUNTRIES) {
    await q(`INSERT INTO country (code, name, currency, flag_emoji, notice_days)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [code, name, ccy, flag, notice]);
  }
  for (const [code, name, symbol, precision] of CURRENCIES) {
    await q(`INSERT INTO currency (code, name, symbol, precision) VALUES ($1,$2,$3,$4)
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
      [code, name, symbol, precision]);
  }
  created.push(`${COUNTRIES.length} countries, ${CURRENCIES.length} currencies`);

  /* ---- the tenant ---- */
  const tenant = (await q(
    `INSERT INTO tenant (slug, legal_name, display_name, home_country, base_currency,
                         fiscal_year_start_month, status)
     VALUES ('360vhm'::citext, $1::text, $2::text, 'IN', 'INR', 4, 'active')
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    ['360VHM Technology Private Limited', '360VHM Technology'],
  )).rows[0].id;
  created.push(`tenant 360vhm (${tenant})`);

  // Everything below is tenant-scoped, so the transaction needs a tenant.
  await q('SELECT set_config($1, $2, true)', ['app.tenant_id', tenant]);

  /* ---- the employing entity ---- */
  const entity = (await q(
    `INSERT INTO legal_entity (tenant_id, code, legal_name, country, currency, is_default)
     VALUES ($1, 'IN01', $2, 'IN', 'INR', true)
     ON CONFLICT (tenant_id, code) DO UPDATE SET legal_name = EXCLUDED.legal_name
     RETURNING id`,
    [tenant, '360VHM Technology Private Limited'],
  )).rows[0].id;

  /* ---- configuration ---- */
  for (const [code, name] of DEPARTMENTS) {
    await q(`INSERT INTO department (tenant_id, code, name) VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name]);
  }
  for (const [code, name, start, end, night] of SHIFTS) {
    await q(`INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, is_night, is_flexible)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, start, end, night, code === 'FLEX']);
  }
  for (const [code, name, city, country, lat, lng, radius] of SITES) {
    await q(`INSERT INTO site (tenant_id, code, name, city, country, latitude, longitude, fence_radius_m)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, city, country, lat, lng, radius]);
  }
  for (const [code, label, rank, min, max] of GRADES) {
    await q(`INSERT INTO grade_band (tenant_id, code, label, rank, min_ctc, max_ctc)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, code) DO UPDATE SET label = EXCLUDED.label`,
      [tenant, code, label, rank, min, max]);
  }
  for (const [code, name, quota, carry, encash] of LEAVE_TYPES) {
    await q(`INSERT INTO leave_type (tenant_id, code, name, annual_quota, carry_forward_max, encashable)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, quota, carry, encash]);
  }
  created.push(`${DEPARTMENTS.length} departments, ${SITES.length} sites, `
    + `${GRADES.length} grades, ${LEAVE_TYPES.length} leave types, ${SHIFTS.length} shifts`);

  /* ---- permissions: admin sees everything, the rest is narrowed later ---- */
  const MODULES = ['dashboard', 'employees', 'leave', 'attendance', 'timesheet', 'payroll',
    'expenses', 'approvals', 'settings'];
  for (const m of MODULES) {
    for (const [role, read, write, approve] of [
      ['admin', true, true, true],
      ['manager', true, false, true],
      ['employee', true, false, false],
    ]) {
      await q(`INSERT INTO role_permission (tenant_id, role, module, can_read, can_write, can_approve)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (tenant_id, role, module) DO NOTHING`,
        [tenant, role, m, read, write, approve]);
    }
  }

  /* ---- optional: an admin employee ---- */
  let employeeId = null;
  if (adminEmail) {
    const hr = (await q('SELECT id FROM department WHERE code = $1', ['HR'])).rows[0].id;
    const chn = (await q('SELECT id FROM site WHERE code = $1', ['CHN'])).rows[0].id;
    const l6 = (await q('SELECT id FROM grade_band WHERE code = $1', ['L6'])).rows[0].id;

    employeeId = (await q(
      `INSERT INTO employee (tenant_id, code, full_name, work_email, legal_entity_id,
                             joined_on, department_id, site_id, grade_id, designation,
                             app_role, currency)
       VALUES ($1, 'EMP0001', $2, $3, $4, CURRENT_DATE, $5, $6, $7, 'Administrator', 'admin', 'INR')
       ON CONFLICT (tenant_id, code) DO UPDATE SET work_email = EXCLUDED.work_email
       RETURNING id`,
      [tenant, adminEmail.split('@')[0], adminEmail, entity, hr, chn, l6],
    )).rows[0].id;

    // Opening leave balances for the current leave year.
    const yearStart = (await q(
      `SELECT make_date(CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 4
                             THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                             ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END, 4, 1) d`
    )).rows[0].d;
    await q(
      `INSERT INTO leave_balance (tenant_id, employee_id, leave_type_id, year_start, quota)
       SELECT $1, $2, lt.id, $3, lt.annual_quota FROM leave_type lt
       ON CONFLICT (tenant_id, employee_id, leave_type_id, year_start) DO NOTHING`,
      [tenant, employeeId, yearStart]);
    created.push(`admin employee ${adminEmail} (${employeeId}) with leave balances`);
  }

  /* ---- optional: link a Supabase login ---- */
  if (linkUserId) {
    await q(
      `INSERT INTO tenant_membership (tenant_id, user_id, role, employee_id, status, accepted_at)
       VALUES ($1, $2, 'admin', $3, 'active', now())
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET role = 'admin', employee_id = EXCLUDED.employee_id, status = 'active'`,
      [tenant, linkUserId, employeeId]);
    created.push(`membership for auth user ${linkUserId}`);
  }

  await q('COMMIT');
} catch (e) {
  await q('ROLLBACK').catch(() => {});
  console.error('seed failed, nothing was written:\n  ' + e.message);
  await client.end();
  process.exit(1);
}

console.log('seeded:');
for (const c of created) console.log('  ' + c);

if (!adminEmail) console.log('\nno admin employee — re-run with --admin you@example.com');
if (!linkUserId) {
  console.log('\nto link a Supabase login, create the user in the dashboard then:');
  console.log('  node scripts/seed.mjs --admin <email> --link <auth-user-uuid>');
  console.log('and set the tenant claim so PostgREST sees it too:');
  const t = await q("SELECT id FROM tenant WHERE slug = '360vhm'::citext");
  console.log(`  app_metadata.tenant_id = ${t.rows[0].id}`);
}

await client.end();
