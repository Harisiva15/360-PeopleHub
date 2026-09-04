/**
 * The staffing match engine.
 *
 * Deterministic and explainable: the score is a sum of six weighted components
 * and `matchExplain` hands back the breakdown, so every number a recruiter sees
 * can be justified to the client. Nothing here calls out to a model or a
 * service — it is arithmetic over the live records.
 */

import { sum } from '../lib/collections';
import { countryOf, toBase } from './countries';
import type { CountryId } from '../types/country';
import { clientOf, REQUIREMENTS } from './staffing';
import type { Consultant, StaffingRequirement } from './staffing';

/** Adjacent skills, so a near-miss still scores at half weight. */
const SKILL_KIN: Record<string, string[]> = {
  React: ['TypeScript', 'Node.js', 'GraphQL'],
  'Node.js': ['TypeScript', 'React', 'GraphQL'],
  Java: ['Spring Boot', 'Kafka'],
  'Spring Boot': ['Java', 'Kafka'],
  Python: ['AWS', 'PostgreSQL', 'Go'],
  AWS: ['Kubernetes', 'Terraform', 'Docker'],
  Kubernetes: ['Docker', 'Terraform', 'AWS'],
  Docker: ['Kubernetes', 'AWS'],
  PostgreSQL: ['Python', 'Java'],
  TypeScript: ['React', 'Node.js'],
  Selenium: ['Cypress'],
  Cypress: ['Selenium'],
  Terraform: ['AWS', 'Azure', 'Kubernetes'],
  Salesforce: [],
  Figma: [],
  Kafka: ['Java', 'Spring Boot'],
  GraphQL: ['Node.js', 'React'],
  Azure: ['Terraform', 'Kubernetes', 'Docker'],
  Go: ['Kubernetes', 'Python'],
  Flutter: ['TypeScript'],
};

/** Roles a consultant can credibly step across into. */
const ROLE_KIN: Record<string, string[]> = {
  'Software Engineer': ['Senior Software Engineer'],
  'Senior Software Engineer': ['Software Engineer', 'Tech Lead'],
  'Tech Lead': ['Senior Software Engineer', 'Architect'],
  Architect: ['Tech Lead'],
  'QA Engineer': ['SDET'],
  SDET: ['QA Engineer', 'Software Engineer'],
  'DevOps Engineer': ['SRE'],
  SRE: ['DevOps Engineer'],
  'Data Engineer': ['Software Engineer'],
  'Business Analyst': ['Scrum Master'],
  'Scrum Master': ['Project Manager', 'Business Analyst'],
  'Project Manager': ['Scrum Master'],
};

/**
 * Right-to-represent viability, by the requirement's country. 1 is a clean
 * right to work; anything below 0.6 means the placement only stands up where
 * the role can be delivered offshore.
 */
const AUTH_OK: Record<CountryId, Record<string, number>> = {
  US: {
    'US Citizen': 1, 'Green Card': 1, 'GC-EAD': 1, 'H4-EAD': 0.9, 'H1-B': 0.85, TN: 0.85, 'OPT-EAD': 0.6,
    'Work Permit': 0.2, 'Employment Visa': 0.1, 'Skilled Worker Visa': 0.1, 'Golden Visa': 0.1,
    'Indian National': 0.05, 'UAE National': 0.1,
  },
  GB: {
    'Skilled Worker Visa': 1, 'Work Permit': 0.9, 'US Citizen': 0.3, 'Green Card': 0.15, 'H1-B': 0.1,
    'Employment Visa': 0.15, 'Golden Visa': 0.15, 'Indian National': 0.15, 'UAE National': 0.15,
  },
  CA: {
    'Work Permit': 1, 'US Citizen': 0.55, TN: 0.5, 'Green Card': 0.35, 'Skilled Worker Visa': 0.3,
    'Employment Visa': 0.2, 'Golden Visa': 0.2, 'Indian National': 0.15, 'UAE National': 0.2,
  },
  AE: {
    'Employment Visa': 1, 'Golden Visa': 1, 'UAE National': 1, 'Work Permit': 0.8,
    'Indian National': 0.6, 'Skilled Worker Visa': 0.35, 'US Citizen': 0.5, 'Green Card': 0.3,
  },
  IN: {
    'Indian National': 1, 'Work Permit': 0.5, 'US Citizen': 0.3, 'Green Card': 0.25,
    'Employment Visa': 0.3, 'Skilled Worker Visa': 0.3, 'UAE National': 0.3, 'Golden Visa': 0.3,
  },
};

/** Weight applied when the authorisation is one we have no rule for. */
const AUTH_UNKNOWN = 0.35;

export interface MatchPart {
  k: string;
  v: number;
  max: number;
  d: string;
}

export interface MatchExplain {
  total: number;
  parts: MatchPart[];
  /** Multiplier applied for weak work authorisation. */
  gate: number;
  eligible: boolean;
  offshore: boolean;
  remoteOk: boolean;
  margin: number;
  cost: number;
  bill: number;
}

