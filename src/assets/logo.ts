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
 * **One mark, two grounds.** The wordmark "People" is set in the same navy as
 * the navigation rail and measures 1.07 against it — invisible, not merely
 * dim. So there are two assets: the supplied artwork for light grounds, and a
 * reversed lockup for the rail, where that word is white.
 *
 * The reversed one is derived rather than drawn, by `scripts/reverse-logo.mjs`,
 * which also gives back the alpha the supplied file's hard-keyed edge threw
 * away — a ring of near-white pixels that is invisible on white and a halo on
 * navy. Re-run that script if the artwork is ever replaced.
 *
 * If a proper reversed asset is ever supplied by whoever owns the brand, it
 * replaces the derived one here and nothing else moves.
 */

import mark from './360-people-hub.png';
import reversed from './360-people-hub-reversed.png';

/** The artwork as supplied. For white and near-white grounds. */
export const LOGO_LIGHT = mark;

/**
 * The reversed lockup, for the navy rail. Not a dark-theme variant — the rail
 * is navy in both themes, so this is about the surface, not the theme.
 */
export const LOGO_ON_RAIL = reversed;

/**
 * Kept for callers that ask by theme. Both themes put the mark on the same
 * navy rail, so both get the reversed lockup.
 */
export const logoFor = (_theme: 'light' | 'dark'): string => reversed;
