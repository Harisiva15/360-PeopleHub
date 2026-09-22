/*
 * Last in the RNG chain, after the saved reports.
 */
import './reportdefs';

import { sortBy } from '../lib/collections';
import { addDays, TODAY, ymd } from '../lib/dates';
import { ri, uid } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';

/**
 * What this deployment is connected to.
 *
 * **Nothing here is invented, and that is the hard part of this module.**
 *
 * The obvious version of an integrations screen is a grid of logos with green
 * ticks against them. Every one of those ticks would be a lie: there is no
 * Slack app, no payroll feed, no calendar sync and no HRIS connector in this
 * system. A screen that said "Slack — Connected" would be a false assurance
 * somebody would repeat to a client, and the moment it mattered it would be
 * the reason they stopped trusting the whole product.
 *
 * So the state of each connection is *derived from configuration that actually
 * exists* — the environment the app was built with, the API it is pointed at,
 * the identity provider it authenticates against. Everything else is listed as
 * what it is: available, not connected. Connecting one is a real piece of work
 * somebody has to do, and this screen says so rather than offering a toggle
 * that writes a boolean nobody reads.
 *
 * Webhooks and API keys are different: those *are* records this product could
 * own, so they are modelled properly and seeded — an outbound webhook is a row
 * with a URL and a delivery history, which is a thing, not a claim about
 * somebody else's software.
 */

export type IntegrationState =
  /** Configured and in use — derived, never set by hand. */
  | 'Connected'
  /** The product supports it; this deployment has not set it up. */
  | 'Available'
  /** Built into the product and always on. */
  | 'Built in';

export type IntegrationKind =
  | 'Identity' | 'Data' | 'Communication' | 'Finance' | 'Calendar' | 'Storage';

export interface Integration {
  id: string;
  n: string;
  vendor: string;
  kind: IntegrationKind;
  desc: string;
  /**
   * How the state is arrived at, in words.
   *
   * On screen next to the state, because "Connected" with no explanation is
   * exactly the unfalsifiable claim this module exists to avoid.
   */
  basis: string;
  /** Name of the setting that decides it, where there is one. */
  setting: string | null;
  /** What somebody would have to do to connect it. Empty where it is on. */
  toConnect: string;
}

export type WebhookEvent =
  | 'employee.joined' | 'employee.exited' | 'leave.approved'
  | 'timesheet.submitted' | 'asset.issued' | 'event.published';

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'employee.joined', 'employee.exited', 'leave.approved',
  'timesheet.submitted', 'asset.issued', 'event.published',
];

export interface Webhook {
  id: string;
  n: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdOn: string;
  createdById: string;
  /** Null until it has fired once. */
  lastFiredOn: string | null;
  lastStatus: number | null;
  deliveries: number;
  failures: number;
}

export const WEBHOOKS: Webhook[] = [];

export interface ApiKey {
  id: string;
  n: string;
  /**
   * The last four characters, and nothing else.
   *
   * The key itself is shown once at creation and never stored — a table of
   * live credentials readable by anybody who can open this page is the
   * classic version of this feature and it is a breach waiting for a date.
   */
  tail: string;
  scopes: string[];
  createdOn: string;
  createdById: string;
  lastUsedOn: string | null;
  expiresOn: string | null;
  revokedOn: string | null;
}

export const API_KEYS: ApiKey[] = [];

export const API_SCOPES = [
  'employees:read', 'leave:read', 'leave:write', 'timesheet:read',
  'attendance:read', 'assets:read', 'events:read', 'events:write',
];

/* ---------------- what the product can talk to ---------------- */

