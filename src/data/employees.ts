import { addDays, daysBetween, TODAY, ymd } from '../lib/dates';
import { uniq } from '../lib/collections';
import { chance, pick, ri } from '../lib/rng';
import { countryOf, dialFor, localBand } from './countries';
import { BANKS, BLOOD, deptOf, FIRST_F, FIRST_M, GRADES, LAST, siteOf, SKILLS, TITLES } from './org';
import type { Grade } from '../types/country';
import type { AppRole, Employee, EmpType } from '../types/employee';

export const EMP: Employee[] = [];
let empSeq = 0;

interface MkEmpArgs {
  name?: string;
  gender?: 'M' | 'F';
  dept: string;
  grade: Grade;
  site: string;
  doj: string;
  dol?: string;
  /** India-denominated CTC; converted onto the local band outside India. */
  ctc?: number;
  managerId?: string;
  role?: AppRole;
  empType?: EmpType;
  exitReason?: string;
}

function mkEmp(o: MkEmpArgs): Employee {
  empSeq++;
  const gender = o.gender || (chance(0.62) ? 'M' : 'F');
  const name = o.name || pick(gender === 'M' ? FIRST_M : FIRST_F) + ' ' + pick(LAST);
  const grade = o.grade;
  const cty = siteOf(o.site)?.country || 'IN';
  const ctc = o.ctc
    ? cty === 'IN'
      ? o.ctc
      : localBand(o.ctc, cty, grade)
    : localBand(ri(GRADES[grade].min, GRADES[grade].max), cty, grade);
  const doj = o.doj;
  const dobY =
    TODAY.getFullYear() -
    ri(
      grade === 'L1' ? 21 : grade === 'L2' ? 24 : grade === 'L3' ? 28 : grade === 'L4' ? 32 : 36,
      grade === 'L1' ? 24 : grade === 'L2' ? 29 : grade === 'L3' ? 35 : grade === 'L4' ? 42 : 52,
    );
  const dob = dobY + '-' + String(ri(1, 12)).padStart(2, '0') + '-' + String(ri(1, 28)).padStart(2, '0');
  const code = 'TT' + String(1000 + empSeq);

  const e: Employee = {
    id: 'E' + String(empSeq).padStart(3, '0'),
    code,
    name,
    gender,
    dob,
    doj,
    dol: o.dol || null,
    email: name.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, '.') + '@360technology.in',
    phone: dialFor(cty),
    dept: o.dept,
    designation: TITLES[o.dept][grade],
    grade,
    site: o.site,
    country: cty,
    ccy: countryOf(cty).cur,
    entityId: cty,
    managerId: o.managerId || null,
    status: o.dol ? 'Exited' : 'Active',
    empType: o.empType || (chance(0.06) ? 'Contract' : 'Full-time'),
    ctc,
    pan: 'ABCPX' + ri(1000, 9999) + 'K',
    uan: '10' + ri(10000000000, 99999999999),
    pf: 'TN/MAS/' + ri(10000, 99999) + '/' + String(empSeq).padStart(5, '0'),
    esi: null,
    bank: pick(BANKS),
    acct: 'XXXX' + ri(1000, 9999),
    ifsc: 'HDFC000' + ri(1000, 9999),
    blood: pick(BLOOD),
    address:
      ri(1, 90) +
      ', ' +
      pick(['Anna Nagar', 'Velachery', 'Adyar', 'Indiranagar', 'HSR Layout', 'Gachibowli', 'Kondapur', 'T Nagar', 'Whitefield']) +
      ', ' +
      siteOf(o.site === 'WFH' ? 'CHN' : o.site).city,
    emergency: pick(FIRST_M) + ' ' + pick(LAST) + ' · +91 ' + ri(70, 99) + ri(10000000, 99999999),
    skills: uniq([pick(SKILLS), pick(SKILLS), pick(SKILLS), pick(SKILLS)]),
    role: o.role || 'employee',
    reports: [],
    shift: siteOf(o.site).shift,
    probation: daysBetween(doj, ymd(TODAY)) < 180,
    exitReason: o.exitReason || null,
    notice: countryOf(cty).noticeDays,
  };

  /* ESI applies only in India, and only below the wage ceiling */
  const mg = Math.round((e.ctc / 12) * 0.62);
  if (cty === 'IN' && mg <= 21000) e.esi = '31' + ri(10000000, 99999999);

  if (cty !== 'IN') {
    e.pan = null;
    e.uan = null;
    e.pf = null;
    e.esi = null;
  }
  if (cty === 'US') {
    e.ssn = 'XXX-XX-' + ri(1000, 9999);
    e.workAuth = pick(['US Citizen', 'Green Card', 'H1-B', 'H1-B', 'GC-EAD', 'TN', 'OPT-EAD']);
  }
  if (cty === 'CA') {
    e.sin = 'XXX-XXX-' + ri(100, 999);
    e.workAuth = pick(['Canadian Citizen', 'PR', 'Work Permit']);
  }
  if (cty === 'GB') {
    e.nino = 'QQ' + ri(100000, 999999) + 'C';
    e.workAuth = pick(['British Citizen', 'Settled Status', 'Skilled Worker Visa']);
  }
  if (cty === 'AE') {
    e.eid = '784-' + ri(1980, 2000) + '-' + ri(1000000, 9999999) + '-' + ri(1, 9);
    e.workAuth = pick(['UAE National', 'Employment Visa', 'Golden Visa']);
  }

  EMP.push(e);
  return e;
}

