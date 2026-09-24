/**
 * The documents screens' data access.
 */

import { useMutation, useQuery } from '../../services/react';
import { unbacked } from '../../services/unbacked';
import type { NewDocRequest } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/*
 * The repository reads the API. It did not always: both calls were wrapped in
 * `unbacked` when no server held documents, and the wrapper stayed after
 * `GET /documents` and `GET /documents/types` went live — so a configured
 * build returned an empty list without ever asking the server. The screen
 * looked empty and correct, which is why it survived so long.
 *
 * The letter context is genuinely still unmapped, and stays wrapped below.
 */
export const useDocuments = (empIds?: string[]) =>
  useQuery((s) => s.documents.documents(empIds), [empIds ? empIds.join(',') : 'all']);
export const useDocumentTypes = () => useQuery((s) => s.documents.documentTypes(), []);
export const useLetterRequests = () => useQuery((s) => s.letters.requests(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useIssueLetter = () => useMutation((s, id: string) => s.letters.issue(id));
export const useRejectLetter = () =>
  useMutation((s, id: string, reason: string) => s.letters.reject(id, reason));
export const useLetterTypes = () => useQuery((s) => s.letters.types(), []);
export const useRequestLetter = () =>
  useMutation((s, draft: { type: string; purpose?: string }) => s.letters.request(draft));
export const useLetterContext = (empId: string) =>
  useQuery(unbacked((s) => s.documents.letterContext(empId), null), [empId]);

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