export const INTEGRATIONS: Integration[] = [
  {
    id: 'supabase-auth',
    n: 'Single sign-on',
    vendor: 'Supabase Auth',
    kind: 'Identity',
    desc: 'Who signs in, and how. Sessions, refresh and the providers offered on the sign-in page.',
    basis: 'Read from the build: sign-in is live when a Supabase project is configured.',
    setting: 'VITE_SUPABASE_URL',
    toConnect: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY, then enable providers in Supabase.',
  },
  {
    id: 'sso-providers',
    n: 'Google and Microsoft sign-in',
    vendor: 'Google · Microsoft Entra',
    kind: 'Identity',
    desc: 'The buttons offered on the sign-in page, alongside email.',
    basis: 'Read from VITE_SSO_PROVIDERS, which decides which buttons are drawn.',
    setting: 'VITE_SSO_PROVIDERS',
    toConnect: 'List the providers in VITE_SSO_PROVIDERS and enable each under Authentication → Providers.',
  },
  {
    id: 'api',
    n: 'The application API',
    vendor: '360 People Hub',
    kind: 'Data',
    desc: 'Where the screens read and write. Without it the app runs on its own demo dataset.',
    basis: 'Read from the build: live when VITE_API_URL points somewhere.',
    setting: 'VITE_API_URL',
    toConnect: 'Point VITE_API_URL at a deployed server.',
  },
  {
    id: 'postgres',
    n: 'PostgreSQL with row-level security',
    vendor: 'Supabase',
    kind: 'Data',
    desc: 'Every table carries a tenant and every read is fenced by policy, not by the query.',
    basis: 'Part of the product. It is not optional and cannot be turned off.',
    setting: null,
    toConnect: '',
  },
  {
    id: 'audit',
    n: 'Audit trail',
    vendor: '360 People Hub',
    kind: 'Data',
    desc: 'One trail across every module — who did what, to what, and when.',
    basis: 'Part of the product. Every module writes to it.',
    setting: null,
    toConnect: '',
  },
  {
    id: 'webhooks',
    n: 'Outbound webhooks',
    vendor: '360 People Hub',
    kind: 'Communication',
    desc: 'Post to a URL of yours when something happens here.',
    basis: 'Configured below. Each endpoint carries its own delivery history.',
    setting: null,
    toConnect: '',
  },
  {
    id: 'email',
    n: 'Transactional email',
    vendor: 'Not configured',
    kind: 'Communication',
    desc: 'Invitations, approvals and reminders by email.',
    basis: 'No mail provider is configured. Nothing is being sent.',
    setting: null,
    toConnect: 'Configure an SMTP relay or a provider such as Postmark, then set the sender domain.',
  },
  {
    id: 'slack',
    n: 'Slack notifications',
    vendor: 'Slack',
    kind: 'Communication',
    desc: 'Approvals and announcements into a channel.',
    basis: 'No Slack app is installed against this tenant.',
    setting: null,
    toConnect: 'Create a Slack app, install it to the workspace and store the bot token.',
  },
  {
    id: 'calendar',
    n: 'Calendar sync',
    vendor: 'Google Calendar · Outlook',
    kind: 'Calendar',
    desc: 'Leave and company events on people’s own calendars.',
    basis: 'No calendar credentials are held for this tenant.',
    setting: null,
    toConnect: 'Grant calendar scope through the identity provider and store a per-tenant refresh token.',
  },
  {
    id: 'payroll-out',
    n: 'Payroll bureau feed',
    vendor: 'Not configured',
    kind: 'Finance',
    desc: 'The monthly file a payroll bureau takes: earnings, deductions and statutory lines.',
    basis: 'No bureau is configured. Payroll output is produced in the app and exported by hand.',
    setting: null,
    toConnect: 'Agree a file format with the bureau and configure a delivery endpoint.',
  },
  {
    id: 'accounting',
    n: 'Accounting ledger',
    vendor: 'Zoho Books · Tally',
    kind: 'Finance',
    desc: 'Post payroll and expense journals straight to the ledger.',
    basis: 'No accounting connection is configured.',
    setting: null,
    toConnect: 'Authorise the ledger and map cost centres to departments.',
  },
  {
    id: 'storage',
    n: 'Document storage',
    vendor: 'Supabase Storage',
    kind: 'Storage',
    desc: 'Where letters, payslips and uploaded documents are kept.',
    basis: 'Follows the Supabase project — available wherever sign-in is.',
    setting: 'VITE_SUPABASE_URL',
    toConnect: 'Set the Supabase project, then create the documents bucket.',
  },
];

