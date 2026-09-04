/**
 * The swap point.
 *
 * One module decides which implementation the app runs against. Today that is
 * the in-memory mock over `src/data`; pointing the app at a real backend means
 * writing an HTTP implementation of the same contracts and changing the line
 * below — no screen changes.
 */

import type { Services } from './contracts';
import { mockServices } from './mock';

let active: Services = mockServices;

export const getServices = (): Services => active;

/** Swap the implementation — the seam an HTTP client or a test double plugs into. */
export const setServices = (s: Services): void => {
  active = s;
};

export * from './contracts';
