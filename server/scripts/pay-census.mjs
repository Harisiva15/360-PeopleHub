/**
 * Every read of a pay field, and the gate that actually guards it.
 *
 * ## Why this exists
 *
 * The role sweep turned `caller.role === 'admin'` into a policy question, and
 * where it had to pick a module it took the one from the file's own directory.
 * For most modules that is right. For pay it is not: a salary read from
 * `modules/employees` is compensation's to grant, not the directory's, and
 * gating it on `employees` would show a salary to anyone who may read the staff
 * list. That defect appeared four times and each was found by hand. This finds
 * them all at once, and goes on finding them.
 *
 * ## The hard part: the gate is usually not in the same function
 *
 * `storedSlip` reads eleven pay columns and guards nothing — it is a helper.
 * Whether that is safe depends entirely on who calls it. So this builds a call
 * graph and, for every pay-reading function, walks *up* to the nearest gated
 * ancestor. The answer for a read is the gate on the shallowest exported entry
 * point that can reach it, which is the thing an HTTP route can actually call.
 *
 * A function with no gated ancestor and no route is unreachable rather than
 * unguarded — `tax.totalsOf` is the standing example — so those are reported
 * separately instead of being called a finding.
 *
 * ## What counts as a pay field
 *
 * The monetary columns of the pay tables, taken from the migrations rather than
 * guessed, plus the contract field names the mappers emit, since a projection
 * may have aliased the column away. Matches inside error strings and inside
 * `interface`/`type` bodies are excluded: a column name in a message is not a
 * read, and a field in a declaration is not one either.
 *
 * Exits non-zero under --strict if any reachable pay read resolves to a gate
 * that asks about a non-pay module.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const NL = String.fromCharCode(10);
const STRICT = process.argv.includes('--strict');
const VERBOSE = process.argv.includes('--verbose');

/* The modules that may grant a pay read. Anything else is the wrong question. */
const PAY_MODULES = new Set(['compensation', 'payroll', 'tax', 'benefits', 'expenses']);

/**
 * Pay reads that are deliberately gated on something else, each with the reason.
 *
 * Keyed `file#function`. The point of the list is that it is short and that
 * every line had to be argued for: a new entry appearing in the report is a
 * finding, and adding it here is a decision somebody has to write down.
 */
const REVIEWED = new Map([
  ['src/modules/exits/service.ts#computeSettlement',
    'reads a loan balance and expense totals to settle an exit. `exit` read all '
    + 'is held by hr_admin, finance_admin and company_admin, and all three also '
    + 'hold expenses all and benefits all (which is what gates loans), so the '
    + 'gate grants a strict subset of the pay gate.'],
  ['src/modules/exits/service.ts#settleExit',
    'writes the settlement figures. Gated on `exit` approve all, which the policy '
    + 'defines as the settlement act itself — "settled by finance, which is why '
    + 'finance approves here and writes nothing".'],
  ['src/modules/hiring/service.ts#makeOffer',
    'offer.annual_ctc is a candidate\'s offer, not an employee\'s salary. '
    + 'Recruitment\'s to set.'],
  ['src/modules/hiring/service.ts#offerLetter',
    'same: the candidate\'s own offer letter.'],
  ['src/modules/hiring/service.ts#releaseOffer',
    'same: releasing the candidate\'s offer.'],
  ['src/modules/letters/service.ts#factsFor',
    'a salary certificate quotes the subject\'s own CTC. `requestLetter` refuses '
    + 'anyone else\'s without `documents` read all, held by hr_admin and '
    + 'company_admin only — a strict subset of compensation\'s readers, so the '
    + 'gate is narrower than the pay gate rather than wider.'],
  ['src/modules/payroll/rules.ts#structureFor',
    'arithmetic on a structure already fetched and already gated; it opens no '
    + 'connection. The resolved gate is whichever caller the walk reached first.'],
  ['src/modules/staffing/service.ts#kpi',
    '`outstanding` here is unpaid client invoices — accounts receivable, not an '
    + 'employee loan. Different domain that happens to share a word.'],
]);

