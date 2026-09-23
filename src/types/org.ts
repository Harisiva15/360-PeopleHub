import type { CountryId, Grade } from './country';

export interface Site {
  id: string;
  name: string;
  city: string;
  country: CountryId;
  addr: string;
  /** WFH and client sites are ways of working, not buildings. */
  remote: boolean;
  /** Fence centre. Null for a remote mode, or an office not yet fenced. */
  lat: number | null;
  lng: number | null;
  /** Fence radius in metres; null means unfenced. */
  radius: number | null;
  /** Monthly professional tax for the site's state (India only). */
  ptax: number;
  tz: string;
  shift: string;
  /**
   * What kind of place this is. Optional because the demo dataset predates the
   * column and every screen that only names a site does not need it.
   *
   * CLIENT and WFH are deliberately not offices — somebody working from home is
   * not at one, and a client's building is not ours.
   */
  kind?: 'headquarters' | 'office' | 'client' | 'remote';
  /** At most one per company, enforced by a partial unique index (0044). */
  headquarters?: boolean;
  state?: string;
  postcode?: string;
  /**
   * Whether the location is open.
   *
   * A closed one is still returned, because an attendance row from last year
   * names it and a screen has to resolve that code to something better than a
   * dash. No form offers it. Absent means open — the demo table predates this.
   */
  active?: boolean;
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
