import { createCanvas } from '@napi-rs/canvas';
import {
  THUMBNAIL_MAX_EDGE,
  exceedsPixelCap,
  makeThumbnail,
  thumbnailDimensions,
} from '../../../main/services/content/imageThumbnail';

// Real Skia encode/decode; fixtures generated in-memory, no binary assets.
// @see #208
const pngOf = (width: number, height: number): Buffer => {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3366ff';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
};

describe('thumbnailDimensions (#208)', () => {
  it('bounds the longest edge and preserves aspect ratio', () => {
    expect(thumbnailDimensions(2000, 1000, 512)).toEqual({ width: 512, height: 256 });
    expect(thumbnailDimensions(1000, 2000, 512)).toEqual({ width: 256, height: 512 });
  });

  it('never upscales an already-small image', () => {
    expect(thumbnailDimensions(100, 50, 512)).toEqual({ width: 100, height: 50 });
  });

  it('keeps at least one pixel on extreme aspect ratios', () => {
    expect(thumbnailDimensions(10000, 1, 512)).toEqual({ width: 512, height: 1 });
  });
});

describe('makeThumbnail (#208)', () => {
  it('downscales a large image to the cap and returns a PNG', async () => {
    const source = pngOf(1200, 600);
    const result = await makeThumbnail(source, 512);
    expect(result.width).toBe(512);
    expect(result.height).toBe(256);
    // PNG magic number: the derived object is always PNG regardless of source.
    expect(result.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('passes a small image through without upscaling', async () => {
    const source = pngOf(64, 48);
    const result = await makeThumbnail(source, THUMBNAIL_MAX_EDGE);
    expect(result.width).toBe(64);
    expect(result.height).toBe(48);
  });

  it('throws on an undecodable buffer', async () => {
    await expect(makeThumbnail(Buffer.from('not an image'))).rejects.toThrow();
  });

  it('guards the pixel budget before canvas allocation (#396)', () => {
    expect(exceedsPixelCap(8000, 8000)).toBe(false);
    expect(exceedsPixelCap(8001, 8001)).toBe(true);
    expect(exceedsPixelCap(1, 1)).toBe(false);
  });
});