const PAY_TABLES = [
  'payslip', 'payslip_line', 'pay_run', 'pay_input',
  'salary_structure', 'salary_structure_line', 'salary_component',
  'tax_declaration', 'tax_declaration_item',
  'fbp_plan', 'fbp_allocation', 'fbp_component',
  'loan', 'loan_repayment', 'loan_type',
  'expense_claim', 'expense_item',
  'bank_batch', 'compliance_payment', 'exit_settlement',
];

const PAY_COLUMNS = [
  'annual_ctc', 'annual_gross', 'annual_amount', 'monthly_amount', 'monthly_ctc',
  'net_pay', 'total_deductions', 'annual_tax', 'employer_pf', 'employer_esi',
  'tax_regime', 'reimbursements', 'loss_of_pay_days', 'flat_amount',
  'percent_of_code', 'interest_rate', 'principal_part', 'interest_part',
  'outstanding', 'total_amount', 'limit_amount', 'annual_cap',
  'salary_payable', 'leave_encashment', 'net_payable', 'tax_deducted',
];

const PAY_FIELDS = [
  'ctc', 'ifsc', 'uan', 'pan', 'acct', 'grossA', 'pfEmpr', 'gratuity', 'medIns',
  'netPay', 'deductions', 'basic', 'hra',
];

/* ---------------------------------------------------------------- collect */

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.ts')) files.push(p);
  }
}('src'));
files.sort();

const reTable = new RegExp(`(?:FROM|JOIN|INTO|UPDATE)\\s+(${PAY_TABLES.join('|')})\\b`, 'i');
const reColumn = new RegExp(`\\b(${PAY_COLUMNS.join('|')})\\b`);
const reField = new RegExp(`^\\s*(${PAY_FIELDS.join('|')})\\s*:`);
const reDecl = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/;
const reGate = /\b((?:assert|may|reaches|reachesPerson|scopeOf)[A-Za-z]*)\s*\(/g;
const reModule = /['"]([a-z]+)['"]\s*,\s*['"](?:read|write|approve)['"]/g;

/** Every function in the tree, keyed `path#name`. */
const fns = new Map();
/** Pay reads, each attached to the function it sits in. */
const reads = [];

for (const file of files) {
  const rel = relative('.', file).split('\\').join('/');
  const src = readFileSync(file, 'utf8');
  const lines = src.split(NL);

  /*
   * Which lines are inside a type declaration, and which are inside a template
   * literal that looks like SQL. A column name in an error message is not a
   * read; a field in an `interface` body is a shape, not a read either.
   */
  const inType = new Array(lines.length).fill(false);
  const inSql = new Array(lines.length).fill(false);
  let typeBlock = false;
  let tplStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    /*
     * A braced declaration runs until a closing brace at column 0; a one-line
     * `type X = ...;` is just that line. Resetting on any `;` ended the block
     * at the first field, which let `ctc: number;` in an interface be counted
     * as a read of somebody's salary.
     */
    if (!typeBlock && /^(?:export\s+)?(?:interface|type)\s+\w/.test(l)) {
      inType[i] = true;
      if (/\{\s*$/.test(l)) typeBlock = true;
      continue;
    }
    if (typeBlock) {
      inType[i] = true;
      if (/^\}/.test(l)) typeBlock = false;
    }
    const ticks = (l.match(/`/g) ?? []).length;
    if (tplStart >= 0) inSql[i] = true;
    if (ticks % 2 === 1) {
      if (tplStart < 0) { tplStart = i; inSql[i] = true; } else {
        const block = lines.slice(tplStart, i + 1).join(' ');
        const sqlish = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(block);
        for (let j = tplStart; j <= i; j += 1) inSql[j] = sqlish;
        tplStart = -1;
      }
    }
  }

  /*
   * Which names this file imported, and from where. Call edges are restricted
   * to the same file or an actual import: matching bare function names across
   * the whole tree invented edges, and one of them attributed an onboarding
   * salary read to a gate in helpdesk.
   */
  const importedBy = new Map();
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = join(file, '..', m[2]).split('\\').join('/');
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) importedBy.set(name, relative('.', target).split('\\').join('/'));
    }
  }

  /* Function ranges. A declaration at column 0 ends the previous one. */
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(reDecl);
    if (m && !inSql[i]) decls.push({ name: m[1] ?? m[2], start: i, exported: lines[i].startsWith('export') });
  }
  for (let d = 0; d < decls.length; d += 1) {
    decls[d].end = d + 1 < decls.length ? decls[d + 1].start : lines.length;
    const body = lines.slice(decls[d].start, decls[d].end).join(NL);
    const gates = new Set();
    const modules = new Set();
    let m;
    reGate.lastIndex = 0;
    while ((m = reGate.exec(body))) gates.add(m[1]);
    reModule.lastIndex = 0;
    while ((m = reModule.exec(body))) modules.add(m[1]);
    fns.set(`${rel}#${decls[d].name}`, {
      key: `${rel}#${decls[d].name}`,
      imports: importedBy,
      file: rel,
      name: decls[d].name,
      line: decls[d].start + 1,
      exported: decls[d].exported,
      gates: [...gates],
      modules: [...modules],
      body,
      callers: new Set(),
    });
  }

  const owner = (i) => {
    for (let d = decls.length - 1; d >= 0; d -= 1) if (i >= decls[d].start) return decls[d].name;
    return '(top level)';
  };

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (inType[i]) continue;
    if (l.trim().startsWith('*') || l.trim().startsWith('//')) continue;

    let what = null;
    const t = reTable.exec(l);
    const c = reColumn.exec(l);
    const f = reField.exec(l);
    if (t) what = `table ${t[1]}`;
    else if (c && inSql[i]) what = `column ${c[1]}`;
    else if (f) what = `field ${f[1]}`;
    if (!what) continue;

    reads.push({ file: rel, line: i + 1, fn: owner(i), what, key: `${rel}#${owner(i)}` });
  }
}

