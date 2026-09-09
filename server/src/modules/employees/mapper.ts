/**
 * Database row → the `Employee` the contract promises.
 *
 * This translation is the whole point of the seam, and it is where a REST API
 * that "returns the table" goes wrong. Three mismatches have to be resolved
 * here rather than in 35 screens:
 *
 *   1. Screens call `deptOf(e.dept)` against static config keyed by *code*
 *      ('ENG', 'CHN', 'L3'). The database keys by uuid. So the query joins and
 *      returns codes; uuids stay server-side where they belong.
 *   2. The contract's enums are display values ('Active', 'Full-time') while
 *      the database uses its own ('on_notice', 'permanent'). The database has
 *      states the contract does not — a person on notice is still Active to a
 *      screen — so the mapping is deliberately lossy in one direction only.
 *   3. Fields for data this deployment does not store — bank details, PAN —
 *      come back empty rather than absent, because the contract types them as
 *      present. Empty is honest; fabricated would not be.
 */

/*
 * Declared here rather than imported from the frontend. Importing across the
 * two packages looked tempting — one definition, no drift — but their
 * moduleResolution settings differ, and bending the server's to suit the
 * client's is a worse trade than restating 40 fields.
 *
 * Drift is caught instead where both types genuinely resolve: checks/
 * http-services.ts compares a live API response against the contract's own
 * Employee, so a field added on one side and forgotten on the other fails a
 * test rather than rendering blank.
 */
export interface Employee {
  id: string;
  code: string;
  name: string;
  gender: 'M' | 'F' | 'X';
  dob: string;
  doj: string;
  dol: string | null;
  email: string;
  phone: string;
  dept: string;
  designation: string;
  grade: string;
  site: string;
  country: string;
  ccy: string;
  entityId: string;
  managerId: string | null;
  status: 'Active' | 'Exited';
  empType: 'Full-time' | 'Contract';
  ctc: number;
  bank: string;
  acct: string;
  ifsc: string;
  blood: string;
  address: string;
  emergency: string;
  skills: string[];
  role: 'admin' | 'manager' | 'employee';
  reports: string[];
  shift: string;
  probation: boolean;
  exitReason: string | null;
  notice: number;
  pan: string | null;
  uan: string | null;
  pf: string | null;
  esi: string | null;
}

/** One row of the query in queries.ts. */
export interface EmployeeRow {
  id: string;
  code: string;
  full_name: string;
  gender: string | null;
  date_of_birth: string | null;
  joined_on: string;
  left_on: string | null;
  work_email: string;
  phone: string | null;
  dept_code: string | null;
  designation: string | null;
  grade_code: string | null;
  site_code: string | null;
  entity_country: string | null;
  currency: string | null;
  manager_id: string | null;
  status: string;
  employment_type: string;
  ctc: string | null;
  blood_group: string | null;
  address: string | null;
  emergency_contact: string | null;
  app_role: string;
  shift_code: string | null;
  on_probation: boolean;
  exit_reason: string | null;
  notice_days: number;
  skills: string[] | null;
  reports: string[] | null;
}

/**
 * The contract knows two states; the database knows four. `on_notice` and
 * `suspended` are still Active to a screen — they have not left — so only a
 * genuine exit maps to Exited.
 */
const toStatus = (s: string): Employee['status'] => (s === 'exited' ? 'Exited' : 'Active');

const toEmpType = (t: string): Employee['empType'] =>
  (t === 'contract' || t === 'consultant' ? 'Contract' : 'Full-time');

/**
 * Gender is carried through as recorded, including 'X' and undisclosed. The
 * letter renderer uses it to choose pronouns, and defaulting an unknown value
 * to 'M' would misgender a real person on a printed legal document.
 */
const toGender = (g: string | null): Employee['gender'] =>
  (g === 'F' || g === 'M' ? g : 'X');

export function toEmployee(r: EmployeeRow, showCompensation: boolean): Employee {
  return {
    id: r.id,
    code: r.code,
    name: r.full_name,
    gender: toGender(r.gender),
    dob: r.date_of_birth ?? '',
    doj: r.joined_on,
    dol: r.left_on,
    email: r.work_email,
    phone: r.phone ?? '',
    dept: r.dept_code ?? '',
    designation: r.designation ?? '',
    grade: (r.grade_code ?? 'L1'),
    site: r.site_code ?? '',
    country: (r.entity_country ?? 'IN'),
    ccy: (r.currency ?? 'INR'),
    entityId: (r.entity_country ?? 'IN'),
    managerId: r.manager_id,
    status: toStatus(r.status),
    empType: toEmpType(r.employment_type),
    // Not fetched at all for a caller without permission — see the service.
    ctc: showCompensation ? Number(r.ctc ?? 0) : 0,

    /*
     * This deployment does not store bank details or national identifiers, so
     * these are structurally empty rather than unavailable. See migration 0003
     * for what that costs and what has to arrive with them if they return.
     */
    bank: '',
    acct: '',
    ifsc: '',
    pan: null,
    uan: null,
    pf: null,
    esi: null,

    blood: r.blood_group ?? '',
    address: r.address ?? '',
    emergency: r.emergency_contact ?? '',
    skills: r.skills ?? [],
    // A CHECK constraint restricts this column to the three values, so the
    // narrowing is safe; the driver simply types every text column as string.
    role: r.app_role as Employee['role'],
    reports: r.reports ?? [],
    shift: r.shift_code ?? 'GEN',
    probation: r.on_probation,
    exitReason: r.exit_reason,
    notice: r.notice_days,
  };
}
