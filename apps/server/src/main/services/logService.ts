/* Logging backbone: console capture + durable error persistence. */
// @see #179 #175

import { format } from 'util';
import { ErrorLog } from '../models/ErrorLog';
import { redactString } from './logRedaction';

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_MSG_LENGTH = 2000;

// Mirror error entries into MongoDB as emitted, fire-and-forget.
// @see #175
const persistErrorEntry = (ts: string, msg: string) => {
  if (process.env.NODE_ENV === 'test') return;
  // The capture choke point is the one cheap place to redact before persistence.
  // @see #397
  ErrorLog.create({ bufferId: null, ts, msg: redactString(msg) }).catch(() => {});
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
    // util.format handles placeholders and inspection like the original call.
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
