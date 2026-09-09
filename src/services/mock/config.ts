/**
 * Configuration writes.
 *
 * Each of these has reach beyond the row it edits, which is the argument for
 * putting them behind a service: an entitlement change reprices balances that
 * are already open. A save handler in a settings screen is the wrong place to
 * own that.
 */

import { ACTIVE } from '../../data/employees';
import { HOLIDAYS, HOLIDAY_MAP, ltOf, SITES } from '../../data/org';
import { LEAVE_BAL } from '../../data/leave';
import type { ConfigService } from '../contracts';
import { ok } from './util';

export const configService: ConfigService = {
  sites() { return ok(SITES.slice()); },
  holidays() { return ok(HOLIDAYS.slice()); },

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
