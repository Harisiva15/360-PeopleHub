/**
 * The documents screens' data access.
 */

import { useMutation, useQuery } from '../../services/react';
import type { NewDocRequest } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useDocuments = (empIds?: string[]) =>
  useQuery((s) => s.documents.documents(empIds), [empIds ? empIds.join(',') : 'all']);
export const useDocumentTypes = () => useQuery((s) => s.documents.documentTypes(), []);
export const useLetterRequests = () => useQuery((s) => s.letters.requests(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useIssueLetter = () => useMutation((s, id: string) => s.letters.issue(id));
export const useLetterContext = (empId: string) =>
  useQuery((s) => s.documents.letterContext(empId), [empId]);

/* ---------- document collection ---------- */

/** Scope is one joiner or one employee; an empty scope is everyone. */
export const useDocRequests = (q: { journeyId?: string; empId?: string } = {}) =>
  useQuery((s) => s.documents.requests(q), [q.journeyId ?? '', q.empId ?? '']);
export const useDocSummary = (q: { journeyId?: string; empId?: string } = {}) =>
  useQuery((s) => s.documents.collectionSummary(q), [q.journeyId ?? '', q.empId ?? '']);

export const useSetDocStatus = () =>
  useMutation((s, id: string, status: string, note?: string) =>
    s.documents.setRequestStatus(id, status, note));
export const useRequestDocument = () =>
  useMutation((s, draft: NewDocRequest) => s.documents.requestDocument(draft));
export const useRequestChecklist = () =>
  useMutation((s, journeyId: string, due?: string) =>
    s.documents.requestChecklist(journeyId, due));
