import { installProcessSafetyNet, isTesseractWorkerError } from '../main/index';

/* Pins the safety net's classification and listener wiring: contain tesseract worker errors (thrown from inside Worker message dispatch), exit otherwise. */
// @see #248 #358

const tesseractShapedError = (): Error =>
  Object.assign(new Error("Error: ENOENT: no such file or directory, open '/x/y.gz'"), {
    stack:
      "Error: ENOENT: no such file or directory, open '/x/y.gz'\n" +
      '    at Worker.<anonymous> (/app/node_modules/tesseract.js/src/createWorker.js:217:15)\n' +
      '    at Worker.emit (node:events:519:28)',
  });

describe('isTesseractWorkerError', () => {
  it('matches errors whose stack originates in tesseract.js', () => {
    expect(isTesseractWorkerError(tesseractShapedError())).toBe(true);
  });

  it('matches the tesseract.js-core wasm glue too (package-name prefix)', () => {
    const err = Object.assign(new Error('abort'), {
      stack:
        'abort\n    at wasm (/app/node_modules/tesseract.js-core/tesseract-core-simd.wasm.js:9:10)',
    });
    expect(isTesseractWorkerError(err)).toBe(true);
  });

  it('does not match ordinary errors or non-error values', () => {
    expect(isTesseractWorkerError(new Error('boom'))).toBe(false);
    expect(isTesseractWorkerError(new TypeError('nope'))).toBe(false);
    expect(isTesseractWorkerError(undefined)).toBe(false);
    expect(isTesseractWorkerError('tesseract.js mentioned in a string')).toBe(false);
  });
});

describe('installProcessSafetyNet', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const lastListener = (
    event: 'uncaughtException' | 'unhandledRejection',
  ): ((err: unknown) => void) => {
    const listeners = process.listeners(event);
    return listeners.at(-1) as unknown as (err: unknown) => void;
  };

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    installProcessSafetyNet();
  });

  afterEach(() => {
    // Remove exactly the listeners this test installed (last-registered).
    process.removeListener('uncaughtException', lastListener('uncaughtException'));
    process.removeListener('unhandledRejection', lastListener('unhandledRejection'));
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('contains tesseract-originated uncaught exceptions without exiting', () => {
    const listener = lastListener('uncaughtException');
    listener(tesseractShapedError());
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Contained tesseract worker error:', expect.anything());
  });

  it('still exits on uncaught exceptions from anywhere else (#248)', () => {
    const listener = lastListener('uncaughtException');
    listener(new Error('ordinary uncaught failure'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs unhandled rejections without exiting (#248)', () => {
    const listener = lastListener('unhandledRejection');
    listener(new Error('a stalled fetch rejection'));
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('Unhandled promise rejection:', expect.anything());
  });
});
