/*
 * Convert `caller.role` comparisons into policy questions.
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
 *
 * Idempotent: running it twice changes nothing the second time.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NL = String.fromCharCode(10);

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
  expenses: 'expenses',
  exports: 'exports',
  jobtitles: 'jobtitles',
  helpdesk: 'helpdesk',
  hiring: 'hiring',
  joiners: 'onboarding',
  leave: 'leave',
  learning: 'learning',
  letters: 'documents',
  lifecycle: 'lifecycle',
  loans: 'benefits',
  noticeboard: 'announcements',
  onboarding: 'onboarding',
  people: 'employees',
  planner: 'planner',
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
};

/** Files inside a module beyond service.ts. */
const EXTRA = {
  config: ['permissions.ts'],
  users: ['import.ts', 'loginHistory.ts'],
};

/*
 * The verb an `!== 'admin'` gate means. Most guard a write; a few guard the
 * whole module's readability.
 */
const WRITE_VERB_FILES = new Set([
  'config', 'security', 'users', 'staffing', 'projects', 'schedules',
]);

/*
 * The verb an act means where it is not simply a write.
 *
 * Deciding somebody else's request is approving. Several of these gates guard
 * a decision — an asset request, a leave request, an expense claim — and the
 * policy grants the manager layer `approve` where it grants `write` only
 * `own`, so calling it a write would refuse the manager the layer exists for.
 */
const ACT_VERB = {
  assets: 'approve',
  attendance: 'approve',
  devplans: 'approve',
  expenses: 'approve',
  helpdesk: 'approve',
  learning: 'approve',
  leave: 'approve',
};

const main = async () => {
  const { POLICY } = await import('../src/auth/policy.ts');
  const known = new Set(Object.keys(POLICY));
  const bad = Object.entries(MODULE).filter(([, m]) => !known.has(m));
  if (bad.length) {
    console.error('module keys not in POLICY, which would deny everybody:');
    for (const [dir, m] of bad) console.error(`  ${dir} -> ${m}`);
    process.exit(1);
  }
  console.log(`all ${Object.keys(MODULE).length} module keys exist in POLICY${NL}`);

  let touched = 0;
  let sites = 0;

  for (const [dir, module] of Object.entries(MODULE)) {
    const files = [`src/modules/${dir}/service.ts`,
      ...(EXTRA[dir] ?? []).map((f) => `src/modules/${dir}/${f}`)];

    for (const file of files) {
      let s;
      try { s = readFileSync(file, 'utf8'); } catch { continue; }
      const before = s;
      const verb = WRITE_VERB_FILES.has(dir) ? 'write' : 'read';

      /*
       * `=== 'employee'` asked whether somebody reaches only themselves. In
       * the old three-role model employee meant self, manager meant team and
       * admin meant all, so it is exactly "does not reach team".
       *
       * Per line, because the verb depends on what the line does: a refusal
       * names the act it guards, while a query fragment or a display flag is a
       * read. That is what lets the policy narrow a site the old code was
       * looser about — and the narrowings are reported, not hidden.
       */
      s = s.split(NL).map((line) => {
        if (!line.includes("caller.role === 'employee'")
          && !line.includes("caller.role !== 'employee'")) return line;
        const acts = /throw |refuse\(|Error\(/.test(line)
          || /\b(add|issue|take|decide|approve|reject|create|endorse|assign)\b/i.test(line);
        const v = acts ? (ACT_VERB[dir] ?? 'write') : 'read';
        return line
          .split("caller.role === 'employee'")
          .join(`!reaches(caller, '${module}', '${v}', 'team')`)
          .split("caller.role !== 'employee'")
          .join(`reaches(caller, '${module}', '${v}', 'team')`);
      }).join(NL);

      /* An action gate: refuse unless they reach the whole company. */
      s = s.split("caller.role !== 'admin'")
        .join(`!reaches(caller, '${module}', '${verb}', 'all')`);
      s = s.split("caller.role === 'admin'")
        .join(`reaches(caller, '${module}', '${verb}', 'all')`);
      /*
       * `=== 'manager'` asked whether somebody answers for other people, which
       * is a fact about the reporting tree rather than a role.
       */
      s = s.split("caller.role === 'manager'").join('caller.hasReports');
      s = s.split("caller.role !== 'manager'").join('!caller.hasReports');

      if (s === before) continue;

      for (const pat of ["caller.role !== 'admin'", "caller.role === 'admin'",
        "caller.role === 'manager'", "caller.role !== 'manager'",
        "caller.role === 'employee'", "caller.role !== 'employee'"]) {
        sites += before.split(pat).length - 1;
      }

      if (!/from '\.\.\/\.\.\/auth\/can\.ts'/.test(s)) {
        const first = s.split(NL).find((l) => l.startsWith('import '));
        s = s.replace(first, `import { reaches } from '../../auth/can.ts';${NL}${first}`);
      }
      writeFileSync(file, s);
      touched += 1;
      console.log(`  ${file.replace('src/modules/', '').padEnd(32)} ${module}`);
    }
  }
  console.log(`${NL}${touched} file(s), ${sites} site(s)`);
};

await main();