/* ------------------------------------------------------------ call graph */

const byName = new Map();
for (const fn of fns.values()) {
  if (!byName.has(fn.name)) byName.set(fn.name, []);
  byName.get(fn.name).push(fn);
}

for (const fn of fns.values()) {
  const called = new Set();
  /*
   * Not preceded by a dot, so `db.query(...)` is not read as a call to the
   * module-level `query` helper. It was: that one edge made every service
   * running SQL a caller of the employee directory's mapper, which put
   * `setEmployeeRole` in front of a pay read it never touches and buried the
   * genuine findings in noise.
   */
  for (const m of fn.body.matchAll(/(?<![.\w])([a-z]\w{2,})\s*\(/g)) called.add(m[1]);
  for (const name of called) {
    if (name === fn.name) continue;
    for (const target of byName.get(name) ?? []) {
      /* Same file, or a name this file actually imported from that file. */
      const sameFile = target.file === fn.file;
      const imported = fn.imports.get(name);
      const viaImport = imported !== undefined
        && (target.file === imported || target.file === `${imported}.ts`
          || target.file === imported.replace(/\.ts$/, '') + '.ts');
      if (sameFile || viaImport) target.callers.add(fn.key);
    }
  }
}

/*
 * A gate is usually a named helper — `assertOwnOrAdmin`, `maySeeAll` — and the
 * module it asks about lives in the helper's body, not at the call site. So
 * fold each helper's modules into its callers: without this the report says
 * "gated by assertOwnOrAdmin" and cannot say on what, which is the one thing
 * this census exists to answer.
 *
 * Unioned rather than used only as a fallback, because one function routinely
 * asks two different questions: `listVisibleEmployees` asks `employees` for
 * *which rows* and `compensation` for *whether they carry a salary*, and both
 * are right. Taking only the function's own modules judged it on the row
 * question and called a correct gate wrong.
 *
 * The cost is precision: this says "some gate here asks about pay", not "the
 * gate on this particular field asks about pay". Telling those apart needs
 * dataflow, and the per-path walk above is what carries the weight instead.
 */
/*
 * A caller that hands the mapper a literal `false` withholds pay outright.
 *
 * `getEmployeesByIds` resolves ids to names for screens that reference people,
 * and passes `false` — no salary ever materialises on that path, so judging it
 * on its row-scope gate called a deliberately blank read a finding. The flag is
 * always the last argument of `query`/`toEmployee`/`toJourney`/`load` in this
 * codebase, so it can be read directly rather than inferred.
 */
const reWithhold = /(?<![.\w])(?:query|toEmployee|toJourney|load)\s*\(([^;]*?)\)\s*[;,)]/gs;
for (const fn of fns.values()) {
  const passes = [];
  reWithhold.lastIndex = 0;
  for (const m of fn.body.matchAll(reWithhold)) {
    const args = m[1].split(',').map((a) => a.trim()).filter(Boolean);
    if (args.length > 1) passes.push(args[args.length - 1]);
  }
  fn.withholds = passes.length > 0 && passes.every((a) => a === 'false');
}

