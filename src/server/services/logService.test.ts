import {
  getLogs,
  clearLogs,
  attachConsoleCapture,
  detachConsoleCapture,
  pushLog,
} from './logService';
import { ErrorLog } from '../models/ErrorLog';

jest.mock('../models/ErrorLog', () => ({
  ErrorLog: { create: jest.fn().mockReturnValue(Promise.resolve({})) },
}));

describe('logService', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('stores entries with monotonically increasing ids and ISO timestamps', () => {
    const first = pushLog('info', 'one');
    const second = pushLog('error', 'two');
    expect(second.id).toBeGreaterThan(first.id);
    expect(() => new Date(first.ts).toISOString()).not.toThrow();
    expect(first.msg).toBe('one');
    expect(second.level).toBe('error');
  });

  it('evicts oldest entries beyond the 1000 cap', () => {
    for (let i = 0; i < 1005; i++) pushLog('info', `m${i}`);
    const { logs } = getLogs({ limit: 1000 });
    expect(logs).toHaveLength(1000);
    // first five (m0..m4) were evicted; also verifies ring-buffer trimming
    expect(logs.some((l) => l.msg === 'm4')).toBe(false);
    expect(logs[0].msg).toBe('m5');
    expect(logs[999].msg).toBe('m1004');
  });

  it('normalizes multi-line messages and truncates very long ones', () => {
    const multiline = pushLog('info', 'line one\nline two\n line three');
    expect(multiline.msg).toBe('line one line two line three');

    const long = pushLog('info', `x${'x'.repeat(2000)}`);
    expect(long.msg.length).toBe(2000);
  });

  it('filters by level, substring and cursor, returning nextCursor', () => {
    pushLog('info', 'alpha start');
    const warn = pushLog('warn', 'omega warning');
    pushLog('error', 'alpha boom');

    expect(getLogs().logs).toHaveLength(3);
    expect(getLogs({ level: 'warn' }).logs.map((l) => l.msg)).toEqual(['omega warning']);

    const q = getLogs({ q: 'ALPHA' });
    expect(q.logs.map((l) => l.msg)).toEqual(['alpha start', 'alpha boom']);

    expect(getLogs({ cursor: warn.id }).logs.map((l) => l.msg)).toEqual(['alpha boom']);
    expect(getLogs({ limit: 2 }).nextCursor).toBe(warn.id);

    // empty result keeps the caller's cursor so polling stays idempotent
    expect(getLogs({ cursor: 3 }).nextCursor).toBe(3);
  });

  it('captures console output and restores originals on detach', () => {
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };
    attachConsoleCapture();

    console.log('hello %d', 42);
    console.info('info line');
    console.warn('careful');
    console.error('boom');

    const { logs } = getLogs();
    expect(logs.map((l) => l.level)).toEqual(['info', 'info', 'warn', 'error']);
    expect(logs[0].msg).toBe('hello 42');
    expect(logs[1].msg).toBe('info line');
    expect(logs[3].msg).toBe('boom');

    detachConsoleCapture();
    expect(console.log).toBe(original.log);
    expect(console.info).toBe(original.info);
    expect(console.warn).toBe(original.warn);
    expect(console.error).toBe(original.error);

    // double attach is a no-op; detach without attach is a no-op
    expect(() => {
      attachConsoleCapture();
      detachConsoleCapture();
      detachConsoleCapture();
    }).not.toThrow();
    clearLogs();
  });

  it('persists error entries to MongoDB outside test env', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      pushLog('error', 'boom persisted');
      pushLog('info', 'not persisted');
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(ErrorLog.create).toHaveBeenCalledTimes(1);
    const arg = (ErrorLog.create as jest.Mock).mock.calls[0][0];
    expect(arg.msg).toBe('boom persisted');
    expect(arg.ts).toBeDefined();
    clearLogs();
  });
});
