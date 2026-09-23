/*
 * Can every service the product actually uses create the thing it lists?
 *
 * The same gap appeared four times: a service with plenty of list/get methods
 * and no way to add a record, so the screen renders whatever the seed generated
 * and a user cannot add to it. Announcements could be read but not posted;
 * recruitment could move candidates but not take a submission; IT assets could
 * approve requests nobody could raise; onboarding could tick a checklist on
 * journeys only a hired ATS candidate could produce.
 *
 * Each was found by a person noticing a screen felt inert. This finds it
 * instead.
 *
 * The creator is named per service rather than guessed from the method name. A
 * first attempt matched verbs — and read `openRequirements`, `posture` and
 * `enrolments` as creators, which is exactly the kind of false positive that
 * gets a check switched off. Naming them is more typing and cannot be wrong
 * quietly: if the named method disappears, this fails.
 *
 *   vite-node checks/contract-shape.ts
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/services/contracts.ts', import.meta.url), 'utf8');

/** The method that brings a new record into existence, per service. */
const CREATES: Record<string, string> = {
  attendance: 'punchIn',
  // setStructure, not saveComponent: a component is the company's formula and
  // a structure is the record this service exists to write. Naming the
  // component creator would let this pass while nobody's pay could be set.
  compensation: 'setStructure',
  timesheet: 'forWeek',
  expenses: 'submitClaim',
  shifts: 'raiseOvertime',
  hiring: 'openRequisition',
  recruitment: 'createJobOrder',
  users: 'create',
  software: 'create',
  devPlans: 'create',
  events: 'create',
  reports: 'create',
  // The only records the lifecycle owns are tasks. The stage is derived and
  // the people come from onboarding, the ATS and the payroll — which is the
  // point of the module, so there is nothing else here to create.
  lifecycle: 'addTask',
  // An export creates a register entry, not a dataset. `run` is the only
  // thing in the service that writes anything at all.
  exports: 'run',
  // The catalogue is a description of the product and is not created. What
  // this service does own is endpoints and keys, and an endpoint is the one
  // a screen adds first.
  integrations: 'createWebhook',
  jobTitles: 'create',
  learning: 'enrol',
  helpdesk: 'raise',
  noticeboard: 'post',
  // addAsset, not requestAsset: a request is a secondary record. Naming the
  // request creator let this check pass while the register itself -- the thing
  // the service is named after and mostly lists -- could not be filled at all.
  assets: 'addAsset',
  onboarding: 'create',
  config: 'addHoliday',
  leave: 'apply',
  joiners: 'request',
  planner: 'createItem',
  letters: 'issue',
  // requestDocument, not an upload: what this service owns is the asking, which
  // has an answer from the day the offer goes out and long before any file
  // exists. Attaching the file still needs object storage this deployment does
  // not have.
  documents: 'requestDocument',
};

/**
 * Services that legitimately create nothing, and why.
 *
 * Every entry is a claim someone can check. When a service moves into scope it
 * comes off this list rather than the check being loosened.
 */
const ALLOWED: Record<string, string> = {
  employees: 'people are created by joiners and onboarding, not here',
  payroll: 'a cycle is opened by currentRun and closed by processRun',
  loans: 'loan origination is out of scope for this release',
  performance: 'goal and review authoring is out of scope for this release',
  engagement: 'survey authoring is out of scope; results are read-only',
  benefits: 'plan components are configuration; employees declare against them',
  exits: 'an exit is raised by the employee lifecycle, not typed in',
  staffing: 'the staffing book is out of scope for this release',
  security: 'the audit log is written by the modules being audited, never directly',
  approvals: 'a view over other modules queues, owning no records of its own',
};

const reg = src.slice(src.indexOf('export interface Services {'));
const services = [...reg.slice(0, reg.indexOf('\n}')).matchAll(/^  (\w+): (\w+);/gm)]
  .map((m) => ({ key: m[1]!, type: m[2]! }));

let failed = 0;
const fail = (msg: string, detail?: string) => {
  failed += 1;
  console.error(`  FAIL  ${msg}${detail ? `\n        ${detail}` : ''}`);
};

for (const { key, type } of services) {
  const i = src.indexOf(`export interface ${type} {`);
  if (i < 0) { fail(`${key}: no interface ${type} found`); continue; }
  const body = src.slice(i, src.indexOf('\n}', i));
  const methods = new Set(
    [...body.matchAll(/^  ([a-zA-Z]\w*)(?:<[^>]*>)?\(/gm)].map((m) => m[1]!));

  const creator = CREATES[key];
  const exempt = key in ALLOWED;

  if (!creator && !exempt) {
    fail(`${key} lists records but names no way to create one`,
      `methods: ${[...methods].join(', ')}\n        `
      + 'add its creator to CREATES, or add it to ALLOWED with a reason');
  } else if (creator && exempt) {
    fail(`${key} is in both CREATES and ALLOWED`, 'it cannot be both');
  } else if (creator && !methods.has(creator)) {
    fail(`${key}.${creator}() is named as its creator but no longer exists`,
      `methods: ${[...methods].join(', ')}`);
  }
}

/* Every service must be accounted for one way or the other. */
const known = new Set([...Object.keys(CREATES), ...Object.keys(ALLOWED)]);
for (const k of known) {
  if (!services.some((s) => s.key === k)) {
    fail(`${k} is listed here but is not a service any more`, 'remove the stale entry');
  }
}

console.log(`\nchecked ${services.length} services`);
console.log(`  ${Object.keys(CREATES).length} can create, each by a named method`);
console.log(`  ${Object.keys(ALLOWED).length} exempt, each with a stated reason`);

if (!failed) console.log('\nevery in-scope service can create what it lists');
else console.error(`\n${failed} contract shape check(s) FAILED`);
process.exit(failed ? 1 : 0);
