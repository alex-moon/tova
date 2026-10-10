"use strict";
// #179: the in-memory ring buffer was removed — retained logs now come from
// Grafana Cloud (see services/lokiLogs.ts). What remains is the logging
// backbone: console.* capture (so output stays structured) and durable
// error-log persistence to MongoDB (issue #175), neither of which depends on
// a buffer.
Object.defineProperty(exports, "__esModule", { value: true });
exports.detachConsoleCapture = exports.attachConsoleCapture = exports.logger = void 0;
const util_1 = require("util");
const ErrorLog_1 = require("../models/ErrorLog");
const MAX_MSG_LENGTH = 2000;
// Issue #175: mirror error entries into MongoDB as they are emitted so
// diagnostics survive a restart. Fire-and-forget: failures are swallowed
// (never re-logged through console, which would recurse into the capture).
const persistErrorEntry = (ts, msg) => {
    if (process.env.NODE_ENV === 'test')
        return;
    ErrorLog_1.ErrorLog.create({ bufferId: null, ts, msg }).catch(() => { });
};
let captureAttached = false;
const originalConsole = {};
const normalize = (msg) => msg.replace(/\s*\n\s*/g, ' ').slice(0, MAX_MSG_LENGTH);
exports.logger = {
    info: (msg) => {
        console.info(msg);
    },
    warn: (msg) => {
        console.warn(msg);
    },
    error: (msg) => {
        console.error(msg);
    },
};
const noop = () => { };
const record = (method, level) => (...args) => {
    var _a;
    ((_a = originalConsole[method]) !== null && _a !== void 0 ? _a : noop)(...args);
    // util.format handles printf-style placeholders and object inspection,
    // matching what the original call put on stdout.
    if (level === 'error')
        persistErrorEntry(new Date().toISOString(), normalize((0, util_1.format)(...args)));
};
const attachConsoleCapture = () => {
    if (captureAttached)
        return;
    captureAttached = true;
    for (const method of ['log', 'info', 'warn', 'error']) {
        originalConsole[method] = console[method];
        // log and info both map to 'info'
        const level = method === 'log' || method === 'info' ? 'info' : method;
        console[method] = record(method, level);
    }
};
exports.attachConsoleCapture = attachConsoleCapture;
const detachConsoleCapture = () => {
    if (!captureAttached)
        return;
    captureAttached = false;
    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = originalConsole[level];
        if (original)
            console[level] = original;
        delete originalConsole[level];
    }
};
exports.detachConsoleCapture = detachConsoleCapture;
