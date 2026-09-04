/** The learning screens' data access. */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useCourses = () => useQuery((s) => s.learning.courses(), []);
export const useEnrolments = (empIds?: string[]) =>
  useQuery((s) => s.learning.enrolments(empIds), [empIds ? empIds.join(',') : 'all']);
export const useEnrol = () => useMutation((s, empId: string, courseId: string) => s.learning.enrol(empId, courseId));
export const useSetProgress = () =>
  useMutation((s, empId: string, courseId: string, progress: number) => s.learning.setProgress(empId, courseId, progress));