/** A joining date between `minY` and `maxY` days ago. */
function randDoj(minY: number, maxY: number): string {
  return ymd(addDays(TODAY, -ri(minY, maxY)));
}

/* ---- leadership ---- */
export const CEO = mkEmp({
  name: 'Vikram Sundaram',
  gender: 'M',
  dept: 'ENG',
  grade: 'L6',
  site: 'CHN',
  doj: '2014-06-02',
  ctc: 8800000,
  role: 'admin',
});
CEO.designation = 'Founder & Chief Executive Officer';

export const HEADS: Record<string, Employee> = {};
const headSeed = [
  { dept: 'ENG', name: 'Ravi Natarajan', gender: 'M' as const, site: 'CHN', doj: '2015-03-16' },
  { dept: 'QA', name: 'Anitha Menon', gender: 'F' as const, site: 'CHN', doj: '2016-07-11' },
  { dept: 'DEVOPS', name: 'Karthik Shetty', gender: 'M' as const, site: 'BLR', doj: '2017-01-09' },
  { dept: 'PROD', name: 'Meera Iyer', gender: 'F' as const, site: 'BLR', doj: '2016-11-21' },
  { dept: 'SALES', name: 'Sanjay Verma', gender: 'M' as const, site: 'HYD', doj: '2015-09-01' },
  { dept: 'SUP', name: 'Swathi Reddy', gender: 'F' as const, site: 'HYD', doj: '2018-02-05' },
  { dept: 'HR', name: 'Priya Raghavan', gender: 'F' as const, site: 'CHN', doj: '2016-04-04' },
  { dept: 'FIN', name: 'Balaji Srinivasan', gender: 'M' as const, site: 'CHN', doj: '2015-12-14' },
];
headSeed.forEach((h) => {
  const e = mkEmp({
    name: h.name,
    gender: h.gender,
    dept: h.dept,
    grade: 'L5',
    site: h.site,
    doj: h.doj,
    managerId: CEO.id,
    role: h.dept === 'HR' ? 'admin' : 'manager',
  });
  HEADS[h.dept] = e;
  deptOf(h.dept).head = e.id;
});
export const HRHEAD = HEADS.HR;

/* ---- managers ---- */
const MGR_PLAN: Record<string, number> = { ENG: 4, QA: 2, DEVOPS: 1, PROD: 1, SALES: 2, SUP: 2, HR: 1, FIN: 1 };
export const MANAGERS: Employee[] = [];
Object.keys(MGR_PLAN).forEach((d) => {
  for (let i = 0; i < MGR_PLAN[d]; i++) {
    MANAGERS.push(
      mkEmp({
        dept: d,
        grade: 'L4',
        site: pick(d === 'ENG' ? ['CHN', 'CHN', 'BLR', 'HYD'] : ['CHN', 'BLR', 'HYD']),
        doj: randDoj(900, 2600),
        managerId: HEADS[d].id,
        role: 'manager',
      }),
    );
  }
});

