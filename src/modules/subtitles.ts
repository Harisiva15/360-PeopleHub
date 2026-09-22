/**
 * The line under each page title, keyed by route.
 *
 * These live here rather than on the module because the shell paints the
 * header before the route's code has loaded — a module that is code-split
 * cannot supply its own subtitle without the header flashing empty.
 *
 * That places a rule on what a subtitle may say: only the session and static
 * configuration. Anything counted from records would need a service call, and
 * this is a synchronous read. Counts belong in the page, or in the sidebar
 * pills, which do come from the service.
 */

import { DEPTS } from '../data/org';
import { ORG } from '../data/org';
import { SCOPE } from '../state/rbac';
import type { ModuleCtx } from './registry';

export const SUBTITLES: Record<string, (ctx: ModuleCtx) => string> = {
  dashboard: (c) => 'Welcome back, ' + c.me.name.split(' ')[0] + ' · ' + new Date().toDateString(),
  planner: () => 'Boards, iterations and the action items that come out of meetings',
  attendance: () => 'Punch in/out with location verification against site geo-fences',
  shifts: () => 'Plan and manage employee schedules, shifts and availability',
  timesheet: () => 'Track and manage your work hours, projects and tasks',
  leave: () => 'Balances, requests and the company holiday calendar',
  expenses: () => 'Claims, travel advances and policy limits · reimbursed with payroll',
  approvals: () => 'Everything waiting on your action',

  employees: (c) => SCOPE[c.role].label,
  org: () => `Reporting structure across ${DEPTS.length} departments`,
  celebrations: () => 'Birthdays, work anniversaries and milestones',
  announcements: () => 'Company-wide communication',
  engagement: () => 'Pulse surveys, eNPS and the action tracker',
  assets: (c) =>
    (c.role === 'employee'
      ? 'Equipment issued to you'
      : 'The register, allocations, requests and depreciation'),
  helpdesk: () => 'Ticketing with SLAs, plus a self-service knowledge base',

  payroll: () => 'India payroll · PF, ESI, Professional Tax and TDS',
  tax: () => `${ORG.fy} · ${ORG.ay} · Form 12BB investment declaration`,
  benefits: () => 'Insurance, perks, flexible benefit plan, loans and advances',

  performance: () => 'Goals, reviews, 9-box calibration and recognition',
  learning: () => 'Catalogue, certifications and compliance training tracked to completion',
  hiring: () => 'Requisitions, pipeline, interviews and offers for our own roles',
  recruitment: () => 'Manage open requirements, recruiter activity, candidate submissions and hiring progress',
  users: () => 'Create, manage and control user accounts across 360 People Hub',
  jobtitles: () => 'Manage job titles, roles, levels and organisational positions',
  lifecycle: () => 'Track every employment journey from offer through to alumni',
  software: () => 'Licences, seats, renewals and what the idle ones cost',
  devplans: () => 'Where people are heading, and what will get them there',
  events: () => 'What is on, who is coming, and how many seats are left',
  exports: () => 'Take data out, and the record of who took what',
  customreports: () => 'Questions somebody saved — each one answered for whoever asks it',
  integrations: () => 'What this tenant is connected to, and what it is not',
  onboarding: () => 'Pre-boarding checklists from offer accepted to day one',
  exit: () => 'Notice periods, clearance and full-and-final settlement',

  clients: () => 'Accounts, statements of work and rate cards',
  requirements: () => 'The demand book, the pipeline and submission analytics',
  bench: () => 'Consultants between assignments, and what they cost',
  placements: () => 'Live assignments, rates and blended margin',
  billing: () => 'Invoices, receivables ageing and the billing run',
  vendors: () => 'The supplier panel, scorecards and compliance',

  exec: () => 'Trading, people and cash — one page for the board',
  reports: () => 'Cross-module analytics, exportable to CSV',
  documents: () => 'Self-service letters and the document repository',
  security: () => 'Posture, access review, audit trail and data retention',
  settings: () => 'Access control, policy and company configuration',
};
