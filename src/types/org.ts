import type { CountryId, Grade } from './country';

export interface Site {
  id: string;
  name: string;
  city: string;
  country: CountryId;
  addr: string;
  /** Null for WFH and client sites — no fixed geo-fence. */
  lat: number | null;
  lng: number | null;
  /** Geo-fence radius in metres; 0 disables the fence. */
  radius: number;
  /** Monthly professional tax for the site's state (India only). */
  ptax: number;
  tz: string;
  shift: string;
}

export interface Dept {
  id: string;
  name: string;
  head: string | null;
  color: string;
}

export interface GradeBand {
  label: string;
  min: number;
  max: number;
}

export interface Holiday {
  d: string;
  n: string;
  /** Optional/restricted holiday — excluded from the paid-holiday map. */
  opt: boolean;
}

export interface LeaveType {
  id: string;
  name: string;
  quota: number;
  color: string;
  carry: boolean;
  cap?: number;
  encash: boolean;
  /** Restricts the type to one gender, e.g. maternity/paternity. */
  gender?: 'M' | 'F';
}

export interface Project {
  id: string;
  name: string;
  client: string;
  billable: boolean;
  color: string;
}

export type { CountryId, Grade };
