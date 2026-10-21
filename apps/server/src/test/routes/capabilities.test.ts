import request from 'supertest';
import { createApp } from '../../main/index';
import { User } from '../../main/models/User';

const mockToolsets = jest.fn();

jest.mock('../../main/services/connectors/connectorService', () => ({
  connectorToolsetsForUser: (...args: unknown[]) => mockToolsets(...args),
}));

const registerUser = async (email: string): Promise<string[]> => {
  const app = createApp();
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123' });
  const cookies = response.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies];
};

describe('GET /api/capabilities (#366)', () => {
  beforeEach(() => {
    mockToolsets.mockReset().mockResolvedValue({});
  });

  it('requires authentication', async () => {
    const app = createApp();
    const response = await request(app).get('/api/capabilities');
    expect(response.status).toBe(401);
  });

  it('lists built-in tools as ready, including web_search when its key is set', async () => {
    const original = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
    try {
      const cookies = await registerUser('capabilities-ready@example.com');
      const app = createApp();
      const response = await request(app).get('/api/capabilities').set('Cookie', cookies);
      expect(response.status).toBe(200);
      const webSearch = response.body.tools.find((t: { name: string }) => t.name === 'web_search');
      expect(webSearch).toMatchObject({ name: 'web_search', status: 'ready' });
      expect(response.body.tools.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining([
          'fetch_url',
          'list_files',
          'read_file',
          'generate_file',
          'edit_file',
          'delegate_task',
        ]),
      );
    } finally {
      if (original === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
      else process.env.BRAVE_SEARCH_API_KEY = original;
    }
  });

  it('reports web_search unconfigured rather than absent when the deployment has no search key', async () => {
    const original = process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    try {
      const cookies = await registerUser('capabilities-nosearch@example.com');
      const app = createApp();
      const response = await request(app).get('/api/capabilities').set('Cookie', cookies);
      const webSearch = response.body.tools.find((t: { name: string }) => t.name === 'web_search');
      expect(webSearch).toMatchObject({ name: 'web_search', status: 'unconfigured' });
    } finally {
      if (original !== undefined) process.env.BRAVE_SEARCH_API_KEY = original;
    }
  });

  it('lists live connector toolsets as deferred groups scoped to the caller', async () => {
    mockToolsets.mockResolvedValueOnce({
      github: {
        github_create_issue: { description: 'Create an issue' },
        github_list_prs: { description: 'List pull requests' },
      },
    });
    const cookies = await registerUser('capabilities-connectors@example.com');
    const app = createApp();
    const response = await request(app).get('/api/capabilities').set('Cookie', cookies);
    expect(response.body.connectors).toEqual([
      {
        name: 'github',
        tools: [
          { name: 'github_create_issue', description: 'Create an issue' },
          { name: 'github_list_prs', description: 'List pull requests' },
        ],
      },
    ]);
    const call = mockToolsets.mock.calls[0][0];
    const user = await User.findOne({ email: 'capabilities-connectors@example.com' });
    expect(String(call)).toBe(String(user?._id));
  });

  it('degrades a connector resolution failure to a 500 rather than a wrong capability list', async () => {
    const cookies = await registerUser('capabilities-error@example.com');
    mockToolsets.mockRejectedValueOnce(new Error('mongo down'));
    const app = createApp();
    const response = await request(app).get('/api/capabilities').set('Cookie', cookies);
    expect(response.status).toBe(500);
  });
});
