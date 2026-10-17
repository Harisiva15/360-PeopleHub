/**
 * Configuration writes.
 *
 * Each of these has reach beyond the row it edits, which is the argument for
 * putting them behind a service: an entitlement change reprices balances that
 * are already open. A save handler in a settings screen is the wrong place to
 * own that.
 */

import { ACTIVE } from '../../data/employees';
import { DEPTS, GRADES, HOLIDAYS, HOLIDAY_MAP, ltOf, ORG, SITES } from '../../data/org';
import { sortBy } from '../../lib/collections';
import { LEAVE_BAL } from '../../data/leave';
import { PERMS } from '../../state/rbac';
import type { AppRole } from '../../types/employee';
import type {
  BusinessUnit, ConfigService, Department, GridPatch, LegalEntity, LegalEntityDraft,
  ModuleGrid, PermScope, TenantProfile,
} from '../contracts';
import type { Site } from '../../types/org';
import { ok } from './util';

/* ---------------- business units ----------------
 *
 * Four, because a list with one row demonstrates nothing about sorting, the
 * inactive state or a filter. One is inactive on purpose, so the screen has a
 * deactivated row to render on first load.
 */
interface DemoUnit {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const BU_STAMP = new Date(Date.UTC(2026, 0, 12)).toISOString();

const BUSINESS_UNITS: DemoUnit[] = [
  { code: 'RETAIL', name: 'Retail & Digital', description: 'Branches, app and web.', active: true, createdAt: BU_STAMP, updatedAt: BU_STAMP },
  { code: 'CORP', name: 'Corporate Banking', description: 'Mid-market and large corporate.', active: true, createdAt: BU_STAMP, updatedAt: BU_STAMP },
  { code: 'TECH', name: 'Technology Services', description: 'Platform, data and delivery.', active: true, createdAt: BU_STAMP, updatedAt: BU_STAMP },
  { code: 'VENT', name: 'Ventures', description: null, active: false, createdAt: BU_STAMP, updatedAt: BU_STAMP },
];

/** uid=197609(haris) gid=197609 groups=197609 is the code, which is what the table keys its rows by. */
const asUnit = (u: DemoUnit): BusinessUnit => ({ id: u.code, ...u });

/** A refusal in the shape every one of these methods returns. */
const buFail = (message: string): Promise<never> => Promise.reject(new Error(message));

/**
 * Resolve a business unit code for a department assignment, mirroring
 * `resolveBusinessUnit` on the server.
 *
 * Returns the unit, `null` for "unassigned", or an `Error` to be rejected — the
 * three answers the caller has to tell apart. An unknown code and an inactive one
 * are both refused, for the same reasons the server gives: an inactive row stays
 * readable so older records resolve, and is not offered for new work.
 */
function resolveDemoUnit(code: string | null | undefined): DemoUnit | null | Error {
  if (!code) return null;
  const key = code.trim().toUpperCase();
  const u = BUSINESS_UNITS.find((x) => x.code === key);
  if (!u) return new Error(`no such business unit: ${key}`);
  if (!u.active) return new Error(`${key} is inactive and cannot be assigned — activate it first`);
  return u;
}
/* ---------------- the permission grid ----------------
 *
 * **The mock models which modules a role reaches, and not how far inside
 * them.** `src/state/rbac.ts` is a mirror of the server's policy, and what it
 * mirrors is the module list per role — it does not carry the read/write/
 * approve scopes that policy.ts holds. So a faithful ceiling cannot be built
 * here, and the alternative was to invent one.
 *
 * Inventing it would have been the same mistake as the security screen's
 * fabricated MFA percentage: a grid that looks authoritative, is drawn from a
 * guess, and would teach anybody reading the demo something untrue about how
 * the product is configured.
 *
 * So the mock says what it knows. A module a role reaches is 'all' across the
 * three columns; one it does not is 'none'. The screen labels this, and a
 * configured build gets the real grid from the server.
 */
const ALL: PermScope = 'all';
const NONE: PermScope = 'none';
const ruleOf = (role: AppRole, module: string) => {
  const reaches = PERMS[role].includes(module);
  const v = reaches ? ALL : NONE;
  return { read: v, write: v, approve: v };
};

/* Narrowing applied in this session, so the screen responds to its own edits. */
const NARROWED = new Map<string, PermScope>();
const key = (module: string, role: AppRole, field: string) => `${module}|${role}|${field}`;

const RANK: Record<PermScope, number> = { none: 0, own: 1, team: 2, all: 3 };
const narrower = (a: PermScope, b: PermScope): PermScope => (RANK[a] <= RANK[b] ? a : b);

/* Every module any role reaches — the admin list is the superset. */
const MODULES: string[] = [...PERMS.admin].sort();

const gridNow = (): ModuleGrid[] => MODULES.map((module: string) => {
  const cell = (role: AppRole) => {
    const base = ruleOf(role, module);
    return {
      read: narrower(base.read, NARROWED.get(key(module, role, 'read')) ?? base.read),
      write: narrower(base.write, NARROWED.get(key(module, role, 'write')) ?? base.write),
      approve: narrower(base.approve, NARROWED.get(key(module, role, 'approve')) ?? base.approve),
    };
  };
  return {
    module,
    ceiling: { employee: ruleOf('employee', module), manager: ruleOf('manager', module), admin: ruleOf('admin', module) },
    effective: { employee: cell('employee'), manager: cell('manager'), admin: cell('admin') },
  };
});

/**
 * Make one site head office, and no other.
 *
 * Head office is a move rather than a flag: `site_one_headquarters` permits
 * exactly one active site carrying it, so promoting always demotes. Both
 * columns travel together because `site_headquarters_is_consistent` refuses
 * them apart — the outgoing head office becomes an ordinary office, which is
 * what it now is.
 */
function nominate(code: string): void {
  for (const s of SITES) {
    if (s.headquarters && s.id !== code) { s.headquarters = false; s.kind = 'office'; }
  }
  const next = SITES.find((s) => s.id === code);
  if (next) { next.headquarters = true; next.kind = 'headquarters'; }
}

/*
 * The demo departments.
 *
 * `DEPTS` is a display constant with no id, headcount or active flag — it was
 * never something to edit. Derived once here so the demo supports the same
 * four operations the server does.
 */
/*
 * Which demo division each demo department reports into.
 *
 * Migration 0052 leaves every real department unassigned, and nothing assigns
 * one on its behalf. The demo is a showroom rather than a migrated database, so
 * it ships the finished arrangement — otherwise the Business unit column reads
 * "Unassigned" eight times and the feature looks broken. Human Resources is
 * left out on purpose: the column is nullable and the demo should say so.
 */
const DEMO_UNIT_OF: Record<string, string | undefined> = {
  ENG: 'TECH', QA: 'TECH', DEVOPS: 'TECH', PROD: 'TECH',
  SALES: 'RETAIL', SUP: 'RETAIL', FIN: 'CORP',
};


/*
 * Which demo department reports to which.
 *
 * `department.parent_id` has existed since 0002 and was never exposed, so a demo
 * with every department top-level would show the new column doing nothing. The
 * arrangement agrees with DEMO_UNIT_OF above — a child sits in the same business
 * unit as its parent — so the two columns read as one deliberate structure rather
 * than two unrelated seeds. Three departments stay top-level, because that is the
 * ordinary state and the demo should show it.
 *
 * Keyed by code, which in this layer is also the id: a demo `Department.id` is its
 * code, where the server's is a uuid. Both resolve the same way on the screen,
 * which looks a parent up by id rather than assuming either shape.
 */
const DEMO_PARENT_OF: Record<string, string | undefined> = {
  QA: 'ENG', DEVOPS: 'ENG', SUP: 'SALES',
};

const DEPARTMENTS: Department[] = DEPTS.map((d) => ({
  id: d.id,
  code: d.id,
  name: d.name,
  colour: d.color ?? null,
  headId: d.head ?? null,
  headName: '',
  businessUnitCode: DEMO_UNIT_OF[d.id] ?? null,
  businessUnitName: BUSINESS_UNITS.find((u) => u.code === DEMO_UNIT_OF[d.id])?.name ?? null,
  parentId: DEMO_PARENT_OF[d.id] ?? null,
  active: true,
  headcount: ACTIVE().filter((e) => e.dept === d.id).length,
}));

/*
 * Would making `parentId` the parent of `self` close a loop?
 *
 * The server answers this with a recursive CTE walking up from the proposed
 * parent; this walks the same chain over the array. It is the demo's mirror of
 * that rule, not a second authority: in API mode the server decides, and the
 * form filters the same departments out of the select so neither is normally
 * reached. The demo still refuses it, because a demo that accepts what the
 * server refuses teaches the wrong thing.
 *
 * `seen` is not defensive dressing. If the seeded data ever did contain a loop,
 * an unguarded walk here would hang the browser rather than report anything.
 */
function wouldLoop(selfId: string, parentId: string): boolean {
  if (selfId === parentId) return true;
  const seen = new Set<string>();
  let at: string | null = parentId;
  while (at && !seen.has(at)) {
    seen.add(at);
    if (at === selfId) return true;
    at = DEPARTMENTS.find((d) => d.id === at)?.parentId ?? null;
  }
  return false;
}

/* ---------------- the tenant ----------------
 *
 * One demo tenant, and its name comes from `ORG` rather than a second literal.
 * `ORG.name` is the trading name and `ORG.legal` the registered one, which is
 * exactly the `display_name` / `legal_name` split the tenant row carries — so the
 * demo has one source for the company's name, not two that can drift.
 *
 * The read-only fields match what `seed.mjs` writes for a real tenant: slug
 * `360vhm`, India, INR, an April fiscal year, active, ap-south-1.
 */
const DEMO_TENANT: TenantProfile = {
  displayName: ORG.name,
  legalName: ORG.legal,
  slug: '360vhm',
  status: 'active',
  homeCountry: 'IN',
  baseCurrency: 'INR',
  fiscalYearStartMonth: 4,
  dataRegion: 'ap-south-1',
  createdAt: new Date(Date.UTC(2024, 3, 1)).toISOString(),
};

/* ---------------- legal entities ----------------
 *
 * The registered company, which the demo previously had no notion of at all:
 * the Company Profile screen rendered `ORG` directly and its Save button was
 * marked not-backed. These values are the same ones `ORG` carries, so the demo
 * shows the company it has always claimed to be rather than an invented one —
 * and `seed.mjs` writes the identical row as `IN01`, default, for a real tenant.
 *
 * One entity, not several. A multi-entity demo would be more impressive and less
 * true: this company operates one registered entity, and the second entity in
 * the list would have to be made up.
 */
const LEGAL_ENTITIES: LegalEntity[] = [
  {
    code: 'IN01',
    legalName: ORG.legal,
    country: 'IN',
    currency: 'INR',
    registeredAddress: ORG.addr,
    /* India files on three identifiers and the table holds two, so PAN is the
       tax id and CIN the registration. TAN has no column — see the screen. */
    taxId: ORG.pan,
    registrationId: ORG.cin,
    pfCode: 'TNMAS0012345000',
    esiCode: '51000123450000999',
    isDefault: true,
    headcount: 0,
  },
];

const LE_CODE_SHAPE = /^[A-Z0-9]{2,10}$/;

/** Headcount is derived, never stored — the same as a department's. */
const asEntity = (e: LegalEntity): LegalEntity => ({ ...e, headcount: ACTIVE().length });

/**
 * The server's validation, mirrored.
 *
 * `legal_entity` carries no CHECK constraints, so the service is the only thing
 * refusing a blank name or a three-letter country. A demo that accepted what the
 * server refuses would teach the wrong thing, which is the same reason the
 * business unit and department rules are mirrored here.
 */
function checkDemoEntity(d: LegalEntityDraft, partial: boolean): Error | null {
  const need = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  if (!partial) {
    if (!need(d.code)) return new Error('a legal entity needs a code');
    if (!LE_CODE_SHAPE.test(d.code!.trim().toUpperCase())) {
      return new Error('a legal entity code is 2-10 letters or digits, such as IN01');
    }
    if (!need(d.legalName)) return new Error('a legal entity needs its registered name');
    if (!need(d.country)) return new Error('a legal entity needs a country');
    if (!need(d.currency)) return new Error('a legal entity needs a currency');
  }
  if (d.legalName !== undefined && !need(d.legalName)) {
    return new Error('a legal entity needs its registered name');
  }
  if (d.country !== undefined && !/^[A-Z]{2}$/.test(String(d.country).trim().toUpperCase())) {
    return new Error('a country is a two-letter code, such as IN');
  }
  if (d.currency !== undefined && !/^[A-Z]{3}$/.test(String(d.currency).trim().toUpperCase())) {
    return new Error('a currency is a three-letter code, such as INR');
  }
  return null;
}

/** Absent leaves an identifier alone; blank clears it; text records it. */
const demoOptional = (v: string | null | undefined): string | null =>
  v === undefined || v === null ? null : (v.trim() || null);

export const configService: ConfigService = {
  permissions(c) {
    if (c.role !== 'admin') return Promise.reject(new Error('Only an administrator can read this'));
    return ok(gridNow());
  },

  setPermissions(c, patches: GridPatch[]) {
    if (c.role !== 'admin') {
      return Promise.reject(new Error('Only an administrator can change permissions'));
    }
    for (const p of patches) {
      if (p.module === 'settings' && p.role === 'admin' && p.read === 'none') {
        return Promise.reject(new Error(
          'Administrators cannot be removed from Settings — there would be no way '
          + 'back from inside the application'));
      }
    }
    for (const p of patches) {
      for (const field of ['read', 'write', 'approve'] as const) {
        const v = p[field];
        if (v !== undefined) NARROWED.set(key(p.module, p.role, field), v);
      }
    }
    return ok(gridNow());
  },

  resetPermissions(c, module) {
    if (c.role !== 'admin') {
      return Promise.reject(new Error('Only an administrator can change permissions'));
    }
    for (const k of [...NARROWED.keys()]) {
      if (k.startsWith(`${module}|`)) NARROWED.delete(k);
    }
    return ok(gridNow());
  },

  sites() { return ok(SITES.slice()); },

  /*
   * Departments, from the same constant the Settings screen used to render
   * directly. Held in a mutable list here so the demo can add and remove, the
   * way the server does.
   */
  departments() { return ok(DEPARTMENTS.slice()); },
  /* ---------------- business units ---------------- */

  /*
   * The demo's business units, mirroring the server's rules rather than
   * approximating them: the same code shape, the same duplicate-name refusal, the
   * same "deactivate, never delete". A form refused against a real tenant has to
   * be refused here too, or the demo teaches the wrong thing.
   *
   * Four to begin with, because a list screen with one row shows nothing about
   * sorting, filtering or the inactive state.
   */
  tenantProfile() {
    return ok({ ...DEMO_TENANT });
  },

  updateTenantDisplayName(draft) {
    /* The server's validation, mirrored — 120 characters is this module's convention. */
    if (typeof draft.displayName !== 'string' || !draft.displayName.trim()) {
      return Promise.reject(new Error('the company needs a name'));
    }
    const name = draft.displayName.trim();
    if (name.length > 120) {
      return Promise.reject(new Error('a name is at most 120 characters'));
    }
    /* Only this field moves. Nothing here can reach the protected columns. */
    DEMO_TENANT.displayName = name;
    return ok({ ...DEMO_TENANT });
  },

  legalEntities() {
    return ok(sortBy(LEGAL_ENTITIES, (e) => `${e.isDefault ? '0' : '1'}${e.code}`).map(asEntity));
  },

  createLegalEntity(draft) {
    const bad = checkDemoEntity(draft, false);
    if (bad) return Promise.reject(bad);
    const code = draft.code!.trim().toUpperCase();
    if (LEGAL_ENTITIES.some((e) => e.code === code)) {
      return Promise.reject(new Error(`${code} is already a legal entity`));
    }
    /* The first in a tenant becomes the default, as the server does — three
       services refuse to run without one. */
    const first = LEGAL_ENTITIES.length === 0;
    const e: LegalEntity = {
      code,
      legalName: draft.legalName!.trim(),
      country: draft.country!.trim().toUpperCase(),
      currency: draft.currency!.trim().toUpperCase(),
      registeredAddress: demoOptional(draft.registeredAddress),
      taxId: demoOptional(draft.taxId),
      registrationId: demoOptional(draft.registrationId),
      pfCode: demoOptional(draft.pfCode),
      esiCode: demoOptional(draft.esiCode),
      isDefault: first,
      headcount: 0,
    };
    LEGAL_ENTITIES.push(e);
    return ok(asEntity(e));
  },

  updateLegalEntity(code, patch) {
    const key = code.trim().toUpperCase();
    const e = LEGAL_ENTITIES.find((x) => x.code === key);
    if (!e) return Promise.reject(new Error('no such legal entity'));
    const bad = checkDemoEntity(patch, true);
    if (bad) return Promise.reject(bad);
    if (patch.code !== undefined && patch.code.trim().toUpperCase() !== key) {
      return Promise.reject(new Error(
        'a legal entity code cannot change — every employee and pay run joins on it'));
    }
    Object.assign(e, {
      ...(patch.legalName !== undefined ? { legalName: patch.legalName.trim() } : {}),
      ...(patch.country !== undefined
        ? { country: patch.country.trim().toUpperCase() } : {}),
      ...(patch.currency !== undefined
        ? { currency: patch.currency.trim().toUpperCase() } : {}),
      ...(patch.registeredAddress !== undefined
        ? { registeredAddress: demoOptional(patch.registeredAddress) } : {}),
      ...(patch.taxId !== undefined ? { taxId: demoOptional(patch.taxId) } : {}),
      ...(patch.registrationId !== undefined
        ? { registrationId: demoOptional(patch.registrationId) } : {}),
      ...(patch.pfCode !== undefined ? { pfCode: demoOptional(patch.pfCode) } : {}),
      ...(patch.esiCode !== undefined ? { esiCode: demoOptional(patch.esiCode) } : {}),
    });
    return ok(asEntity(e));
  },

  setDefaultLegalEntity(code) {
    const key = code.trim().toUpperCase();
    const e = LEGAL_ENTITIES.find((x) => x.code === key);
    if (!e) return Promise.reject(new Error('no such legal entity'));
    /* Demote then promote, as the server's one transaction does. There is no way
       to clear the default to none: it moves, it does not toggle. */
    for (const other of LEGAL_ENTITIES) other.isDefault = false;
    e.isDefault = true;
    return ok(asEntity(e));
  },

  businessUnits() {
    return ok(BUSINESS_UNITS.map(asUnit).sort(
      (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)));
  },

  createBusinessUnit(draft) {
    const code = (draft.code ?? '').trim().toUpperCase();
    if (!code) return buFail('a business unit needs a code');
    if (!/^[A-Z0-9][A-Z0-9-]{1,15}$/.test(code)) {
      return buFail('a code is 2-16 letters, digits or hyphens, such as RETAIL or BU-01');
    }
    const name = (draft.name ?? '').trim();
    if (!name) return buFail('a business unit needs a name');
    if (name.length > 120) return buFail('a name is at most 120 characters');
    const description = draft.description?.trim() ? draft.description.trim() : null;
    if (description && description.length > 500) {
      return buFail('a description is at most 500 characters');
    }
    if (BUSINESS_UNITS.some((u) => u.code === code)) {
      return buFail(`${code} is already a business unit`);
    }
    const clash = BUSINESS_UNITS.find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (clash) return buFail(`${clash.code} is already called ${name}`);

    const now = new Date().toISOString();
    const made = { code, name, description, active: true, createdAt: now, updatedAt: now };
    BUSINESS_UNITS.push(made);
    return ok(asUnit(made));
  },

  updateBusinessUnit(code, patch) {
    const key = code.trim().toUpperCase();
    const u = BUSINESS_UNITS.find((x) => x.code === key);
    if (!u) return buFail('no such business unit');
    if (patch.code !== undefined) {
      return buFail('a code cannot be changed - create a unit under the new code instead');
    }
    const name = (patch.name ?? '').trim();
    if (!name) return buFail('a business unit needs a name');
    if (name.length > 120) return buFail('a name is at most 120 characters');
    const description = patch.description?.trim() ? patch.description.trim() : null;
    if (description && description.length > 500) {
      return buFail('a description is at most 500 characters');
    }
    const clash = BUSINESS_UNITS.find(
      (x) => x.code !== key && x.name.toLowerCase() === name.toLowerCase());
    if (clash) return buFail(`${clash.code} is already called ${name}`);

    u.name = name;
    u.description = description;
    u.updatedAt = new Date().toISOString();
    return ok(asUnit(u));
  },

  setBusinessUnitActive(code, active) {
    const u = BUSINESS_UNITS.find((x) => x.code === code.trim().toUpperCase());
    if (!u) return buFail('no such business unit');
    if (typeof active !== 'boolean') {
      return buFail('a business unit is either active or inactive');
    }
    u.active = active;
    u.updatedAt = new Date().toISOString();
    return ok(asUnit(u));
  },

  /*
   * The demo's grade ladder, from the same constant the screens used to read
   * directly. Ranked by position, which is what the promotion rule compares.
   */
  grades() {
    return ok(Object.entries(GRADES).map(([code, g], i) => ({
      code, label: g.label, rank: i + 1, minCtc: g.min, maxCtc: g.max,
    })));
  },

  createDepartment(draft) {
    const code = draft.code?.trim().toUpperCase() ?? '';
    if (!code) return Promise.reject(new Error('A department needs a code'));
    if (!draft.name?.trim()) return Promise.reject(new Error('A department needs a name'));
    if (DEPARTMENTS.some((d) => d.code === code)) {
      return Promise.reject(new Error(code + ' is already a department'));
    }
    /*
     * The server's rules for the assignment, mirrored: an unknown unit and an
     * inactive one are both refused, and absent or null both mean unassigned on a
     * create. A form refused against a real tenant has to be refused here too, or
     * the demo teaches the wrong thing.
     */
    const unit = resolveDemoUnit(draft.businessUnitCode);
    if (unit instanceof Error) return Promise.reject(unit);

    /*
     * A parent that does not exist. The server leaves this to the composite
     * foreign key, which answers 23503 and reaches the client as a 404; the demo
     * has no foreign key, so it says the same thing itself. There is no cycle to
     * check on a create — the department does not exist yet, so nothing can
     * already report to it.
     */
    if (typeof draft.parentId === 'string'
      && !DEPARTMENTS.some((x) => x.id === draft.parentId)) {
      return Promise.reject(new Error('no such department: ' + draft.parentId));
    }

    const d = {
      id: code, code, name: draft.name.trim(), colour: draft.colour ?? null,
      headId: draft.headId ?? null, headName: '', parentId: draft.parentId ?? null,
      active: true, headcount: 0,
      businessUnitCode: unit?.code ?? null,
      businessUnitName: unit?.name ?? null,
    };
    DEPARTMENTS.push(d);
    return ok(d);
  },

  updateDepartment(code, patch) {
    const d = DEPARTMENTS.find((x) => x.code === code);
    if (!d) return Promise.reject(new Error('No such department: ' + code));
    if (patch.name !== undefined && !patch.name.trim()) {
      return Promise.reject(new Error('A department needs a name'));
    }
    /*
     * Absent leaves the assignment alone; null clears it; a code sets it. Sending
     * back the unit it already has is allowed even if that unit is now inactive —
     * an inactive unit cannot be newly assigned, but a department naming one must
     * stay editable. Same exception as the server.
     */
    /* The same two refusals the server raises, in the same order. */
    if (typeof patch.parentId === 'string') {
      if (patch.parentId === d.id) {
        return Promise.reject(new Error('a department cannot report to itself'));
      }
      if (wouldLoop(d.id, patch.parentId)) {
        return Promise.reject(
          new Error('that would make the department report to itself'));
      }
      if (!DEPARTMENTS.some((x) => x.id === patch.parentId)) {
        return Promise.reject(new Error('no such department: ' + patch.parentId));
      }
    }
    const sameAsNow = typeof patch.businessUnitCode === 'string'
      && patch.businessUnitCode.trim().toUpperCase() === d.businessUnitCode;
    const unit = patch.businessUnitCode === undefined || sameAsNow
      ? undefined
      : resolveDemoUnit(patch.businessUnitCode);
    if (unit instanceof Error) return Promise.reject(unit);

    Object.assign(d, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.colour !== undefined ? { colour: patch.colour } : {}),
      ...(patch.headId !== undefined ? { headId: patch.headId } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(unit === undefined ? {} : {
        businessUnitCode: unit?.code ?? null,
        businessUnitName: unit?.name ?? null,
      }),
    });
    return ok(d);
  },

