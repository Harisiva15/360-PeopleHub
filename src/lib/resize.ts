/**
 * Shrink a chosen image before it is uploaded.
 *
 * A profile photo is rendered at 56px at the largest, so sending the 4 MB
 * original off somebody's phone spends their bandwidth and our storage on
 * pixels nothing will ever show. 256px square is four times the largest render
 * size, which leaves room for a high-density display and nothing else.
 *
 * **This is a courtesy, not a guarantee.** The server cannot verify it: it has
 * no image decoder, and adding one to read two integers out of a header would
 * be a dependency and an attack surface for a property nothing relies on. So
 * the server enforces what it can check against the bytes — the byte count and
 * the type's magic number — and everything downstream tolerates a photo of any
 * dimensions. `Avatar` draws it with `object-fit: cover` for exactly that
 * reason.
 *
 * Which means this function failing is not a problem: the caller falls back to
 * the original file, the server applies its own limits, and the only cost is
 * bandwidth.
 */

/** The longest edge of an uploaded photo, in CSS pixels. */
export const PHOTO_EDGE = 256;

/** What the server accepts. Mirrored from `modules/photos/service.ts`. */
export const PHOTO_TYPES = ['image/png', 'image/jpeg'] as const;

export interface Resized {
  bytes: Blob;
  mimeType: string;
  /** True when this is the original, because resizing was not possible. */
  original: boolean;
}

/**
 * A square, centre-cropped copy at most `PHOTO_EDGE` on a side.
 *
 * Centre-cropped rather than letterboxed, because the result is displayed in a
 * circle: padding a portrait to a square would put the bars inside the circle
 * and the face off-centre.
 *
 * PNG stays PNG so transparency survives; everything else comes out as JPEG,
 * which is what a photograph should be and is a fraction of the size.
 */
export async function resizeForPhoto(file: File): Promise<Resized> {
  const keepPng = file.type === 'image/png';
  const outType = keepPng ? 'image/png' : 'image/jpeg';

  try {
    const bitmap = await createImageBitmap(file);
    try {
      const edge = Math.min(bitmap.width, bitmap.height);
      /* Never scale up: a 64px photo stays 64px rather than being blurred to
         256 and quadrupling its size for nothing. */
      const out = Math.min(PHOTO_EDGE, edge);

      const canvas = document.createElement('canvas');
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { bytes: file, mimeType: file.type, original: true };

      /* The centre square of the source, drawn to fill the whole canvas. */
      ctx.drawImage(
        bitmap,
        (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge,
        0, 0, out, out,
      );

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, outType, keepPng ? undefined : 0.85);
      });
      if (!blob) return { bytes: file, mimeType: file.type, original: true };

      /*
       * If the "resized" copy is not smaller, send the original. Re-encoding a
       * small PNG can easily make it bigger, and uploading a larger file to
       * save bandwidth is the opposite of the point.
       */
      if (blob.size >= file.size) {
        return { bytes: file, mimeType: file.type, original: true };
      }
      return { bytes: blob, mimeType: outType, original: false };
    } finally {
      bitmap.close();
    }
  } catch {
    /* No createImageBitmap, no canvas, or a file the browser cannot decode.
       The server will refuse anything it should; this only saves bandwidth. */
    return { bytes: file, mimeType: file.type, original: true };
  }
}
