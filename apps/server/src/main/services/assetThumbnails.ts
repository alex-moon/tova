import type { Types } from 'mongoose';

// Thumbnails share the `<userId>/<assetId>/` prefix so a sweep covers them.
// @see #208

export const THUMBNAIL_OBJECT_NAME = 'thumbnail';

export const thumbnailKeyFor = (userId: string, assetId: string | Types.ObjectId): string =>
  `${userId}/${assetId}/${THUMBNAIL_OBJECT_NAME}`;
