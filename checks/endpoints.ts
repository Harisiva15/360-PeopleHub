/**
 * Every endpoint the frontend calls exists on the server, with that method.
 *
 * ## The gap this fills
 *
 * Nothing checked this. `check:coverage` proves each service method is wired to
 * the HTTP layer rather than the mock; `check:reachable` proves a screen calls
 * it; the server's `check:routes` proves route *order* is sane; `check:shape`
 * compares response shapes but needs a live session and skips without one.
 *
 * Between them they leave the join itself unverified: the frontend says
 * `api.put('/projects/P-X/status')` and the server declares
 * `PUT /projects/:code/status`, and the only thing that has ever confirmed
 * those agree is someone reading both files. A typo, a method changed on one
 * side, a route renamed in a refactor — each compiles, typechecks, passes every
 * other gate, and produces a 404 the first time a person clicks the button.
 * That is precisely the failure mode of "the UI works but the feature does
 * not".
 *
 * ## How the two sides are compared
 *
 * Both are reduced to `METHOD /path/with/:params`:
 *
 *   - Frontend: every `api.get|post|put|patch|del(...)` in the HTTP service,
 *     with `${…}` interpolations collapsed to `:p` and any `${qs({…})}` query
 *     suffix dropped. A query string is not part of a route.
 *   - Server: every `{ method, pattern }` pair in the route table, with its
 *     `:name` segments likewise collapsed to `:p`.
 *
 * Collapsing both sides' parameters to the same token is deliberate: the names
 * need not agree, only the shape. `/{id}/team` and `/:empId/team` are the same
 * route, and insisting on matching names would produce failures that are not
 * bugs.
 *
 * Read as text rather than imported. `app.ts` opens a database pool and starts
 * a server at import time, and a check must not need production credentials to
 * tell you a path is misspelled.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
const fail = (msg: string) => { failed += 1; console.error(`  FAIL  ${msg}`); };

const VERB: Record<string, string> = {
  get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE',
};

/** `${…}` to `:p`, and a trailing query string removed. */
function normalise(path: string): string {
  let p = path;
  /*
   * `${qs(…)}` is a query string, never part of the route. Its argument is
   * sometimes an object literal and sometimes a bare variable — `qs(q)` — so
   * the match allows one level of nesting rather than assuming braces.
   */
  p = p.replace(/\$\{qs\((?:[^()]|\([^()]*\))*\)\}/g, '');
  p = p.replace(/\$\{[^}]*\}/g, ':p');
  /* A literal query the call wrote out itself. */
  p = p.split('?')[0]!;
  return p.replace(/\/+$/, '') || '/';
}

/* ---------------- what the frontend asks for ---------------- */

const client = strip(readFileSync(join(root, 'src/services/http/index.ts'), 'utf8'));

interface Call { method: string; path: string; raw: string; }
const calls: Call[] = [];

/*
 * `api.<verb>` with an optional type argument, then a backtick or single-quoted
 * first argument. The type argument may itself hold braces and angle brackets
 * (`api.get<{ body: string }>`), so it is matched loosely up to the paren.
 */
const CALL = /api\.(get|post|put|patch|del)\s*(?:<[^(]*?>)?\s*\(\s*(`[^`]*`|'[^']*')/g;
let m: RegExpExecArray | null;
while ((m = CALL.exec(client)) !== null) {
  const raw = m[2]!.slice(1, -1);
  calls.push({ method: VERB[m[1]!]!, path: normalise(raw), raw });
}

/* ---------------- what the server declares ---------------- */

const app = strip(readFileSync(join(root, 'server/src/http/app.ts'), 'utf8'));

interface Route { method: string; pattern: string; }
const routes: Route[] = [];
{
  const token = /\b(method|pattern):\s*'([^']+)'/g;
  let pending: string | null = null;
  let t: RegExpExecArray | null;
  while ((t = token.exec(app)) !== null) {
    if (t[1] === 'method') pending = t[2]!;
    else if (pending) { routes.push({ method: pending, pattern: t[2]! }); pending = null; }
  }
}

const shape = (p: string) => p.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p').replace(/\/+$/, '') || '/';
const routeKeys = new Set(routes.map((r) => `${r.method} ${shape(r.pattern)}`));
const routePaths = new Map<string, Set<string>>();
for (const r of routes) {
  const k = shape(r.pattern);
  if (!routePaths.has(k)) routePaths.set(k, new Set());
  routePaths.get(k)!.add(r.method);
}

console.log(`\n${calls.length} frontend calls, ${routes.length} server routes\n`);

if (calls.length < 300) fail(`only ${calls.length} calls parsed — the matcher has drifted`);
if (routes.length < 300) fail(`only ${routes.length} routes parsed — the matcher has drifted`);

/* ---------------- every call must have a route ---------------- */

const missing: Call[] = [];
const wrongMethod: { call: Call; has: string[] }[] = [];

for (const c of calls) {
  const key = `${c.method} ${c.path}`;
  if (routeKeys.has(key)) continue;
  const methods = routePaths.get(c.path);
  if (methods) wrongMethod.push({ call: c, has: [...methods].sort() });
  else missing.push(c);
}

const seen = new Set<string>();
for (const c of missing) {
  const k = `${c.method} ${c.path}`;
  if (seen.has(k)) continue;
  seen.add(k);
  fail(`the frontend calls ${c.method} ${c.path} and no server route matches`);
  console.error(`          written as \`${c.raw}\``);
}
for (const { call, has } of wrongMethod) {
  const k = `${call.method} ${call.path}`;
  if (seen.has(k)) continue;
  seen.add(k);
  fail(`the frontend calls ${call.method} ${call.path}`
    + ` but the server only answers ${has.join(', ')} there`);
  console.error(`          written as \`${call.raw}\``);
}

if (!missing.length && !wrongMethod.length) {
  console.log(`  ok    all ${new Set(calls.map((c) => `${c.method} ${c.path}`)).size}`
    + ' distinct frontend endpoints exist on the server, with the right method');
}

/* ---------------- routes nothing calls ---------------- */

/**
 * A route the frontend never calls.
 *
 * Not a failure on its own — some exist for an operator, a health check or a
 * script — but each is either that, or a feature finished on the server and
 * unreachable from the app, which is worth stating out loud rather than
 * discovering later.
 */
const callKeys = new Set(calls.map((c) => `${c.method} ${c.path}`));
const uncalled = routes
  .filter((r) => !callKeys.has(`${r.method} ${shape(r.pattern)}`))
  .map((r) => `${r.method} ${r.pattern}`)
  .sort();

/**
 * Routes legitimately not called by the SPA, and why.
 *
 * Empty, and the list checks itself: an entry whose route the frontend *does*
 * call is reported, which is how `GET /health` and `POST /auth/claim` came off
 * it — both are called through the service layer like anything else.
 */
const OPERATOR: Record<string, string> = {};

const orphans = uncalled.filter((u) => !OPERATOR[u]);
console.log(`\n${uncalled.length} server routes are not called by the frontend`);
for (const u of uncalled) {
  console.log(`  ${u.padEnd(52)} ${OPERATOR[u] ?? '— nothing in the app calls this'}`);
}
for (const k of Object.keys(OPERATOR)) {
  if (!uncalled.includes(k)) {
    fail(`${k} is listed as operator-only but the frontend calls it — drop the entry`);
  }
}

console.log(failed
  ? `\n${failed} problem(s)\n`
  : `\nthe frontend and the server agree on every endpoint`
    + `${orphans.length ? `; ${orphans.length} server route(s) are unused` : ''}\n`);
process.exit(failed ? 1 : 0);
