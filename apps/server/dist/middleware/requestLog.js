"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLog = void 0;
const logService_1 = require("../services/logService");
// Issue #76: one compact line per request so the admin logs view shows HTTP
// activity. The logs endpoint itself is skipped so polling does not spam
// the buffer. Errors are still surfaced by their normal handlers; this is
// observation only, never short-circuiting.
const requestLog = (req, res, next) => {
    const skip = req.method === 'GET' && req.path === '/api/admin/logs';
    if (skip)
        return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const status = res.statusCode;
        const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
        logService_1.logger[level](`${req.method} ${req.originalUrl.split('?')[0]} -> ${status} (${Math.round(ms)}ms)`);
    });
    return next();
};
exports.requestLog = requestLog;
