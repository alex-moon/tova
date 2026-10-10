"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeThumbnail = exports.thumbnailDimensions = exports.THUMBNAIL_TIMEOUT_MS = exports.THUMBNAIL_MAX_EDGE = void 0;
const canvas_1 = require("@napi-rs/canvas");
// Image thumbnails (issue #208): the /assets viewer must not pull a 15 MB
// original into the detail pane, so the asset worker derives one bounded
// thumbnail and stores it alongside the original. `@napi-rs/canvas` is the
// native Skia binding already in the tree (direct dependency as of this
// ticket); it decodes the four allowlisted image types and re-encodes PNG.
// Longest-edge cap. A 512px PNG of a screenshot or photo is well under the
// original and always fits the pane; the aspect ratio is preserved.
exports.THUMBNAIL_MAX_EDGE = 512;
// Hard ceiling per thumbnail attempt, mirroring the conversion timeout: a
// pathological image must not wedge the poller.
exports.THUMBNAIL_TIMEOUT_MS = 15000;
// Scale (w,h) so the longest edge is at most maxEdge; never upscales.
const thumbnailDimensions = (width, height, maxEdge = exports.THUMBNAIL_MAX_EDGE) => {
    const longest = Math.max(width, height);
    if (longest <= maxEdge)
        return { width, height };
    const scale = maxEdge / longest;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
};
exports.thumbnailDimensions = thumbnailDimensions;
const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => {
        var _a;
        const t = setTimeout(() => reject(new Error(`thumbnail timed out after ${ms}ms`)), ms);
        (_a = t.unref) === null || _a === void 0 ? void 0 : _a.call(t);
    }),
]);
// Decode a source image buffer and return a bounded PNG thumbnail. Throws on
// an undecodable buffer, a zero-sized image, or a draw/encode failure so the
// job loop records a reason; the asset itself is unaffected.
const makeThumbnail = (buffer_1, ...args_1) => __awaiter(void 0, [buffer_1, ...args_1], void 0, function* (buffer, maxEdge = exports.THUMBNAIL_MAX_EDGE, timeoutMs = exports.THUMBNAIL_TIMEOUT_MS) {
    return withTimeout((() => __awaiter(void 0, void 0, void 0, function* () {
        const image = yield (0, canvas_1.loadImage)(buffer);
        if (!image.width || !image.height) {
            throw new Error('image could not be decoded');
        }
        const { width, height } = (0, exports.thumbnailDimensions)(image.width, image.height, maxEdge);
        const canvas = (0, canvas_1.createCanvas)(width, height);
        const ctx = canvas.getContext('2d');
        // Flatten alpha onto white: JPEG is not used, but a transparent source
        // rendered on a dark pane reads as a hole; a white mat is the least
        // surprising neutral and keeps GIF/PNG/screenshots legible.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        return { buffer: canvas.toBuffer('image/png'), width, height };
    }))(), timeoutMs);
});
exports.makeThumbnail = makeThumbnail;
