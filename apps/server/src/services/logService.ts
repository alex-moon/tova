// #179: the in-memory ring buffer was removed — retained logs now come from
// Grafana Cloud (see services/lokiLogs.ts). What remains is the logging
// backbone: console.* capture (so output stays structured) and durable
// error-log persistence to MongoDB (issue #175), neither of which depends on
// a buffer.

import { format } from 'util';
import { ErrorLog } from '../models/ErrorLog';

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_MSG_LENGTH = 2000;

// Issue #175: mirror error entries into MongoDB as they are emitted so
// diagnostics survive a restart. Fire-and-forget: failures are swallowed
// (never re-logged through console, which would recurse into the capture).
const persistErrorEntry = (ts: string, msg: string) => {
  if (process.env.NODE_ENV === 'test') return;
  ErrorLog.create({ bufferId: null, ts, msg }).catch(() => {});
};

let captureAttached = false;

const originalConsole: Partial<
  Record<'log' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>
> = {};

const normalize = (msg: string) => msg.replace(/\s*\n\s*/g, ' ').slice(0, MAX_MSG_LENGTH);

export const logger = {
  info: (msg: string) => {
    console.info(msg);
  },
  warn: (msg: string) => {
    console.warn(msg);
  },
  error: (msg: string) => {
    console.error(msg);
  },
};

const noop = () => {};

const record =
  (method: 'log' | 'info' | 'warn' | 'error', level: LogLevel) =>
  (...args: unknown[]) => {
    (originalConsole[method] ?? noop)(...args);
    // util.format handles printf-style placeholders and object inspection,
    // matching what the original call put on stdout.
    if (level === 'error') persistErrorEntry(new Date().toISOString(), normalize(format(...args)));
  };

export const attachConsoleCapture = () => {
  if (captureAttached) return;
  captureAttached = true;
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    originalConsole[method] = console[method];
    // log and info both map to 'info'
    const level: LogLevel = method === 'log' || method === 'info' ? 'info' : method;
    console[method] = record(method, level);
  }
};

export const detachConsoleCapture = () => {
  if (!captureAttached) return;
  captureAttached = false;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = originalConsole[level];
    if (original) console[level] = original as (typeof console)[typeof level];
    delete originalConsole[level];
  }
};
