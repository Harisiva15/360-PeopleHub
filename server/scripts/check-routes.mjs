/**
 * Route order: a literal must precede the parameter that would swallow it.
 *
 * The router in http/app.ts matches in array order and stops at the first hit.
 * So `GET /users/:id` placed above `GET /users/login-history` means the second
 * one is unreachable — every request to it is answered by getUser with "id"
 * set to the literal string "login-history", which fails with a message about
 * a missing account rather than anything resembling the truth.
 *
 * There is a comment on `routes` saying to keep literals above parameters.
 * That comment was there, was read, and the mistake was made anyway, four
 * hundred lines below where it is written. A comment is a reminder; this is
 * the check. It reads the source rather than importing it, because importing
 * app.ts opens a database pool and starts a server.
 *
 * The fix when this fails is always the same: move the literal route above the
 * parameterised one. Never rename the literal to dodge the collision.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// An argument overrides the target, so the check can be run against a
// deliberately broken copy to prove it still catches the thing it is for.
const target = process.argv[2] ?? join(here, '..', 'src', 'http', 'app.ts');
const source = readFileSync(target, 'utf8');

/**
 * Every `method:` / `pattern:` pair, in source order.
 *
 * Both spellings occur: a one-line route object and a multi-line one. The
 * fields are always in that order, and `method` is always the first of the
 * two, so one scan over the file in order recovers the pairs without parsing
 * TypeScript.
 */
function routesInOrder(text) {
  const found = [];
  const token = /\b(method|pattern):\s*'([^']+)'/g;
  let pendingMethod = null;
  let m;
  while ((m = token.exec(text)) !== null) {
    if (m[1] === 'method') pendingMethod = m[2];
    else if (pendingMethod) {
      found.push({ method: pendingMethod, pattern: m[2] });
      pendingMethod = null;
    }
  }
  return found;
}

/** Would `pattern` match the concrete path `literal` walks? */
function swallows(pattern, literal) {
  const a = pattern.split('/');
  const b = literal.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

const routes = routesInOrder(source);

// Vacuity guard. A regex that silently stops matching would otherwise report
// a clean run over nothing at all, which is the failure mode this whole file
// exists to prevent elsewhere.
if (routes.length < 100) {
  console.error(
    `FAIL  only ${routes.length} routes parsed out of app.ts — expected well over 100.\n`
    + '      The route literals have changed shape and this check is now blind.');
  process.exit(1);
}

const problems = [];
for (let i = 0; i < routes.length; i += 1) {
  const later = routes[i];
  // Only a pattern with no parameters has a single concrete path to test.
  if (later.pattern.includes(':')) continue;
  for (let j = 0; j < i; j += 1) {
    const earlier = routes[j];
    if (earlier.method !== later.method) continue;
    if (!earlier.pattern.includes(':')) continue;
    if (swallows(earlier.pattern, later.pattern)) {
      problems.push(
        `${later.method} ${later.pattern} is unreachable — `
        + `${earlier.method} ${earlier.pattern} is declared above it and matches first.`);
    }
  }
}

const parameterised = routes.filter((r) => r.pattern.includes(':')).length;
console.log(
  `${routes.length} routes checked `
  + `(${routes.length - parameterised} literal, ${parameterised} parameterised)`);

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`);
  console.error('\nMove the literal route above the parameterised one.');
  process.exit(1);
}

console.log('every literal route is reachable');