/** The manager the role-switcher signs in as. */
export const DEMO_MGR = MANAGERS.find((m) => m.dept === 'ENG')!;
DEMO_MGR.name = 'Arun Krishnan';
DEMO_MGR.gender = 'M';
DEMO_MGR.site = 'CHN';
DEMO_MGR.email = 'arun.krishnan@360technology.in';
DEMO_MGR.doj = '2018-08-20';
DEMO_MGR.ctc = 3150000;
DEMO_MGR.dob = '1988-11-27';

/* ---- individual contributors ---- */
const IC_PLAN: Record<string, number> = { ENG: 40, QA: 15, DEVOPS: 9, PROD: 8, SALES: 12, SUP: 12, HR: 5, FIN: 6 };
Object.keys(IC_PLAN).forEach((d) => {
  const mgrs = MANAGERS.filter((m) => m.dept === d);
  for (let i = 0; i < IC_PLAN[d]; i++) {
    const g: Grade = chance(0.28) ? 'L3' : chance(0.55) ? 'L2' : 'L1';
    const pool = ['ENG', 'QA', 'DEVOPS', 'SUP', 'SALES'].includes(d)
      ? ['CHN', 'CHN', 'CHN', 'CHN', 'BLR', 'BLR', 'HYD', 'NJ', 'NJ', 'DAL', 'TOR', 'DXB', 'LON']
      : ['CHN', 'CHN', 'CHN', 'BLR', 'BLR', 'HYD'];
    mkEmp({
      dept: d,
      grade: g,
      site: pick(pool),
      doj: randDoj(20, 2400),
      managerId: (mgrs.length ? pick(mgrs) : HEADS[d]).id,
    });
  }
});

/* ---- exits, so attrition reporting has history ---- */
for (let i = 0; i < 9; i++) {
  const d = pick(['ENG', 'ENG', 'QA', 'SUP', 'SALES', 'PROD']);
  const mgrs = MANAGERS.filter((m) => m.dept === d);
  mkEmp({
    dept: d,
    grade: chance(0.5) ? 'L2' : 'L3',
    site: pick(['CHN', 'BLR', 'HYD']),
    doj: randDoj(700, 2200),
    dol: ymd(addDays(TODAY, -ri(10, 340))),
    managerId: (mgrs.length ? pick(mgrs) : HEADS[d]).id,
    exitReason: pick(['Better opportunity', 'Higher studies', 'Relocation', 'Compensation', 'Personal reasons', 'Performance']),
  });
}

export const EMAP: Record<string, Employee> = {};
EMP.forEach((e) => (EMAP[e.id] = e));
EMP.forEach((e) => {
  if (e.managerId && EMAP[e.managerId] && e.status === 'Active') EMAP[e.managerId].reports.push(e.id);
});

export const ACTIVE = (): Employee[] => EMP.filter((e) => e.status === 'Active');
export const empName = (id: string): string => EMAP[id]?.name || '—';

/**
 * The employee the role-switcher signs in as.
 *
 * The overrides below place her in Chennai on an INR salary, so she has to be
 * picked from the India-based reports — everything else on the record derives
 * from the seeded site at generation time (currency, PAN/UAN/PF, notice period,
 * phone, address). Taking whoever came first meant landing on a UK-based
 * consultant and then stamping an INR CTC onto a GBP record, which converted
 * her ₹11.8L to ₹12.5 crore and made one junior engineer a fifth of the
 * company's payroll.
 */
const demoCandidates = EMP.filter((e) => e.managerId === DEMO_MGR.id && e.country === 'IN' && e.site === 'CHN');
export const DEMO_EMP =
  demoCandidates.find((e) => e.grade === 'L2') || demoCandidates[0] || EMP.find((e) => e.managerId === DEMO_MGR.id)!;
DEMO_EMP.name = 'Nithya Balan';
DEMO_EMP.gender = 'F';
DEMO_EMP.site = 'CHN';
DEMO_EMP.email = 'nithya.balan@360technology.in';
DEMO_EMP.doj = '2022-02-14';
DEMO_EMP.ctc = 1180000;
DEMO_EMP.dob = '1996-08-19';
DEMO_EMP.skills = ['React', 'TypeScript', 'Node.js', 'GraphQL'];

/** Reports under a manager — direct only, or the whole sub-tree when `deep`. */
export function teamOf(mgrId: string, deep?: boolean): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    (EMAP[id]?.reports || []).forEach((r) => {
      out.push(r);
      if (deep) walk(r);
    });
  };
  walk(mgrId);
  return out;
}
