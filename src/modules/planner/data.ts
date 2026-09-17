/** The planner screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { NewWorkItem, WorkItemPatch, WorkItemQuery } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const key = (q: WorkItemQuery) =>
  [q.projectId, q.iterationId, q.assigneeId, q.kind, q.openOnly].join('|');

export const useItems = (q: WorkItemQuery) =>
  useQuery((s) => s.planner.items(q), [key(q)]);
export const useMyItems = (empId?: string) =>
  useQuery((s) => s.planner.mine(empId), [empId ?? 'me']);
export const useBoard = (projectId?: string) =>
  useQuery((s) => s.planner.board(projectId), [projectId ?? 'all']);
export const useIterations = () => useQuery((s) => s.planner.iterations(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);

export const useCreateItem = () =>
  useMutation((s, draft: NewWorkItem) => s.planner.createItem(draft));
export const useMoveItem = () =>
  useMutation((s, id: string, status: string, afterId?: string | null) =>
    s.planner.moveItem(id, status, afterId));
export const useUpdateItem = () =>
  useMutation((s, id: string, patch: WorkItemPatch) => s.planner.updateItem(id, patch));
export const useCommentOnItem = () =>
  useMutation((s, id: string, text: string) => s.planner.comment(id, text));
export const useCreateIteration = () =>
  useMutation((s, draft: { name: string; goal?: string; from: string; to: string }) =>
    s.planner.createIteration(draft));
