/** The helpdesk screens' data access. */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useTickets = (empIds?: string[]) =>
  useQuery((s) => s.helpdesk.tickets(empIds), [empIds ? empIds.join(',') : 'all']);
export const useKnowledgeBase = () => useQuery((s) => s.helpdesk.knowledgeBase(), []);
export const useRaiseTicket = () =>
  useMutation((s, t: Parameters<typeof s.helpdesk.raise>[0]) => s.helpdesk.raise(t));
export const useCommentOnTicket = () =>
  useMutation((s, id: string, by: string, text: string) => s.helpdesk.comment(id, by, text));
export const useResolveTicket = () => useMutation((s, id: string, csat?: number) => s.helpdesk.resolve(id, csat));
