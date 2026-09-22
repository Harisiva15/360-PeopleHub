/**
 * The events screens' data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { EventDraft, EventFilter, RsvpChoice } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const keyOf = (f: EventFilter) =>
  [f.q, f.type, f.status, f.site, f.organiserId, f.when, f.mineOnly, f.from, f.to];

export function useEvents(f: EventFilter = {}) {
  const c = useCaller();
  return useQuery((s) => s.events.list(c, f), [c.role, c.meId, ...keyOf(f)]);
}

export function useEvent(id: string) {
  const c = useCaller();
  return useQuery((s) => s.events.get(c, id), [c.role, c.meId, id]);
}

/** What the signed-in person has said yes or maybe to. */
export function useMyEvents() {
  const c = useCaller();
  return useQuery((s) => s.events.mine(c), [c.role, c.meId]);
}

export function useEventStats() {
  const c = useCaller();
  return useQuery((s) => s.events.stats(c), [c.role, c.meId]);
}

export const useCreateEvent = () => {
  const c = useCaller();
  return useMutation((s, draft: EventDraft) => s.events.create(c, draft));
};

export const useUpdateEvent = () => {
  const c = useCaller();
  return useMutation((s, id: string, patch: Partial<EventDraft>) =>
    s.events.update(c, id, patch));
};

export const usePublishEvent = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.events.publish(c, id));
};

export const useCancelEvent = () => {
  const c = useCaller();
  return useMutation((s, id: string, reason: string) => s.events.cancel(c, id, reason));
};

export const useRemoveEvent = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.events.remove(c, id));
};

export const useRsvp = () => {
  const c = useCaller();
  return useMutation((s, eventId: string, choice: RsvpChoice) =>
    s.events.rsvp(c, eventId, choice));
};

export const useWithdraw = () => {
  const c = useCaller();
  return useMutation((s, eventId: string) => s.events.withdraw(c, eventId));
};

export const useMarkAttendance = () => {
  const c = useCaller();
  return useMutation((s, eventId: string, empId: string, attended: boolean) =>
    s.events.markAttendance(c, eventId, empId, attended));
};