for (const fn of fns.values()) {
  const merged = new Set(fn.modules);
  for (const gate of fn.gates) {
    for (const helper of byName.get(gate) ?? []) {
      const sameFile = helper.file === fn.file;
      const imported = fn.imports.get(gate);
      if (!sameFile && helper.file !== imported) continue;
      for (const m of helper.modules) merged.add(m);
    }
  }
  if (merged.size) fn.modules = [...merged];
}

/**
 * The nearest gating ancestor along *every* path up, not just the first found.
 *
 * Returning one gate was a hole with teeth: `toEmployee` is reached from
 * `profile.ts`, which gates on compensation, and from `service.ts`, which gated
 * on the directory. A breadth-first search that stopped at the first gate it
 * liked reported the read as clean and the wrong gate stayed invisible — the
 * exact bug this census exists to find, hidden by the census.
 *
 * So a read is only clean when every path that reaches it is gated on pay.
 */
function resolveGates(key, seen = new Set(), out = new Map()) {
  const fn = fns.get(key);
  if (!fn || seen.has(key)) return out;
  seen.add(key);
  if (fn.gates.length) { out.set(key, fn); return out; }
  for (const up of fn.callers) resolveGates(up, seen, out);
  return out;
}

/** Whether anything exported can reach this function at all. */
function reachable(key, seen = new Set()) {
  const fn = fns.get(key);
  if (!fn || seen.has(key)) return false;
  seen.add(key);
  if (fn.exported) return true;
  for (const up of fn.callers) if (reachable(up, seen)) return true;
  return false;
}

/* ------------------------------------------------- mappers use their flag */

/*
 * A mapper handed a pay flag must consult it on every pay field.
 *
 * The call-graph half of this census asks whether *some* gate above a read is a
 * pay gate. That cannot see a mapper that takes `showPay` and then ignores it:
 * the gate is still there, still correct, and the salary comes out anyway. That
 * is exactly how `toJourney` emitted a joiner's CTC unconditionally while
 * `listOnboarding` looked properly guarded.
 *
 * So: find the functions that receive such a flag, and require every pay-field
 * line in them to mention it.
 */
const reFlag = /\b(showPay|showCompensation|withPay)\b/;
const flagMappers = [];
for (const fn of fns.values()) {
  const signature = fn.body.slice(0, fn.body.indexOf(')') + 1);
  const m = signature.match(reFlag);
  if (!m) continue;
  const flag = m[1];
  const ignored = [];
  for (const line of fn.body.split(NL)) {
    const f = reField.exec(line);
    if (!f) continue;
    if (line.includes(flag)) continue;
    /*
     * Only a field actually taken from the row can leak. `toEmployee` emits
     * `acct: ''` and `pan: null` unconditionally because this deployment
     * stores no bank details or national identifiers at all — see migration
     * 0003 — and a field that is always empty needs no flag to make it safe.
     */
    if (!/\br\.\w|\brow\./.test(line)) continue;
    ignored.push(`${f[1]} (${line.trim().slice(0, 48)})`);
  }
  flagMappers.push({ fn, flag, ignored });
}

/* --------------------------------------------------------------- report */

const rows = [];
for (const r of reads) {
  const gates = [...resolveGates(r.key).values()];
  /*
   * The worst path decides. A gate that asks about a module is judged on
   * whether that module is pay; a gate with no module argument is a self or
   * role-free check and is reported as such rather than scored.
   */
  const offending = gates.filter((g) => !g.withholds
    && g.modules.length && !g.modules.some((m) => PAY_MODULES.has(m)));
  const chosen = offending[0] ?? gates[0] ?? null;
  rows.push({
    ...r,
    gateAt: chosen ? `${chosen.file.replace('src/modules/', '')}:${chosen.line} ${chosen.name}` : null,
    gates: chosen ? chosen.gates.join(' ') : '',
    modules: chosen ? chosen.modules : [],
    paths: gates.length,
    offending: offending.length,
    reachable: reachable(r.key),
  });
}

