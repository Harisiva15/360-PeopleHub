/** The WhatsApp screens' data access. */

import { useMutation, useQuery } from '../../services/react';

import { useCaller } from '../../services/people';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useTemplates = () => useQuery((s) => s.whatsapp.templates(), []);
/*
 * The rules were read from a constant in `src/data` while the toggle beside
 * them called a service — so the list and the switch were describing different
 * things. Both go through the service now; storage arrived in 0026.
 */
export const useRules = () => useQuery((s) => s.whatsapp.rules(), []);
export const useLog = (empId?: string) => useQuery((s) => s.whatsapp.log(empId), [empId ?? 'all']);
export const useWaStats = () => useQuery((s) => s.whatsapp.stats(), []);
export const useConsent = (empId: string) => useQuery((s) => s.whatsapp.consent(empId), [empId]);
export const useConsentRows = () => useQuery((s) => s.whatsapp.consentRows(), []);

export const useSetConsent = () =>
  useMutation((s, empId: string, key: 'optIn' | 'marketing', on: boolean) => s.whatsapp.setConsent(empId, key, on));
export const useSetTemplateEnabled = () =>
  useMutation((s, id: string, on: boolean) => s.whatsapp.setTemplateEnabled(id, on));
export const useSetRuleEnabled = () =>
  useMutation((s, id: string, on: boolean) => s.whatsapp.setRuleEnabled(id, on));

export const useCurrentRun = () => useQuery((s) => s.payroll.currentRun(), []);
export const usePayslip = (empId: string, mk: string) =>
  useQuery((s) => s.payroll.payslip(empId, mk), [empId, mk]);

/** The approval inbox, assembled and scoped by the service. */
export const usePendingItems = () => {
  const caller = useCaller();
  return useQuery((s) => s.approvals.pending(caller), [caller.role, caller.meId]);
};
export const usePendingCount = () => {
  const caller = useCaller();
  return useQuery((s) => s.approvals.pendingCount(caller), [caller.role, caller.meId]);
};
