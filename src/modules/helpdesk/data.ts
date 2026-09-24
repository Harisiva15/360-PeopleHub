/** The helpdesk screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { KbDraft } from '../../services';

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

/* ---------- knowledge base authoring ---------- */

/*
 * The knowledge base had a read and nothing else, so a policy could be shown
 * and never written. The service refuses anyone but an administrator or a
 * manager; these are what the screen calls.
 */
export const useCreateArticle = () =>
  useMutation((s, draft: KbDraft) => s.helpdesk.createArticle(draft));
export const useUpdateArticle = () =>
  useMutation((s, id: string, patch: Partial<KbDraft>) => s.helpdesk.updateArticle(id, patch));
export const useRemoveArticle = () =>
  useMutation((s, id: string) => s.helpdesk.removeArticle(id));