export const integrationOf = (id: string) => INTEGRATIONS.find((i) => i.id === id);

/* ---------------- a believable set of endpoints and keys ---------------- */

(function genIntegrations() {
  const admins = ACTIVE().filter((e) => e.role === 'admin');
  if (!admins.length) return;
  const by = () => admins[ri(0, admins.length - 1)]!.id;

  const seeds: { n: string; url: string; events: WebhookEvent[]; active: boolean }[] = [
    {
      n: 'IT provisioning',
      url: 'https://automation.360vhm.internal/hooks/joiners',
      events: ['employee.joined', 'employee.exited'],
      active: true,
    },
    {
      n: 'Finance — leave accrual',
      url: 'https://finance.360vhm.internal/hooks/leave',
      events: ['leave.approved'],
      active: true,
    },
    {
      n: 'Asset tracker (paused)',
      url: 'https://assets.360vhm.internal/hooks/issue',
      events: ['asset.issued'],
      active: false,
    },
  ];

  seeds.forEach((s) => {
    const createdOn = ymd(addDays(TODAY, -ri(60, 400)));
    const deliveries = s.active ? ri(40, 900) : ri(5, 60);
    /* A few percent fail. An endpoint that has never failed has never run. */
    const failures = Math.round(deliveries * (ri(0, 6) / 100));
    WEBHOOKS.push({
      id: uid('WH'),
      n: s.n,
      url: s.url,
      events: s.events,
      active: s.active,
      createdOn,
      createdById: by(),
      lastFiredOn: s.active ? ymd(addDays(TODAY, -ri(0, 4))) : ymd(addDays(TODAY, -ri(30, 120))),
      lastStatus: s.active ? (failures && ri(0, 5) === 0 ? 500 : 200) : 410,
      deliveries,
      failures,
    });
  });

  const keys: { n: string; scopes: string[]; expires: number | null; revoked: boolean }[] = [
    { n: 'Reporting warehouse', scopes: ['employees:read', 'leave:read', 'timesheet:read'], expires: 180, revoked: false },
    { n: 'Attendance kiosk', scopes: ['attendance:read'], expires: 90, revoked: false },
    { n: 'Old integration test', scopes: ['employees:read'], expires: null, revoked: true },
  ];

  keys.forEach((k) => {
    const createdOn = ymd(addDays(TODAY, -ri(30, 300)));
    API_KEYS.push({
      id: uid('KEY'),
      n: k.n,
      tail: Math.random().toString(36).slice(2, 6).toUpperCase(),
      scopes: k.scopes,
      createdOn,
      createdById: by(),
      lastUsedOn: k.revoked ? null : ymd(addDays(TODAY, -ri(0, 14))),
      expiresOn: k.expires === null ? null : ymd(addDays(TODAY, k.expires)),
      revokedOn: k.revoked ? ymd(addDays(TODAY, -ri(5, 60))) : null,
    });
  });
})();

export const liveWebhooks = () => sortBy(WEBHOOKS.filter((w) => w.active), (w) => w.n);

export const liveKeys = () => sortBy(API_KEYS.filter((k) => !k.revokedOn), (k) => k.n);

/** An endpoint failing more than one call in twenty is worth looking at. */
export const isUnhealthy = (w: Webhook) =>
  w.active && w.deliveries > 0 && w.failures / w.deliveries > 0.05;

export const keyExpiringSoon = (k: ApiKey, days = 30) =>
  !k.revokedOn && k.expiresOn !== null && k.expiresOn <= ymd(addDays(TODAY, days));

export const creatorName = (id: string) => EMAP[id]?.name ?? id;
