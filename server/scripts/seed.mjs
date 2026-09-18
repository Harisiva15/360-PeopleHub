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
 *   node scripts/seed.mjs --admin you@example.com --code VHM001 --name "Your Name"
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
/* Employee codes are the tenant's own scheme — 360VHM uses VHM###. Hardcoding
   one meant a re-run created a second person rather than finding the first. */
const adminCode = arg('--code') ?? 'VHM001';
const adminName = arg('--name') ?? null;

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
// Fence centre and radius in metres. A remote work mode is never fenced.
const SITES = [
  ['CHN', 'Chennai HQ', 'Chennai', 'IN', 12.9911, 80.2503, 250],
  ['BLR', 'Bengaluru Office', 'Bengaluru', 'IN', 12.9352, 77.6245, 220],
  ['HYD', 'Hyderabad Office', 'Hyderabad', 'IN', 17.4435, 78.3772, 200],
  ['NJ', 'New Jersey Office', 'Jersey City', 'US', 40.7178, -74.0431, 250],
  ['LON', 'London Office', 'London', 'GB', 51.5045, -0.0175, 200],
  ['DXB', 'Dubai Office', 'Dubai', 'AE', 25.0942, 55.1616, 250],
  ['WFH', 'Work From Home', null, 'IN', null, null, null],
  ['CLIENT', 'Client Site', null, 'IN', null, null, null],
];
const PROJECTS = [
  ['P-ATLAS', 'Atlas Core Platform', false],
  ['P-NBFC', 'Meridian NBFC Portal', true],
  ['P-RETAIL', 'RetailOne Commerce', true],
  ['P-HEALTH', 'CareLink Health Cloud', true],
  ['P-LOGI', 'TransitIQ Logistics', true],
  ['P-INT', 'Internal Tools & HRMS', false],
  ['P-SUP', 'Managed Support Desk', true],
  ['P-PRESALES', 'Pre-Sales & Solutioning', false],
];
// Useful life in months drives the straight-line book value in the register.
const ASSET_CATEGORIES = [
  ['LAPTOP', 'Laptops', 48],
  ['DISPLAY', 'Monitors', 60],
  ['MOBILE', 'Phones', 36],
  ['PERIPH', 'Peripherals', 36],
  ['SECURITY', 'Security keys', 60],
  ['LICENCE', 'Software licences', 12],
];
// Per-claim ceilings. An item above one is flagged, never blocked.
const EXPENSE_CATEGORIES = [
  ['AIR', 'Air Travel', 25000],
  ['HOTEL', 'Hotel / Stay', 6000],
  ['LOCAL', 'Local Travel / Cab', 2500],
  ['MEAL', 'Meals (per day)', 800],
  ['CLIENT', 'Client Entertainment', 10000],
  ['NET', 'Broadband / Internet', 1500],
  ['MOB', 'Mobile Bill', 1000],
  ['LEARN', 'Learning & Certification', 40000],
  ['RELOC', 'Relocation', 75000],
  ['FUEL', 'Fuel & Mileage', 6000],
];
// The SLA is copied onto each ticket at creation, so changing one here never
// retroactively breaches or un-breaches a ticket already raised.
const TICKET_CATEGORIES = [
  ['PAY', 'Payroll & Salary', 24, 'FIN'],
  ['ATT', 'Attendance & Leave', 24, 'HR'],
  ['IT', 'IT & Systems', 8, 'ENG'],
  ['DOC', 'Documents & Letters', 48, 'HR'],
  ['POL', 'Policy Clarification', 48, 'HR'],
  ['FAC', 'Facilities & Workplace', 24, 'FIN'],
  ['BEN', 'Insurance & Benefits', 48, 'HR'],
  ['ONB', 'Onboarding Support', 12, 'HR'],
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
/*
 * Regional working-hours profiles, not rotational patterns — see migration
 * 0015. The prototype's General / Early / Night / Flexible are gone: they
 * carried no timezone, which is the one thing a shift has to know once
 * somebody in Chennai works US hours.
 */
/*
 * Letters HR issues. `instant` means the letter is generated from live data with
 * no queue — a salary certificate is true the moment it is asked for. The rest
 * assert something a person has to check first, so they wait for HR.
 */
/*
 * The control framework, with each one's status as it actually stands rather
 * than as it would look best. Three are genuinely met because the platform
 * provides them; the rest are honest 'not_started', and the security screen
 * shows those as not met rather than inventing a middle state.
 */
/*
 * The courses a new tenant actually needs on day one — the four that are
 * legally or contractually mandatory in India, plus two that are not.
 *
 * POSH is the one with a statute behind it: the Sexual Harassment of Women at
 * Workplace Act 2013 requires awareness programmes, and its due date is set a
 * quarter out rather than left null so it appears in the compliance tracker
 * rather than sitting undated forever.
 */
/*
 * Flexible-benefit components with their statutory annual ceilings. These are
 * the Indian heads that carry their own tax treatment — the caps are what the
 * law allows tax-free against bills, not a company policy, so they are seeded
 * rather than left for somebody to invent.
 */
const FBP_COMPONENTS = [
  ['fuel', 'Fuel & Vehicle Maintenance', 28800, 'Tax-free against bills, 2,400 per month', '⛽'],
  ['meal', 'Meal Card', 26400, '50 per meal, 2 meals x 22 days — fully tax-free', '🍱'],
  ['telecom', 'Telephone & Internet', 24000, 'Tax-free against bills', '📱'],
  ['books', 'Books & Periodicals', 12000, 'Tax-free against bills', '📚'],
  ['lta', 'Leave Travel Allowance', 60000, 'Exempt twice in a block of 4 years', '🚆'],
  ['prof', 'Professional Development', 40000, 'Courses, certifications, conferences', '🎯'],
];

const COURSES = [
  ['POSH', 'Prevention of Sexual Harassment', 'Compliance', 'Internal', 1.5, true],
  ['INFOSEC', 'Information Security Essentials', 'Compliance', 'Internal', 2, true],
  ['CONDUCT', 'Code of Conduct', 'Compliance', 'Internal', 1, true],
  ['DPDP', 'Handling Personal Data', 'Compliance', 'Internal', 1.5, true],
  ['MGR-1', 'First-time Manager', 'Leadership', 'Internal', 8, false],
  ['COMMS', 'Working Across Timezones', 'Effectiveness', 'Internal', 3, false],
];

const SECURITY_CONTROLS = [
  ['ENC-TRANSIT', 'Encryption in transit', 'implemented', 'TLS on every connection, enforced by the database and the API.'],
  ['ENC-REST', 'Encryption at rest', 'implemented', 'Provided by the managed database and object storage.'],
  ['TENANCY', 'Tenant isolation', 'implemented', 'Row-level security on every table, forced, with the app role NOBYPASSRLS. Verified by scripts/verify-isolation.mjs.'],
  ['AUDIT', 'Audit trail', 'in_progress', 'Config, access, people, payroll and hiring write audit rows. Coverage is not yet complete across every write.'],
  ['RETENTION', 'Retention enforcement', 'in_progress', 'The register is enforced by scripts/retention.mjs for attendance location. Other record kinds have no handler yet.'],
  ['MFA', 'Multi-factor authentication', 'not_started', 'Available from the identity provider; not yet mandatory, and nothing here reports enrolment.'],
  ['MDM', 'Managed devices', 'not_started', 'No device management feed. The posture screen is not backed by anything real.'],
  ['BACKUP', 'Backup and restore drill', 'not_started', 'Managed backups exist; a restore has never been rehearsed.'],
  ['ACCESS-REVIEW', 'Periodic access review', 'not_started', 'The table exists; no review has been run.'],
  ['PENTEST', 'Independent penetration test', 'not_started', 'Not commissioned.'],
];

const LETTER_TYPES = [
  ['exp', 'Experience Letter', false, false],
  ['salcert', 'Salary Certificate', true, false],
  ['addr', 'Address Proof Letter', true, false],
  ['appt', 'Appointment Letter', true, false],
  ['inc', 'Increment / Revision Letter', true, false],
  ['noc', 'No Objection Certificate', false, true],
  ['rel', 'Relieving Letter', false, true],
  ['form16', 'Form 16', true, false],
];

const SHIFTS = [
  ['IN', 'India Shift', '09:30', '18:30', 'Asia/Kolkata', 'IN'],
  ['US', 'US Shift', '09:00', '18:00', 'America/New_York', 'US'],
  ['UK', 'UK Shift', '09:00', '17:30', 'Europe/London', 'GB'],
  ['AE', 'UAE Shift', '09:00', '18:00', 'Asia/Dubai', 'AE'],
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
  for (const [code, name, start, end, tz, region] of SHIFTS) {
    await q(`INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, region)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id, code)
             DO UPDATE SET name = EXCLUDED.name, starts_at = EXCLUDED.starts_at,
                           ends_at = EXCLUDED.ends_at, timezone = EXCLUDED.timezone,
                           region = EXCLUDED.region`,
      [tenant, code, name, start, end, tz, region]);
  }
  for (const [code, name, city, country, lat, lng, radius] of SITES) {
    await q(`INSERT INTO site (tenant_id, code, name, city, country,
                               latitude, longitude, fence_radius_m)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (tenant_id, code) DO UPDATE SET
               name = EXCLUDED.name,
               latitude = EXCLUDED.latitude,
               longitude = EXCLUDED.longitude,
               fence_radius_m = EXCLUDED.fence_radius_m`,
      [tenant, code, name, city, country, lat, lng, radius]);
  }
  for (const [code, name, billable] of PROJECTS) {
    await q(`INSERT INTO project (tenant_id, code, name, billable)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, billable]);
  }
  for (const [code, name, life] of ASSET_CATEGORIES) {
    await q(`INSERT INTO asset_category (tenant_id, code, name, useful_life_months)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, life]);
  }
  for (const [code, name, cap] of EXPENSE_CATEGORIES) {
    await q(`INSERT INTO expense_category (tenant_id, code, name, limit_amount)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, cap]);
  }
  for (const [code, name, sla, team] of TICKET_CATEGORIES) {
    await q(`INSERT INTO ticket_category (tenant_id, code, name, sla_hours, owning_department_id)
             VALUES ($1,$2,$3,$4,(SELECT id FROM department WHERE tenant_id=$1 AND code=$5))
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, sla, team]);
  }
  for (const [code, label, rank, min, max] of GRADES) {
    await q(`INSERT INTO grade_band (tenant_id, code, label, rank, min_ctc, max_ctc)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, code) DO UPDATE SET label = EXCLUDED.label`,
      [tenant, code, label, rank, min, max]);
  }
  for (const [code, name, cap, note, icon] of FBP_COMPONENTS) {
    await q(`INSERT INTO fbp_component (tenant_id, code, name, annual_cap, note, icon)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, code)
             DO UPDATE SET name = EXCLUDED.name, annual_cap = EXCLUDED.annual_cap,
                           note = EXCLUDED.note, icon = EXCLUDED.icon`,
      [tenant, code, name, cap, note, icon]);
  }
  for (const [code, title, cat, provider, hours, mandatory] of COURSES) {
    await q(`INSERT INTO course (tenant_id, code, title, category, provider, hours,
                               mandatory, due_on)
             VALUES ($1,$2,$3,$4,$5,$6,$7,
                     CASE WHEN $7 THEN CURRENT_DATE + 90 ELSE NULL END)
             ON CONFLICT (tenant_id, code)
             DO UPDATE SET title = EXCLUDED.title, category = EXCLUDED.category,
                           hours = EXCLUDED.hours, mandatory = EXCLUDED.mandatory`,
      [tenant, code, title, cat, provider, hours, mandatory]);
  }
  for (const [code, name, status, note] of SECURITY_CONTROLS) {
    await q(`INSERT INTO security_control (tenant_id, code, name, framework, status, note)
             VALUES ($1,$2,$3,'Baseline',$4,$5)
             ON CONFLICT (tenant_id, code)
             DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, note = EXCLUDED.note`,
      [tenant, code, name, status, note]);
  }
  for (const [code, name, instant, approval] of LETTER_TYPES) {
    await q(`INSERT INTO letter_type (tenant_id, code, name, instant, requires_approval)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (tenant_id, code)
             DO UPDATE SET name = EXCLUDED.name, instant = EXCLUDED.instant,
                           requires_approval = EXCLUDED.requires_approval`,
      [tenant, code, name, instant, approval]);
  }
  for (const [code, name, quota, carry, encash] of LEAVE_TYPES) {
    await q(`INSERT INTO leave_type (tenant_id, code, name, annual_quota, carry_forward_max, encashable)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [tenant, code, name, quota, carry, encash]);
  }
  created.push(`${DEPARTMENTS.length} departments, ${SITES.length} sites, ${PROJECTS.length} projects, ${ASSET_CATEGORIES.length} asset categories, ${EXPENSE_CATEGORIES.length} expense categories, ${TICKET_CATEGORIES.length} ticket categories, `
    + `${GRADES.length} grades, ${LEAVE_TYPES.length} leave types, ${SHIFTS.length} shifts, `
    + `${LETTER_TYPES.length} letter types, ${SECURITY_CONTROLS.length} security controls, `
    + `${COURSES.length} courses, ${FBP_COMPONENTS.length} benefit components`);

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
    // shift_id is NOT NULL since 0015: a person with no shift has no hours to
    // be judged against, so attendance cannot say whether they were late.
    const shift = (await q('SELECT id FROM shift WHERE code = $1', ['IN'])).rows[0].id;

    employeeId = (await q(
      `INSERT INTO employee (tenant_id, code, full_name, work_email, legal_entity_id,
                             joined_on, department_id, site_id, grade_id, shift_id,
                             designation, app_role, currency)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, $8, $9, 'Administrator', 'admin', 'INR')
       ON CONFLICT (tenant_id, code)
       DO UPDATE SET work_email = EXCLUDED.work_email, full_name = EXCLUDED.full_name
       RETURNING id`,
      [tenant, adminCode, adminName ?? adminEmail.split('@')[0], adminEmail, entity, hr, chn, l6, shift],
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
    created.push(`admin employee ${adminCode} ${adminName ?? ''} <${adminEmail}> with leave balances`);
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
