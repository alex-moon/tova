import { attachConsoleCapture, detachConsoleCapture, logger } from '../../main/services/logService';
import { ErrorLog } from '../../main/models/ErrorLog';

jest.mock('../../main/models/ErrorLog', () => ({
  ErrorLog: { create: jest.fn().mockReturnValue(Promise.resolve({})) },
}));

// Console capture + durable errors only; retained viewing in lokiLogs.ts.
// @see #179
describe('logService', () => {
  beforeEach(() => {
    (ErrorLog.create as jest.Mock).mockClear();
    detachConsoleCapture();
  });

  afterEach(() => {
    detachConsoleCapture();
  });

  it('captures console output and restores originals on detach', () => {
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };
    attachConsoleCapture();

    expect(() => {
      console.log('hello %d', 42);
      console.info('info line');
      console.warn('careful');
      console.error('boom');
    }).not.toThrow();

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
  });

  it('persists only error-level console output to MongoDB outside test env', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    attachConsoleCapture();
    try {
      console.error('boom persisted');
      console.info('not persisted');
      logger.error('logger boom');
    } finally {
      process.env.NODE_ENV = prev;
      detachConsoleCapture();
    }
    // console.error and logger.error each persist once; console.info does not.
    expect(ErrorLog.create).toHaveBeenCalledTimes(2);
    const args = (ErrorLog.create as jest.Mock).mock.calls.map((c) => c[0]);
    expect(args.every((a) => typeof a.msg === 'string' && a.ts !== undefined)).toBe(true);
    expect(args.map((a) => a.msg)).toEqual(
      expect.arrayContaining(['boom persisted', 'logger boom']),
    );
  });

  it('does not persist under NODE_ENV=test', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    attachConsoleCapture();
    try {
      console.error('should not persist');
    } finally {
      process.env.NODE_ENV = prev;
      detachConsoleCapture();
    }
    expect(ErrorLog.create).not.toHaveBeenCalled();
  });
});
