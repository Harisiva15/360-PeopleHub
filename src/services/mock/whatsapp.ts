/**
 * WhatsApp notifications — templates, the send log, and consent.
 *
 * Consent is the interesting part: it is recorded per category, and marketing
 * rides on the same number as HR updates, so withdrawing the one withdraws the
 * other. That rule belongs on the server, not in the toggle that flips it.
 */

import { ACTIVE, EMAP } from '../../data/employees';
import {
  WA_CONSENT, WA_LOG, WA_RULES, WA_TEMPLATES, waConsent, waKPI,
} from '../../data/whatsapp';
import { TODAY, ymd } from '../../lib/dates';
import type { WaConsentRow, WhatsAppService } from '../contracts';
import { ok } from './util';

export const whatsappService: WhatsAppService = {
  templates() {
    return ok(WA_TEMPLATES.slice());
  },

  log(empId) {
    return ok(empId ? WA_LOG.filter((l) => l.empId === empId) : WA_LOG.slice());
  },

  stats() {
    const k = waKPI();
    return ok({
      sent: k.sent,
      delivered: k.delivered,
      read: k.read,
      failed: k.failed,
      replies: k.replies,
      deliveryRate: k.deliveryRate,
      readRate: k.readRate,
      cost: k.cost,
      optIn: k.optIn,
      optInRate: k.optInRate,
      active: k.active,
      workforce: ACTIVE().length,
    });
  },

  consent(empId) {
    return ok(waConsent(empId));
  },

  consentRows() {
    const rows: WaConsentRow[] = ACTIVE().map((e) => ({ employee: e, consent: waConsent(e.id) }));
    return ok(rows);
  },

  setConsent(empId, key, on) {
    const e = EMAP[empId];
    if (!e) return Promise.reject(new Error('No such employee: ' + empId));
    const rec = WA_CONSENT[empId];
    if (!rec) return Promise.reject(new Error('No consent record for ' + empId));
    if (key === 'marketing' && on && !rec.optIn) {
      return Promise.reject(new Error('Turn on HR updates before opting into celebration messages'));
    }
    rec[key] = on;
    /* Withdrawing HR updates stops the marketing category with it. */
    if (key === 'optIn' && !on) rec.marketing = false;
    /* Opting in for the first time records how and when. */
    if (key === 'optIn' && on && !rec.on) {
      rec.on = ymd(TODAY);
      rec.via = 'Self-service portal';
      rec.verified = true;
      rec.number = e.phone;
    }
    return ok(rec);
  },

  setTemplateEnabled(id, on) {
    const t = WA_TEMPLATES.find((x) => x.id === id);
    if (!t) return Promise.reject(new Error('No such template: ' + id));
    if (on && t.status !== 'Approved') {
      return Promise.reject(new Error('Meta has not approved this template yet'));
    }
    t.on = on;
    return ok(t);
  },

  setRuleEnabled(id, on) {
    const r = WA_RULES.find((x) => x.id === id);
    if (!r) return Promise.reject(new Error('No such rule: ' + id));
    r.on = on;
    return ok({ id: r.id, on: r.on });
  },
};
