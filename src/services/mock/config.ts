/**
 * Configuration writes.
 *
 * Each of these has reach beyond the row it edits, which is the argument for
 * putting them behind a service: an entitlement change reprices balances that
 * are already open. A save handler in a settings screen is the wrong place to
 * own that.
 */

import { ACTIVE } from '../../data/employees';
import { DEPTS, HOLIDAYS, HOLIDAY_MAP, ltOf, SITES } from '../../data/org';
import { LEAVE_BAL } from '../../data/leave';
import { PERMS } from '../../state/rbac';
import type { AppRole } from '../../types/employee';
import type { ConfigService, Department, GridPatch, ModuleGrid, PermScope } from '../contracts';
import type { Site } from '../../types/org';
import { ok } from './util';

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
const DEPARTMENTS: Department[] = DEPTS.map((d) => ({
  id: d.id,
  code: d.id,
  name: d.name,
  colour: d.color ?? null,
  headId: d.head ?? null,
  headName: '',
  parentId: null,
  active: true,
  headcount: ACTIVE().filter((e) => e.dept === d.id).length,
}));

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

  createDepartment(draft) {
    const code = draft.code?.trim().toUpperCase() ?? '';
    if (!code) return Promise.reject(new Error('A department needs a code'));
    if (!draft.name?.trim()) return Promise.reject(new Error('A department needs a name'));
    if (DEPARTMENTS.some((d) => d.code === code)) {
      return Promise.reject(new Error(code + ' is already a department'));
    }
    const d = {
      id: code, code, name: draft.name.trim(), colour: draft.colour ?? null,
      headId: draft.headId ?? null, headName: '', parentId: draft.parentId ?? null,
      active: true, headcount: 0,
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
    Object.assign(d, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.colour !== undefined ? { colour: patch.colour } : {}),
      ...(patch.headId !== undefined ? { headId: patch.headId } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
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
