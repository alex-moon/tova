import request from 'supertest';
import express from 'express';
import { requestLog } from './requestLog';
import { clearLogs, getLogs } from '../services/logService';

describe('requestLog middleware', () => {
  beforeEach(() => {
    clearLogs();
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
    const { logs } = getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(logs[0].msg).toMatch(/^GET \/ping -> 200 \(\d+ms\)$/);
  });

  it('records non-GET methods and error statuses', async () => {
    const app = buildApp();
    await request(app).post('/ping');
    await request(app).get('/boom');
    const { logs } = getLogs();
    expect(logs[0].msg).toMatch(/^POST \/ping -> 404/);
    expect(logs[1].msg).toMatch(/^GET \/boom -> 500/);
    expect(logs[0].level).toBe('warn');
    expect(logs[1].level).toBe('error');
  });

  it('does not record GET /api/admin/logs so polling cannot spam the buffer', async () => {
    const app = express();
    app.use(requestLog, (_req, res) => {
      res.json({});
    });
    await request(app).get('/api/admin/logs');
    await request(app).get('/api/admin/logs?q=boom');
    expect(getLogs().logs).toHaveLength(0);
  });
});
