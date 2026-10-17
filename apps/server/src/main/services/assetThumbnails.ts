import type { Types } from 'mongoose';

// The derived thumbnail lives under the same `<userId>/<assetId>/` prefix so a prefix sweep covers it and the pair can never drift; kept out of imageThumbnail.ts so the pure Skia helper stays key-layout-unaware.
// @see #208

export const THUMBNAIL_OBJECT_NAME = 'thumbnail';

export const thumbnailKeyFor = (userId: string, assetId: string | Types.ObjectId): string =>
  `${userId}/${assetId}/${THUMBNAIL_OBJECT_NAME}`;
