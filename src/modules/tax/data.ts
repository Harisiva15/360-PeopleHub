/** The tax screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { Declaration } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useTaxSummary = (empId: string) => useQuery((s) => s.payroll.taxSummary(empId), [empId]);
export const useTaxRows = () => useQuery((s) => s.payroll.taxRows(), []);

export const useSaveDeclaration = () =>
  useMutation((s, empId: string, items: Record<string, number | string>) => s.payroll.saveDeclaration(empId, items));
export const useSetRegime = () =>
  useMutation((s, empId: string, regime: Declaration['regime']) => s.payroll.setRegime(empId, regime));
export const useSubmitProofs = () => useMutation((s, empId: string) => s.payroll.submitProofs(empId));
export const useVerifyDeclaration = () => useMutation((s, empId: string) => s.payroll.verifyDeclaration(empId));
