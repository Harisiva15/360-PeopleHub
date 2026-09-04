/**
 * Sidebar pills.
 *
 * These used to be a synchronous `badge` callback on each module, which meant
 * they could only ever count rows the client already held. They come from the
 * service now, in one call, and refresh with every mutation like any other
 * query.
 */

import { useQuery } from '../services/react';
import { useCaller } from '../services/people';

export function useNavBadges(): Record<string, number> {
  const caller = useCaller();
  const { data } = useQuery((s) => s.approvals.navBadges(caller), [caller.role, caller.meId]);
  return data ?? {};
}