  removeDepartment(code) {
    const i = DEPARTMENTS.findIndex((x) => x.code === code);
    if (i < 0) return Promise.reject(new Error('No such department: ' + code));
    const d = DEPARTMENTS[i]!;
    if (d.headcount > 0) {
      return Promise.reject(new Error(
        `${code} still has ${d.headcount} employees. Move them first, or deactivate `
        + 'the department instead of removing it.'));
    }
    return ok(DEPARTMENTS.splice(i, 1)[0]!);
  },
  holidays() { return ok(HOLIDAYS.slice()); },

  updateFence(siteId, patch) {
    const site = SITES.find((s) => s.id === siteId);
    if (!site) return Promise.reject(new Error('No such site: ' + siteId));
    if (site.remote) return Promise.reject(new Error('A remote work mode cannot be fenced'));
    if (!Number.isFinite(patch.lat) || !Number.isFinite(patch.lng)) {
      return Promise.reject(new Error('A fence needs a latitude and a longitude'));
    }
    if (Math.abs(patch.lat) > 90 || Math.abs(patch.lng) > 180) {
      return Promise.reject(new Error('That is not a point on the earth'));
    }
    if (patch.radius <= 0) {
      return Promise.reject(new Error('The fence radius must be greater than zero'));
    }
    site.lat = patch.lat;
    site.lng = patch.lng;
    site.radius = patch.radius;
    return ok(site);
  },

