import { createCanvas, loadImage } from '@napi-rs/canvas';

// Image thumbnails (issue #208): the /assets viewer must not pull a 15 MB
// original into the detail pane, so the asset worker derives one bounded
// thumbnail and stores it alongside the original. `@napi-rs/canvas` is the
// native Skia binding already in the tree (direct dependency as of this
// ticket); it decodes the four allowlisted image types and re-encodes PNG.

// Longest-edge cap. A 512px PNG of a screenshot or photo is well under the
// original and always fits the pane; the aspect ratio is preserved.
export const THUMBNAIL_MAX_EDGE = 512;

// Hard ceiling per thumbnail attempt, mirroring the conversion timeout: a
// pathological image must not wedge the poller.
export const THUMBNAIL_TIMEOUT_MS = 15_000;

export interface ThumbnailResult {
  buffer: Buffer;
  width: number;
  height: number;
}

// Scale (w,h) so the longest edge is at most maxEdge; never upscales.
export const thumbnailDimensions = (
  width: number,
  height: number,
  maxEdge = THUMBNAIL_MAX_EDGE,
): { width: number; height: number } => {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`thumbnail timed out after ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);

// Decode a source image buffer and return a bounded PNG thumbnail. Throws on
// an undecodable buffer, a zero-sized image, or a draw/encode failure so the
// job loop records a reason; the asset itself is unaffected.
export const makeThumbnail = async (
  buffer: Buffer,
  maxEdge = THUMBNAIL_MAX_EDGE,
  timeoutMs = THUMBNAIL_TIMEOUT_MS,
): Promise<ThumbnailResult> =>
  withTimeout(
    (async () => {
      const image = await loadImage(buffer);
      if (!image.width || !image.height) {
        throw new Error('image could not be decoded');
      }
      const { width, height } = thumbnailDimensions(image.width, image.height, maxEdge);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      // Flatten alpha onto white: JPEG is not used, but a transparent source
      // rendered on a dark pane reads as a hole; a white mat is the least
      // surprising neutral and keeps GIF/PNG/screenshots legible.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      return { buffer: canvas.toBuffer('image/png'), width, height };
    })(),
    timeoutMs,
  );
