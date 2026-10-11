import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../index';
import { Task } from '../models/Task';
import { TaskEvent } from '../models/TaskEvent';
import { User } from '../models/User';

// #254 routes slice (epic #251). The task API is exercised end-to-end through
// `createApp` against the shared in-memory Mongo (test/setup.ts empties
// collections between tests). The poller is gated off in tests, so a created
// task stays `queued` and these tests observe the API's own effects.

const app = createApp();

const registerUser = async (email: string): Promise<string> => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  const cookie = response.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : cookie;
};

const createTask = (cookie: string, body: Record<string, unknown> = { instruction: 'do work' }) =>
  request(app).post('/api/tasks').set('Cookie', [cookie]).send(body);

const listTasks = (cookie: string) => request(app).get('/api/tasks').set('Cookie', [cookie]);

const getTask = (cookie: string, id: string) =>
  request(app).get(`/api/tasks/${id}`).set('Cookie', [cookie]);

const instruct = (cookie: string, id: string, instruction: string) =>
  request(app).post(`/api/tasks/${id}/instruction`).set('Cookie', [cookie]).send({ instruction });

const cancel = (cookie: string, id: string) =>
  request(app).post(`/api/tasks/${id}/cancel`).set('Cookie', [cookie]).send({});

const OWNER = 'tasks-owner@example.com';
const OTHER = 'tasks-other@example.com';

describe('POST /api/tasks (#254 routes)', () => {
  it('creates a queued task with a snapshotted budget and the instruction as its first event', async () => {
    const cookie = await registerUser(OWNER);

    const res = await createTask(cookie, { instruction: 'Summarise the workspace' });

    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({
      status: 'queued',
      instruction: 'Summarise the workspace',
      stepCount: 0,
      budget: { maxSteps: 25, maxCostUsd: 5, spentUsd: 0 },
    });

    const events = await TaskEvent.find({}).sort({ seq: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ role: 'user', content: 'Summarise the workspace', seq: 0 });
  });

  it('creates a direct-origin task with no instruction (first-class, D3)', async () => {
    const cookie = await registerUser(OWNER);
    const res = await createTask(cookie, { origin: { kind: 'direct' } });
    expect(res.status).toBe(201);
    expect(res.body.task.origin).toEqual({ kind: 'direct' });
    expect(res.body.task.instruction).toBe('');
  });

  it('rejects a malformed body with 400', async () => {
    const cookie = await registerUser(OWNER);
    const res = await createTask(cookie, { instruction: 'x', origin: { kind: 'galaxy' } });
    expect(res.status).toBe(400);
  });

  it('refuses to create a task for a ZDR account (D7)', async () => {
    const cookie = await registerUser('tasks-zdr@example.com');
    await User.updateOne({ email: 'tasks-zdr@example.com' }, { $set: { settings: { zdr: true } } });

    const res = await createTask(cookie, { instruction: 'secret work' });

    expect(res.status).toBe(403);
    expect(await Task.countDocuments({})).toBe(0);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/tasks').send({ instruction: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/tasks (#254 routes)', () => {
  it("lists only the caller's own tasks, newest first", async () => {
    const owner = await registerUser(OWNER);
    const other = await registerUser(OTHER);
    await createTask(owner, { instruction: 'owner first' });
    await createTask(owner, { instruction: 'owner second' });
    await createTask(other, { instruction: 'other task' });

    const res = await listTasks(owner);

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
    expect(res.body.tasks[0].instruction).toBe('owner second');
    expect(res.body.nextCursor).toBeNull();
  });
});

describe('GET /api/tasks/:id (#254 routes)', () => {
  it('returns the task with its ordered stream', async () => {
    const cookie = await registerUser(OWNER);
    const created = await createTask(cookie, { instruction: 'first' });
    const id = created.body.task.id as string;

    const res = await getTask(cookie, id);

    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(id);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ seq: 0, role: 'user', content: 'first' });
  });

  it('404s a task owned by another user (no oracle)', async () => {
    const owner = await registerUser(OWNER);
    const other = await registerUser(OTHER);
    const created = await createTask(owner, { instruction: 'private' });
    const id = created.body.task.id as string;

    const res = await getTask(other, id);
    expect(res.status).toBe(404);
  });

  it('404s an unknown id', async () => {
    const cookie = await registerUser(OWNER);
    const res = await getTask(cookie, new Types.ObjectId().toString());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/:id/instruction (#254 routes)', () => {
  it('appends a steering user event on a queued task', async () => {
    const cookie = await registerUser(OWNER);
    const created = await createTask(cookie, { instruction: 'start' });
    const id = created.body.task.id as string;

    const res = await instruct(cookie, id, 'steer left');

    expect(res.status).toBe(200);
    const events = await TaskEvent.find({ taskId: id }).sort({ seq: 1 });
    expect(events.map((e) => [e.seq, e.role, e.content])).toEqual([
      [0, 'user', 'start'],
      [1, 'user', 'steer left'],
    ]);
  });

  it('resumes a paused task by re-queuing it (D6: resume-as-steering)', async () => {
    const cookie = await registerUser(OWNER);
    const created = await createTask(cookie, { instruction: 'start' });
    const id = created.body.task.id as string;
    await Task.updateOne({ _id: id }, { $set: { status: 'paused' } });

    const res = await instruct(cookie, id, 'continue');

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('queued');
  });

  it('refuses to steer a terminal task with 409 (D14)', async () => {
    const cookie = await registerUser(OWNER);
    const created = await createTask(cookie, { instruction: 'start' });
    const id = created.body.task.id as string;
    await Task.updateOne({ _id: id }, { $set: { status: 'done' } });

    const res = await instruct(cookie, id, 'too late');

    expect(res.status).toBe(409);
    const events = await TaskEvent.find({ taskId: id });
    expect(events).toHaveLength(1);
  });

  it('404s a foreign task', async () => {
    const owner = await registerUser(OWNER);
    const other = await registerUser(OTHER);
    const created = await createTask(owner, { instruction: 'private' });
    const id = created.body.task.id as string;

    const res = await instruct(other, id, 'hijack');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/:id/cancel (#254 routes)', () => {
  it('cancels an active task', async () => {
    const cookie = await registerUser(OWNER);
    const created = await createTask(cookie, { instruction: 'start' });
    const id = created.body.task.id as string;

    const res = await cancel(cookie, id);

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('cancelled');
    expect((await Task.findById(id))?.status).toBe('cancelled');
  });

  it('leaves a terminal task untouched (idempotent)', async () => {
    const cookie = await registerUser(OWNER);
    const created = await createTask(cookie, { instruction: 'start' });
    const id = created.body.task.id as string;
    await Task.updateOne({ _id: id }, { $set: { status: 'done' } });

    const res = await cancel(cookie, id);

    expect(res.status).toBe(200);
    expect((await Task.findById(id))?.status).toBe('done');
  });

  it('404s a foreign task', async () => {
    const owner = await registerUser(OWNER);
    const other = await registerUser(OTHER);
    const created = await createTask(owner, { instruction: 'private' });
    const id = created.body.task.id as string;

    const res = await cancel(other, id);
    expect(res.status).toBe(404);
  });
});