const offModule = rows.filter((r) => r.offending > 0);
const reviewed = offModule.filter((r) => REVIEWED.has(`${r.file}#${r.fn}`));
const wrong = offModule.filter((r) => !REVIEWED.has(`${r.file}#${r.fn}`));
const unreachable = rows.filter((r) => !r.gateAt && !r.reachable);
const ungatedReachable = rows.filter((r) => !r.gateAt && r.reachable);
const ok = rows.filter((r) => r.gateAt && !offModule.includes(r));

const group = (list) => {
  const m = new Map();
  for (const r of list) {
    const k = `${r.file}#${r.fn}`;
    if (!m.has(k)) m.set(k, { ...r, fields: [] });
    m.get(k).fields.push(`${r.what.replace(/^(table|column|field) /, '')}:${r.line}`);
  }
  return [...m.values()];
};

console.log('');
console.log('Pay-field reads, and the gate that actually guards each');
console.log('='.repeat(74));

const show = (title, list, withGate) => {
  const g = group(list);
  console.log('');
  console.log(`## ${title} — ${list.length} reads in ${g.length} functions`);
  console.log('');
  if (!g.length) { console.log('  none'); return; }
  for (const r of g) {
    console.log(`  ${r.file}:${r.line}  ${r.fn}`);
    if (withGate) {
      console.log(`      gate   ${r.gateAt}  [${r.gates}]`);
      console.log(`      module ${r.modules.length ? r.modules.join(', ') : '(no module argument — own/self check)'}`);
    }
    if (VERBOSE) console.log(`      reads  ${r.fields.join(' ')}`);
  }
};

show('GATED ON A NON-PAY MODULE, NOT REVIEWED', wrong, true);
show('gated on a pay module, or on a self check', ok, true);
show('reachable but no gate found anywhere above', ungatedReachable, false);
show('unreachable: no gate and no exported caller', unreachable, false);

console.log('');
console.log(`## gated elsewhere, reviewed and accepted — ${reviewed.length} reads`);
console.log('');
for (const [key, why] of REVIEWED) {
  const hit = reviewed.find((r) => `${r.file}#${r.fn}` === key);
  const [file, fn] = key.split('#');
  console.log(`  ${hit ? ' ' : '!'} ${file.replace('src/modules/', '')} ${fn}`
    + `${hit ? '' : '   <- no longer present; drop this entry'}`);
  console.log(`      ${why.replace(/(.{1,66})(\s|$)/g, '$1' + NL + '      ').trim()}`);
}

const leaky = flagMappers.filter((m) => m.ignored.length);
console.log('');
console.log(`## mappers that take a pay flag — ${flagMappers.length}`);
console.log('');
for (const m of flagMappers) {
  console.log(`  ${m.ignored.length ? 'LEAKS' : 'ok   '} ${m.fn.file}:${m.fn.line} `
    + `${m.fn.name}(… ${m.flag})`);
  for (const i of m.ignored) console.log(`          ignores the flag for ${i}`);
}

console.log('');
console.log(`${rows.length} pay reads across ${new Set(rows.map((r) => r.file)).size} files`);
console.log(`  ${ok.length} resolve to a pay-module gate or a self check`);
console.log(`  ${reviewed.length} gated elsewhere, reviewed and accepted`);
console.log(`  ${wrong.length} gated on a non-pay module and NOT reviewed`);
console.log(`  ${ungatedReachable.length} reachable with no gate above them`);
console.log(`  ${unreachable.length} unreachable (helpers nothing exported calls)`);
console.log('');

if (STRICT && (wrong.length || ungatedReachable.length || leaky.length)) {
  if (wrong.length || ungatedReachable.length) {
    console.error('FAILED: a pay read is not guarded by a pay module.');
    console.error('Either fix the gate, or add it to REVIEWED with the argument for it.');
  }
  if (leaky.length) {
    console.error('FAILED: a mapper takes a pay flag and emits a pay field without it.');
  }
  process.exit(1);
}
if (STRICT) console.log('every pay read resolves to a pay gate, a self check, or a reviewed exception');
console.log('');
