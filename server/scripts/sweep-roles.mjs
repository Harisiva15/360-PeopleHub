/*
 * Convert the remaining `caller.role` comparisons into policy questions.
 *
 * Kept in the repository rather than a scratch directory because the mapping is
 * the reviewable part: which module owns each service's data, and which verb
 * each gate means. Delete it once the sweep is done and role-gates.ts is what
 * keeps the comparisons from coming back.
 *
 * A wrong module key is the dangerous mistake here, not a missed site: an
 * unknown module answers `none` for every verb, so a typo denies everybody
 * silently instead of failing loudly. Every key below is checked against
 * POLICY before a single file is written.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/*
 * Service directory -> the policy module that owns its data.
 *
 * Several differ, which is the whole reason this is written down: `config`
 * serves `settings`, `exits` serves `exit`, `joiners` serves `onboarding`,
 * `projects` serves `planner`, `schedules` serves `shifts`, and `calendar`
 * serves somebody's attendance.
 */
const MODULE = {
  approvals: 'approvals',
  assets: 'assets',
  attendance: 'attendance',
  calendar: 'attendance',
  config: 'settings',
  devplans: 'devplans',
  documents: 'documents',
  employees: 'employees',
  events: 'events',
  exits: 'exit',
  exports: 'exports',
  helpdesk: 'helpdesk',
  hiring: 'hiring',
  joiners: 'onboarding',
  leave: 'leave',
  learning: 'learning',
  performance: 'performance',
  projects: 'planner',
  recruitment: 'recruitment',
  reports: 'reports',
  schedules: 'shifts',
  security: 'security',
  shifts: 'shifts',
  software: 'software',
  staffing: 'bench',
  timesheet: 'timesheet',
  users: 'users',
  /* Named for what they serve rather than what they are called. */
  letters: 'documents',
  loans: 'benefits',
  lifecycle: 'lifecycle',
  noticeboard: 'announcements',
  onboarding: 'onboarding',
  people: 'employees',
};

/* Files inside a module beyond service.ts. */
const EXTRA = {
  config: ['permissions.ts'],
  users: ['import.ts', 'loginHistory.ts'],
};

/*
 * The verb a shape means.
 *
 *   a gate that throws        the act it guards, so 'write' unless named
 *   a SQL scope fragment      'read' — it decides which rows come back
 *   a rendering flag          'read' — it decides what a column shows
 */
const WRITE_VERB_FILES = new Set([
  'config', 'security', 'users', 'staffing', 'projects', 'schedules',
]);

const main = async () => {
  const { POLICY } = await import('../src/auth/policy.ts');
  const known = new Set(Object.keys(POLICY));
  const bad = Object.entries(MODULE).filter(([, m]) => !known.has(m));
  if (bad.length) {
    console.error('module keys not in POLICY, which would deny everybody:');
    for (const [dir, m] of bad) console.error(`  ${dir} -> ${m}`);
    process.exit(1);
  }
  console.log(`all ${Object.keys(MODULE).length} module keys exist in POLICY\n`);

  let changed = 0;
  let sites = 0;

  for (const [dir, module] of Object.entries(MODULE)) {
    const files = [`src/modules/${dir}/service.ts`,
      ...(EXTRA[dir] ?? []).map((f) => `src/modules/${dir}/${f}`)];
    for (const file of files) {
      let s;
      try { s = readFileSync(file, 'utf8'); } catch { continue; }
      const before = s;
      const verb = WRITE_VERB_FILES.has(dir) ? 'write' : 'read';

      /* An action gate: refuse unless they reach the whole company. */
      s = s.split("caller.role !== 'admin'")
        .join(`!reaches(caller, '${module}', '${verb}', 'all')`);
      /* The same question the other way up. */
      s = s.split("caller.role === 'admin'")
        .join(`reaches(caller, '${module}', '${verb}', 'all')`);
      /*
       * `=== 'manager'` asked whether somebody answers for other people, which
       * is now a fact about the reporting tree rather than a role.
       */
      s = s.split("caller.role === 'manager'").join('caller.hasReports');
      s = s.split("caller.role !== 'manager'").join('!caller.hasReports');

      if (s === before) continue;

      /* Count what changed, for the report. */
      for (const pat of ["caller.role !== 'admin'", "caller.role === 'admin'",
        "caller.role === 'manager'", "caller.role !== 'manager'"]) {
        sites += before.split(pat).length - 1;
      }

      if (!/from '\.\.\/\.\.\/auth\/can\.ts'/.test(s)) {
        const first = s.split('\n').find((l) => l.startsWith('import '));
        s = s.replace(first, `import { reaches } from '../../auth/can.ts';\n${first}`);
      }
      writeFileSync(file, s);
      changed += 1;
      console.log(`  ${dir.padEnd(13)} -> ${module.padEnd(13)} ${verb}`);
    }
  }
  console.log(`\n${changed} file(s), ${sites} site(s)`);
};

await main();
