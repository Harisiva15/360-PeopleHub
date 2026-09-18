/**
 * Derives the reversed brand mark — the one that sits on the navy rail.
 *
 * Two things are wrong with the supplied artwork the moment it moves off a
 * white ground, and neither can be fixed in CSS:
 *
 * **It has a white rim.** The background was keyed out with hard alpha —
 * every pixel is either fully opaque or fully clear, with nothing in between —
 * so the anti-aliased edge the artwork was drawn with survived as a ring of
 * near-white opaque pixels. On white that ring is invisible. On navy it is a
 * halo around every letter and every curve of the cloud. The fix is to give
 * those pixels back the alpha they should have had: the whiter an edge pixel
 * is, the more of it was background.
 *
 * **The wordmark is navy.** "People" is set in the same navy as the rail and
 * measures 1.07 against it, which is not low contrast but invisible. It is
 * reversed to white — which is what a reversed lockup is, and what the brief
 * means by "white text where applicable".
 *
 * The mark itself is left exactly as drawn. Its blue, cyan and green carry
 * against navy on their own (3.52, 5.10 and 4.31), so recolouring any of it
 * would be changing the logo rather than reversing it.
 *
 * Run: node scripts/reverse-logo.mjs
 *
 * Checked in as a script rather than done once by hand, so the asset can be
 * rebuilt when the artwork is replaced — and so the rule for what changed is
 * written down rather than living in a PNG somebody has to reverse-engineer.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src/assets/360-people-hub.png');
const OUT = join(root, 'src/assets/360-people-hub-reversed.png');

/**
 * The bands in the artwork, as fractions of its height so a re-export at
 * another size still lands in the right place. Found from the gaps between
 * rows carrying ink: mark 19.6–58.3%, wordmark 61.1–76.2%, strapline 78.4–81%.
 */
const MARK_END = 0.60;
const TAGLINE_START = 0.77;

/** Below this luminance a colour cannot be read on the rail at all. */
const TOO_DARK = 90;

/** How white an edge pixel must be before it is treated as leftover matte. */
const MATTE = 0.55;

const png = PNG.sync.read(readFileSync(SRC));
const { width: W, height: H, data: d } = png;

const idx = (x, y) => (W * y + x) << 2;
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/* ---- 1. give the keyed edge its alpha back ---- */

/* The clear/opaque map has to be read from the original while it is untouched. */
const clear = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) clear[i] = d[(i << 2) + 3] < 20 ? 1 : 0;

const touchesClear = (x, y) => {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return true;
      if (clear[W * ny + nx]) return true;
    }
  }
  return false;
};

let softened = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    if (clear[W * y + x]) continue;
    if (!touchesClear(x, y)) continue;

    /*
     * How much of this pixel was background. A pixel drawn over white ends up
     * lighter the more background it contains, and the darkest channel is the
     * one that survives the blend — so the minimum channel is the measure.
     */
    const whiteness = Math.min(d[i], d[i + 1], d[i + 2]) / 255;
    if (whiteness < MATTE) continue;

    d[i + 3] = Math.round(255 * (1 - whiteness));
    softened++;
  }
}

/* ---- 2. reverse the type ---- */

let reversed = 0;
let strapline = 0;
for (let y = 0; y < H; y++) {
  const band = y / H;
  if (band < MARK_END) continue;            /* the mark keeps every colour */

  for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    if (d[i + 3] < 20) continue;
    if (lum(d[i], d[i + 1], d[i + 2]) >= TOO_DARK) continue;  /* blue 360, green Hub */

    if (band >= TAGLINE_START) {
      /* The strapline, in the light blue the rail's caption uses, so the two
         agree rather than compete. */
      d[i] = 0xA9; d[i + 1] = 0xC2; d[i + 2] = 0xDC;
      strapline++;
    } else {
      d[i] = 0xFF; d[i + 1] = 0xFF; d[i + 2] = 0xFF;          /* "People" */
      reversed++;
    }
  }
}

writeFileSync(OUT, PNG.sync.write(png));
console.log(
  `wrote ${OUT.split(/[\\/]/).pop()}\n`
  + `  ${softened} edge pixels given their alpha back (the white rim)\n`
  + `  ${reversed} wordmark pixels reversed to white\n`
  + `  ${strapline} strapline pixels set to the caption's light blue`,
);
