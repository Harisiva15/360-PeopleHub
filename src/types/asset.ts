import type { CountryId } from './country';

export type AssetStatus = 'Assigned' | 'In stock' | 'In repair' | 'Retired' | 'Lost';

export interface Asset {
  id: string;
  /** Null while the item sits in stock, is in repair or has been retired. */
  empId: string | null;
  type: string;
  serial: string;
  issued: string | null;
  status: AssetStatus;

  /* added by the asset-management layer */
  cat?: string;
  cost?: number;
  vendor?: string;
  /** Asset tag stuck on the item, e.g. AT-40118. */
  tag?: string;
  purchased?: string;
  warrantyEnd?: string;
  site?: string;
  country?: CountryId;
  condition?: string;
  /** Set when the item came back from a leaver. */
  recoveredFrom?: string;
  recoveredOn?: string;
  retiredOn?: string;
  disposal?: string;
}
