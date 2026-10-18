import { createCanvas, loadImage } from '@napi-rs/canvas';
import { withTimeout } from './markdownConversion';

// Thumbnails: the viewer must not pull a 15 MB original into the pane.
// @see #208

// Longest-edge cap; aspect ratio preserved, never upscaled.
export const THUMBNAIL_MAX_EDGE = 512;

// Hard ceiling per attempt so a pathological image cannot wedge the poller.
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

// Decode and return a bounded PNG thumbnail; throws on failure.
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
      // Flatten alpha onto white; a transparent source would read as a hole.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      return { buffer: canvas.toBuffer('image/png'), width, height };
    })(),
    timeoutMs,
    'thumbnail',
  );