const EMPTY: MatchExplain = {
  total: 0, parts: [], gate: 0, eligible: false, offshore: false, remoteOk: false, margin: 0, cost: 0, bill: 0,
};

/** Years of experience the role is really asking for. */
function expectedExp(role: string): number {
  if (/Architect|Tech Lead|Project Manager/.test(role)) return 8;
  if (/Senior|SRE|SDET/.test(role)) return 5;
  return 2;
}

export function matchExplain(c: Consultant | undefined, r: StaffingRequirement | undefined): MatchExplain {
  if (!c || !r) return EMPTY;
  const cl = clientOf(r.clientId);

  /* 1 — skills, 40 points. Exact match full weight, adjacent half. */
  let hit = 0;
  r.skills.forEach((s) => {
    if (c.skills.includes(s)) hit += 1;
    else if ((SKILL_KIN[s] || []).some((k) => c.skills.includes(k))) hit += 0.5;
  });
  const skillPts = Math.round((hit / Math.max(1, r.skills.length)) * 40);

  /* 2 — role, 20 points */
  const rolePts = c.role === r.role ? 20 : (ROLE_KIN[r.role] || []).includes(c.role) ? 13 : 5;

  /* 3 — work authorisation, 15 points */
  const authW = (AUTH_OK[cl.country] || AUTH_OK.US)[c.workAuth];
  const w = authW == null ? AUTH_UNKNOWN : authW;
  const authPts = Math.round(w * 15);

  /* 4 — commercial fit, 15 points. Does the bill rate clear our cost floor? */
  const cost = toBase(c.costPerDay, c.ccy);
  const bill = toBase(r.billRate * (r.unit === 'per day' ? 1 : 8), r.ccy);
  const margin = bill > 0 ? (bill - cost) / bill : 0;
  const ratePts = margin >= 0.35 ? 15 : margin >= 0.25 ? 12 : margin >= 0.15 ? 8 : margin > 0 ? 4 : 0;

  /* 5 — availability, 10 points */
  const avail = c.status === 'Bench' ? 10 : c.status === 'Internal' ? 6 : 2;

  /* 6 — experience against what the role expects, 10 points */
  const wantExp = expectedExp(r.role);
  const expPts = c.exp >= wantExp ? 10 : Math.round((c.exp / Math.max(1, wantExp)) * 10);

  /*
   * Offshore delivery is legitimate when the role is remote; otherwise the
   * consultant has to be able to work in the client's country, so weak
   * authorisation gates the whole score rather than costing a few points.
   */
  const remoteOk = /remote/i.test(r.location);
  const eligible = w >= 0.6 || (remoteOk && c.country !== cl.country);
  const gate = w >= 0.6 ? 1 : w >= 0.3 ? (remoteOk ? 0.92 : 0.78) : remoteOk ? 0.72 : 0.42;
  const authNote =
    w >= 0.6
      ? `${c.workAuth} — can work in ${countryOf(cl.country).name}`
      : remoteOk
        ? `${c.workAuth} — offshore delivery only, role is ${r.location.toLowerCase()}`
        : `${c.workAuth} — not authorised for ${countryOf(cl.country).name}, role needs onsite presence`;

  const parts: MatchPart[] = [
    { k: 'Skill coverage', v: skillPts, max: 40, d: r.skills.filter((s) => c.skills.includes(s)).join(', ') || 'adjacent skills only' },
    { k: 'Role fit', v: rolePts, max: 20, d: `${c.role} vs ${r.role}` },
    { k: 'Work authorisation', v: authPts, max: 15, d: authNote },
    {
      k: 'Margin at bill rate', v: ratePts, max: 15,
      d: `${Math.round(margin * 100)}% gross margin${c.country !== cl.country ? ' · offshore cost base' : ''}`,
    },
    { k: 'Availability', v: avail, max: 10, d: c.status },
    { k: 'Experience', v: expPts, max: 10, d: `${c.exp} years, role expects ${wantExp}` },
  ];

  /* 110 is the sum of the maximums; the score is that scaled to 100, then gated. */
  const raw = sum(parts, (p) => p.v);
  return {
    total: Math.min(100, Math.round((raw / 110) * 100 * gate)),
    parts,
    gate,
    eligible,
    offshore: c.country !== cl.country,
    remoteOk,
    margin: Math.round(margin * 100),
    cost,
    bill,
  };
}

export const matchScore = (c: Consultant, r: StaffingRequirement): number => matchExplain(c, r).total;

export interface MatchBand {
  l: string;
  c: string;
}

export const matchBand = (n: number): MatchBand =>
  n >= 80 ? { l: 'Strong', c: 'var(--s6)' }
    : n >= 62 ? { l: 'Good', c: 'var(--s1)' }
      : n >= 45 ? { l: 'Possible', c: 'var(--s3)' }
        : { l: 'Weak', c: 'var(--s8)' };

/** Requirements still taking submissions. */
export const openReqs = (): StaffingRequirement[] =>
  REQUIREMENTS.filter((r) => r.status === 'Open' && r.filled < r.positions);

/** The floor a pairing has to clear before it is worth proposing. */
export const MATCH_FLOOR = 55;
