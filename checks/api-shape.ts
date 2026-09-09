/*
 * Does the API return the shape the contract promises?
 *
 * TypeScript cannot see across a network: `api.get<Employee[]>` asserts a type
 * rather than checking one, so a server returning a different shape typechecks
 * perfectly and renders blank fields. That is exactly what happened when the
 * first endpoints shipped returning an EmployeeSummary while the screens
 * expected a 40-field Employee.
 *
 * This compares a live response against the mock's own object — the mock being
 * the executable specification the screens were built against.
 *
 * Needs a running API and a session, so it skips when unconfigured:
 *   API_URL=http://localhost:8080 API_TOKEN=<jwt> vite-node checks/api-shape.ts
 */
import { mockServices } from '../src/services/mock';

const url = process.env.API_URL;
const token = process.env.API_TOKEN;

if (!url || !token) {
  console.log('SKIPPED: set API_URL and API_TOKEN to compare live responses.');
  process.exit(0);
}

let failed = 0;

async function compare(path: string, reference: object, label: string) {
  const res = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.error(`  FAIL  ${label} — HTTP ${res.status} ${await res.text()}`);
    failed += 1;
    return;
  }
  const body = await res.json();
  const sample = Array.isArray(body) ? body[0] : body;
  if (!sample) {
    console.log(`  skip  ${label} — no rows to compare`);
    return;
  }

  const expected = new Set(Object.keys(reference));
  const actual = new Set(Object.keys(sample));
  const missing = [...expected].filter((k) => !actual.has(k));
  const extra = [...actual].filter((k) => !expected.has(k));

  if (missing.length || extra.length) {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    if (missing.length) console.error(`        missing: ${missing.join(', ')}`);
    if (extra.length) console.error(`        unexpected: ${extra.join(', ')}`);
  } else {
    console.log(`  ok    ${label} — all ${expected.size} contract fields present`);
  }
}

/* The mock's own row is the reference: it is what every screen was built to render. */
const [referenceEmployee] = await mockServices.employees.active();

await compare('/employees', referenceEmployee, 'GET /employees');
await compare('/employees/active', referenceEmployee, 'GET /employees/active');

console.log(failed ? `\n${failed} shape mismatch(es)` : '\napi shape matches the contract');
process.exit(failed ? 1 : 0);
