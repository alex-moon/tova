import request from 'supertest';
import express from 'express';
import { requestLog } from '../../main/middleware/requestLog';
import { attachConsoleCapture, detachConsoleCapture } from '../../main/services/logService';

// Observed via its console line; retained viewing in lokiLogs.test.ts.
// @see #179
describe('requestLog middleware', () => {
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    attachConsoleCapture();
    info = jest.spyOn(console, 'info').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    detachConsoleCapture();
    jest.restoreAllMocks();
  });

  const buildApp = () => {
    const app = express();
    app.use(requestLog);
    app.get('/ping', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/boom', (_req, res) => {
      res.status(500).json({});
    });
    return app;
  };

  it('records one info line per request with method, path and status', async () => {
    await request(buildApp()).get('/ping');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatch(/^GET \/ping -> 200 \(\d+ms\)$/);
  });

  it('records non-GET methods and error statuses at the right level', async () => {
    const app = buildApp();
    await request(app).post('/ping');
    await request(app).get('/boom');
    expect(warn.mock.calls[0][0]).toMatch(/^POST \/ping -> 404/);
    expect(error.mock.calls[0][0]).toMatch(/^GET \/boom -> 500/);
  });

  it('does not record GET /api/admin/logs so polling cannot spam the logs', async () => {
    const app = express();
    app.use(requestLog, (_req, res) => {
      res.json({});
    });
    await request(app).get('/api/admin/logs');
    await request(app).get('/api/admin/logs?q=boom');
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
