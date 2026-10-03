import type { Types } from 'mongoose';

// Image-thumbnail pipeline (issue #208): the derived thumbnail object lives
// alongside the original under the same `<userId>/<assetId>/` prefix, so a
// factory-reset / asset-sweep by prefix already covers it and the two objects
// can never drift apart. Kept out of `imageThumbnail.ts` so the pure Skia
// helper stays unaware of key layout.

export const THUMBNAIL_OBJECT_NAME = 'thumbnail';

export const thumbnailKeyFor = (userId: string, assetId: string | Types.ObjectId): string =>
  `${userId}/${assetId}/${THUMBNAIL_OBJECT_NAME}`;
