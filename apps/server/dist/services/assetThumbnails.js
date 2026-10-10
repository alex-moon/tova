"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.thumbnailKeyFor = exports.THUMBNAIL_OBJECT_NAME = void 0;
// Image-thumbnail pipeline (issue #208): the derived thumbnail object lives
// alongside the original under the same `<userId>/<assetId>/` prefix, so a
// factory-reset / asset-sweep by prefix already covers it and the two objects
// can never drift apart. Kept out of `imageThumbnail.ts` so the pure Skia
// helper stays unaware of key layout.
exports.THUMBNAIL_OBJECT_NAME = 'thumbnail';
const thumbnailKeyFor = (userId, assetId) => `${userId}/${assetId}/${exports.THUMBNAIL_OBJECT_NAME}`;
exports.thumbnailKeyFor = thumbnailKeyFor;
