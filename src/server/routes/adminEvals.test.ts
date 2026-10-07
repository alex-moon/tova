import request from 'supertest';
import { createApp } from '../index';
import { User } from '../models/User';
import { EvalRunRecord } from '../models/EvalRunRecord';
import {
  beginEvalRun,
  EvalRunBusyError,
  executeEvalRun,
  resolveScheduledModels,
} from '../services/evalRunService';

/*
 * #225 route coverage: admin-guard wiring, list ordering + limit clamp, the
 * detail 404 for a missing/garbage id, and the manual-run 202/409/5xx paths
 * (the service is mocked so no suite executes).
 */
jest.mock('../services/evalRunService', () => {
  const actual = jest.requireActual('../services/evalRunService');
  return {
    ...actual,
    beginEvalRun: jest.fn(),
    executeEvalRun: jest.fn(),
    resolveScheduledModels: jest.fn(),
  };
});

const mockedBegin = beginEvalRun as jest.MockedFunction<typeof beginEvalRun>;
const mockedExecute = executeEvalRun as jest.MockedFunction<typeof executeEvalRun>;
const mockedModels = resolveScheduledModels as jest.MockedFunction<typeof resolveScheduledModels>;

const cookieOf = (res: request.Response) => {
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie : [cookie];
};

const registerAdmin = async (app: ReturnType<typeof createApp>, email: string) => {
  await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  await User.updateOne({ email }, { role: 'admin' });
  const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
  return cookieOf(res);
};

const registerUser = async (app: ReturnType<typeof createApp>, email: string) => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  return cookieOf(res);
};

const seedRun = (startedAt: Date, over: Record<string, unknown> = {}) =>
  EvalRunRecord.create({
    startedAt,
    status: 'done',
    finishedAt: new Date(),
    models: ['deepinfra:openai/gpt-oss-20b'],
    results: [
      { caseId: 'a', model: 'm', provider: 'deepinfra', score: 'pass', report: 'ok' },
      { caseId: 'b', model: 'm', provider: 'deepinfra', score: 'fail', report: 'no' },
    ],
    ...over,
  });

beforeEach(() => {
  mockedBegin.mockReset();
  mockedExecute.mockReset();
  mockedModels.mockReset();
  mockedModels.mockReturnValue([{ provider: 'deepinfra', model: 'openai/gpt-oss-20b' }]);
  mockedExecute.mockResolvedValue([]);
});

describe('admin evals (#225)', () => {
  it('guards the endpoints like the rest of admin', async () => {
    const app = createApp();
    const cookie = await registerUser(app, 'plain-evals@example.com');

    const unauth = await request(app).get('/api/admin/evals/runs');
    expect(unauth.status).toBe(401);

    const forbidden = await request(app).get('/api/admin/evals/runs').set('Cookie', cookie);
    expect(forbidden.status).toBe(403);

    const badBearer = await request(app)
      .get('/api/admin/evals/runs')
      .set('Authorization', 'Bearer nope');
    expect(badBearer.status).toBe(401);
  });

  it('lists runs newest first with counts, clamping the limit', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'evals-lister@example.com');
    await seedRun(new Date('2026-10-01T00:00:00Z'));
    await seedRun(new Date('2026-10-03T00:00:00Z'));

    const res = await request(app).get('/api/admin/evals/runs?limit=9999').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0].startedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(res.body.runs[0].counts).toEqual({ pass: 1, partial: 0, fail: 1, error: 0 });
    expect(res.body.runs[0].total).toBe(2);
  });

  it('returns one run with its per-case breakdown', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'evals-detail@example.com');
    const doc = await seedRun(new Date('2026-10-02T00:00:00Z'));

    const res = await request(app)
      .get(`/api/admin/evals/runs/${doc._id.toString()}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(doc._id.toString());
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].caseId).toBe('a');
  });

  it('400s a garbage id and 404s a missing one', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'evals-404@example.com');

    const garbage = await request(app).get('/api/admin/evals/runs/not-an-id').set('Cookie', cookie);
    expect(garbage.status).toBe(400);

    const missing = await request(app)
      .get('/api/admin/evals/runs/64b7f9f2a1c3d4e5f6a7b8c9')
      .set('Cookie', cookie);
    expect(missing.status).toBe(404);
  });

  it('starts a manual run (202 + id) without awaiting the suite', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'evals-run@example.com');
    mockedBegin.mockResolvedValue('64b7f9f2a1c3d4e5f6a7b8c9');

    const res = await request(app).post('/api/admin/evals/run').set('Cookie', cookie);
    expect(res.status).toBe(202);
    expect(res.body.id).toBe('64b7f9f2a1c3d4e5f6a7b8c9');
    expect(mockedBegin).toHaveBeenCalledTimes(1);
    expect(mockedExecute).toHaveBeenCalledWith('64b7f9f2a1c3d4e5f6a7b8c9', expect.anything());
  });

  it('409s a manual run while one is already live', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'evals-busy@example.com');
    mockedBegin.mockRejectedValue(new EvalRunBusyError());

    const res = await request(app).post('/api/admin/evals/run').set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(mockedExecute).not.toHaveBeenCalled();
  });

  it('500s when the lease cannot be written', async () => {
    const app = createApp();
    const cookie = await registerAdmin(app, 'evals-500@example.com');
    mockedBegin.mockRejectedValue(new Error('mongo down'));

    const res = await request(app).post('/api/admin/evals/run').set('Cookie', cookie);
    expect(res.status).toBe(500);
  });
});
