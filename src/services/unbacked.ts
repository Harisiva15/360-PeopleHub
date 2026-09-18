/**
 * A panel whose service is not mapped to the API yet.
 *
 * In a configured build it returns an empty result instead of the in-memory
 * dataset's invented rows. Empty is the true answer — the system holds no
 * courses or approval queue, because those services are not implemented — and
 * it is the only answer that cannot be acted on by mistake. The demo build is
 * unaffected and still shows everything, because it is explicitly a demo.
 *
 * This started life inside the dashboard, then the same need turned up in the
 * employee drawer and the document repository, and a second spelling of it
 * appeared. One idiom matters beyond tidiness: `checks/coverage.ts` decides
 * whether a module is honest to show by reading which service methods its
 * files call, and it recognises exactly this wrapper. A guard written a
 * different way reads as an unguarded call and fails the check — which is the
 * right failure, but a confusing one when the code was in fact careful.
 */

import { apiConfigured } from './http';
import type { Services } from './contracts';

export const unbacked = <T>(run: (s: Services) => Promise<T>, empty: T) =>
  (apiConfigured ? () => Promise.resolve(empty) : run);
