/**
 * The documents screens' data access.
 */

import { useMutation, useQuery } from '../../services/react';

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
