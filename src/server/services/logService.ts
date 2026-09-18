// Issue #76: in-memory structured log ring buffer. The admin logs view
// reads from this buffer; console.* call sites keep working because
// attachConsoleCapture() mirrors every console invocation into the buffer
// while preserving original stdout behaviour.

import { format } from 'util';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  msg: string;
}

const CAP = 1000;
const MAX_MSG_LENGTH = 2000;

const buffer: LogEntry[] = [];
// ids start at 1 so a default cursor of 0 in getLogs means "everything"
let nextId = 1;
let captureAttached = false;

const originalConsole: Partial<
  Record<'log' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>
> = {};

const normalize = (msg: string) => msg.replace(/\s*\n\s*/g, ' ').slice(0, MAX_MSG_LENGTH);

export const pushLog = (level: LogLevel, msg: string) => {
  const entry: LogEntry = {
    id: nextId++,
    ts: new Date().toISOString(),
    level,
    msg: normalize(msg),
  };
  buffer.push(entry);
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
  return entry;
};

export const logger = {
  info: (msg: string) => {
    pushLog('info', msg);
  },
  warn: (msg: string) => {
    pushLog('warn', msg);
  },
  error: (msg: string) => {
    pushLog('error', msg);
  },
};

export interface GetLogsParams {
  level?: LogLevel;
  q?: string;
  cursor?: number;
  limit?: number;
}

export const getLogs = (params: GetLogsParams = {}): { logs: LogEntry[]; nextCursor: number } => {
  const { level, q, cursor = 0, limit = 200 } = params;
  const needle = q?.toLowerCase();
  const matches = buffer.filter(
    (entry) =>
      entry.id > cursor &&
      (!level || entry.level === level) &&
      (!needle || entry.msg.toLowerCase().includes(needle)),
  );
  const logs = matches.slice(0, limit);
  return { logs, nextCursor: logs.length > 0 ? logs[logs.length - 1].id : cursor };
};

export const clearLogs = () => {
  buffer.length = 0;
  nextId = 1;
};

const noop = () => {};

const record =
  (method: 'log' | 'info' | 'warn' | 'error', level: LogLevel) =>
  (...args: unknown[]) => {
    (originalConsole[method] ?? noop)(...args);
    // util.format handles printf-style placeholders and object inspection,
    // matching what the original call put on stdout
    pushLog(level, format(...args));
  };

export const attachConsoleCapture = () => {
  if (captureAttached) return;
  captureAttached = true;
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    originalConsole[method] = console[method];
    // log and info both land in the buffer as 'info'
    const bufferLevel: LogLevel = method === 'log' || method === 'info' ? 'info' : method;
    console[method] = record(method, bufferLevel);
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
