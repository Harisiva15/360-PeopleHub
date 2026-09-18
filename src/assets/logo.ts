/**
 * The brand mark.
 *
 * **A file, not a data URI.** Both marks used to be inlined as base64 so the
 * shell rendered with no network fetch. That made sense at a few kilobytes and
 * stopped making sense at 320: inlining it puts a third of a megabyte into the
 * JavaScript bundle, where it is re-downloaded on every release and cannot be
 * cached separately from the code. As a file Vite fingerprints it, the browser
 * caches it across deploys, and the only cost is that it paints a moment after
 * the shell rather than with it.
 *
 * **One mark, two grounds.** The logo has a navy wordmark and a slate tagline,
 * which read well on the light rail and disappear on the dark one. Rather than
 * recolour the artwork — which is not this file's decision to make — the dark
 * theme sits it on a light plate, the way a brand guideline normally handles a
 * mark with dark elements. `logoFor` keeps its signature so no caller changes.
 */

import mark from './360-people-hub.png';

export const LOGO_LIGHT = mark;

/*
 * The same artwork. Kept as a separate export because the two are a brand
 * decision that could diverge — if a reversed version is ever supplied, it
 * lands here and nothing else moves.
 */
export const LOGO_DARK = mark;

export const logoFor = (_theme: 'light' | 'dark'): string => mark;