  /*
   * The location writes refuse on the same grounds the server does, because a
   * demo that accepts what production rejects teaches the wrong thing. The
   * rules restated here are the ones a person can hit by filling the form in:
   * a duplicate code, a second head office, closing an office people work at.
   */
  createSite(draft) {
    const code = draft.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(code)) {
      return Promise.reject(new Error('A code is 2–10 letters or digits, such as BLR'));
    }
    if (!draft.name.trim()) return Promise.reject(new Error('A location needs a name'));
    if (SITES.some((s) => s.id === code)) {
      return Promise.reject(new Error(`${code} is already a location`));
    }
    const made: Site = {
      id: code,
      name: draft.name.trim(),
      city: draft.city?.trim() || '—',
      country: (draft.country || 'IN').trim().toUpperCase() as Site['country'],
      addr: draft.address?.trim() ?? '',
      remote: draft.kind === 'remote' || draft.kind === 'client',
      lat: null, lng: null, radius: null,
      /* Professional tax is a payroll input the server does not hold per site. */
      ptax: 0,
      tz: draft.timezone?.trim() || 'IST',
      shift: '09:30-18:30',
      kind: draft.kind === 'headquarters' ? 'office' : draft.kind,
      headquarters: false,
      ...(draft.state?.trim() ? { state: draft.state.trim() } : {}),
      ...(draft.postcode?.trim() ? { postcode: draft.postcode.trim() } : {}),
    };
    SITES.push(made);
    if (draft.kind === 'headquarters') nominate(code);
    return ok(made);
  },

  updateSite(siteId, patch) {
    const site = SITES.find((s) => s.id === siteId);
    if (!site) return Promise.reject(new Error('No such location: ' + siteId));
    if (patch.name !== undefined && !patch.name.trim()) {
      return Promise.reject(new Error('A location needs a name'));
    }
    if (site.kind === 'headquarters' && patch.kind !== undefined && patch.kind !== 'headquarters') {
      return Promise.reject(new Error(
        'Nominate another location as head office first — the company must have one'));
    }
    if (patch.name !== undefined) site.name = patch.name.trim();
    if (patch.city !== undefined) site.city = patch.city.trim() || '—';
    if (patch.state !== undefined) site.state = patch.state.trim();
    if (patch.postcode !== undefined) site.postcode = patch.postcode.trim();
    if (patch.country !== undefined) site.country = patch.country.trim().toUpperCase() as Site['country'];
    if (patch.address !== undefined) site.addr = patch.address.trim();
    if (patch.timezone !== undefined) site.tz = patch.timezone.trim();
    if (patch.kind !== undefined && patch.kind !== 'headquarters') site.kind = patch.kind;
    if (patch.kind === 'headquarters') nominate(siteId);
    return ok(site);
  },

  setSiteActive(siteId, active) {
    const site = SITES.find((s) => s.id === siteId);
    if (!site) return Promise.reject(new Error('No such location: ' + siteId));
    if (!active) {
      if (site.headquarters) {
        return Promise.reject(new Error(
          'Head office cannot be closed — nominate another location first'));
      }
      const n = ACTIVE().filter((e) => e.site === siteId).length;
      if (n > 0) {
        return Promise.reject(new Error(
          `${n} ${n === 1 ? 'person is' : 'people are'} still posted here — `
          + 'move them before closing it'));
      }
    }
    site.active = active;
    return ok(site);
  },

  setLeaveQuota(typeId, quota) {
    if (quota < 0) return Promise.reject(new Error('A leave quota cannot be negative'));
    const t = ltOf(typeId);
    t.quota = quota;

    let repriced = 0;
    ACTIVE().forEach((e) => {
      const bal = LEAVE_BAL[e.id]?.[typeId];
      if (!bal) return;
      bal.quota = quota;
      repriced++;
    });
    return ok({ type: t.name, quota, repriced });
  },

  addHoliday(date, name, optional) {
    if (HOLIDAYS.some((h) => h.d === date)) return Promise.reject(new Error('A holiday is already set for ' + date));
    HOLIDAYS.push({ d: date, n: name, opt: optional });
    HOLIDAYS.sort((a, b) => (a.d < b.d ? -1 : 1));
    /* Only fixed holidays close the office, so only those enter the map. */
    if (!optional) HOLIDAY_MAP[date] = name;
    return ok(HOLIDAYS.slice());
  },
};
