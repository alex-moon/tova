import { RequestContext } from '@mastra/core/request-context';
import { Asset } from '../models/Asset';
import { User } from '../models/User';
import { generateFileTool, listFilesTool, readFileTool } from './mastraService';
import { truncateForPrompt } from './textExtraction';

jest.mock('./storageService', () => ({
  isStorageConfigured: jest.fn(),
  putObject: jest.fn(),
  // list_files/read_file never touch storageService; keep the mock surface
  // complete so unrelated import-time references resolve.
  presignPutUrl: jest.fn(),
  presignGetUrl: jest.fn(),
}));

const storageMocks = jest.requireMock('./storageService') as {
  isStorageConfigured: jest.Mock;
  putObject: jest.Mock;
};

/*
 * Tool-level tests for the #58 asset-library tools. The jest module mappers
 * replace `@mastra/core/tools`' createTool with the identity function, so
 * `execute` is invoked directly with a constructed request context — the
 * runtime contract (context rides in as the second execute argument) is
 * pinned by mastraRequestContext.test.ts.
 */

const asCtx = (userId?: string) => {
  const requestContext = new RequestContext();
  if (userId) requestContext.set('userId', userId);
  return { requestContext };
};

// `createTool` is the identity stub, so the tools keep their plain config
// shape; pick the execute off it explicitly for direct invocation.
const listExecute = (
  listFilesTool as unknown as { execute: (args: unknown[], ctx: unknown) => Promise<unknown> }
).execute;
const readExecute = (
  readFileTool as unknown as {
    execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
  }
).execute;
const generateExecute = (
  generateFileTool as unknown as {
    execute: (
      args: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ file?: unknown; error?: string }>;
  }
).execute;

const createAsset = (
  userId: string,
  filename: string,
  extra: {
    status?: string;
    textExtracted?: string | null;
    markdownExtracted?: string | null;
  } = {},
) =>
  Asset.create({
    userId,
    filename,
    key: `${userId}/asset-${Math.random().toString(36).slice(2)}/${filename}`,
    contentType: 'text/plain',
    size: 123,
    ...(extra.status ? { status: extra.status } : { status: 'ready' }),
    ...(extra.textExtracted !== undefined ? { textExtracted: extra.textExtracted } : {}),
    ...(extra.markdownExtracted !== undefined
      ? { markdownExtracted: extra.markdownExtracted }
      : {}),
  });

const createUser = async (email: string) => User.create({ email, passwordHash: 'password123' });

describe('generate_file tool (#66)', () => {
  const good = { filename: 'notes.md', content: '# meeting notes' };

  beforeEach(() => {
    storageMocks.isStorageConfigured.mockReset().mockReturnValue(true);
    storageMocks.putObject.mockReset().mockResolvedValue(undefined);
  });

  it('requires a userId in the request context', async () => {
    expect(await generateExecute(good, asCtx())).toEqual({ error: 'unavailable' });
  });

  it('degrades to unavailable when storage is unconfigured', async () => {
    storageMocks.isStorageConfigured.mockReturnValue(false);
    const user = await createUser('generate-unconfigured@example.com');
    expect(await generateExecute(good, asCtx(user.id))).toEqual({ error: 'unavailable' });
    expect(await Asset.countDocuments()).toBe(0);
  });

  it('saves a ready system-generated markdown asset the model can read back', async () => {
    const user = await createUser('generate-happy@example.com');
    const out = (await generateExecute(good, asCtx(user.id))) as {
      file?: { id: string; filename: string; contentType: string; size: number };
      error?: string;
    };
    expect(out.error).toBeUndefined();
    expect(out.file).toMatchObject({
      filename: 'notes.md',
      contentType: 'text/markdown',
      size: '# meeting notes'.length,
    });
    expect(storageMocks.putObject).toHaveBeenCalledWith(
      `${user.id}/${out.file?.id}/notes.md`,
      Buffer.from(good.content, 'utf8'),
      'text/markdown',
    );
    const stored = await Asset.findById(out.file?.id);
    expect(stored).toMatchObject({
      status: 'ready',
      origin: 'system-generated',
      textExtracted: good.content,
    });
    // Round-trip: the just-generated file is immediately listable and
    // readable by the same tools (#66 plan risk note).
    const listed = (await listExecute([], asCtx(user.id))) as { files: { id: string }[] };
    expect(listed.files.map((f) => f.id)).toContain(out.file?.id);
    const read = (await readExecute({ id: out.file?.id }, asCtx(user.id))) as {
      content?: string;
      hasText?: boolean;
    };
    expect(read.content).toBe(good.content);
    expect(read.hasText).toBe(true);
  });

  it('maps validation failures to typed errors without storage calls', async () => {
    const user = await createUser('generate-invalid@example.com');
    expect((await generateExecute({ ...good, filename: '  ' }, asCtx(user.id))).error).toBe(
      'invalid',
    );
    const limit = 15 * 1024 * 1024 + 1;
    expect(
      (await generateExecute({ ...good, content: 'x'.repeat(limit) }, asCtx(user.id))).error,
    ).toBe('too_large');
    expect(storageMocks.putObject).not.toHaveBeenCalled();
    expect(await Asset.countDocuments()).toBe(0);
  });

  it('maps storage failures to unavailable', async () => {
    const user = await createUser('generate-fail@example.com');
    storageMocks.putObject.mockRejectedValue(new Error('Spaces down'));
    const out = await generateExecute(good, asCtx(user.id));
    expect(out.error).toBe('unavailable');
    // The failed doc must be visible/failed, ready for the failed list.
    const stored = await Asset.findOne({ userId: user.id });
    expect(stored).toMatchObject({ status: 'failed', failureReason: 'storage-error' });
  });
});

describe('list_files tool (#58)', () => {
  it('requires a userId in the request context', async () => {
    expect(await listExecute([], asCtx())).toEqual({ files: [], error: 'unavailable' });
  });

  it('returns an empty list for an empty library', async () => {
    const user = await createUser('list-empty@example.com');
    expect(await listExecute([], asCtx(user.id))).toEqual({ files: [] });
  });

  it('lists ready assets with metadata newest first', async () => {
    const user = await createUser('list-files@example.com');
    const first = await createAsset(user.id, 'a.txt', { textExtracted: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    const second = await createAsset(user.id, 'b.md', { textExtracted: 'b' });
    const out = (await listExecute([], asCtx(user.id))) as {
      files: {
        id: string;
        filename: string;
        contentType: string;
        size: number;
        createdAt: string;
      }[];
      more?: boolean;
    };
    expect(out.files.map((f) => f.id)).toEqual([second.id, first.id]);
    expect(out.files[1]).toMatchObject({
      id: first.id,
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 123,
      createdAt: expect.any(String),
    });
    expect(new Date(out.files[1].createdAt).toISOString()).toBe(out.files[1].createdAt);
    expect(out.more).toBeUndefined();
  });

  it('excludes other users and non-ready assets', async () => {
    const user = await createUser('list-owner@example.com');
    const other = await createUser('list-other@example.com');
    await createAsset(other.id, 'secret.txt', { textExtracted: 's' });
    await createAsset(user.id, 'pending.txt', { status: 'pending' });
    await createAsset(user.id, 'failed.txt', { status: 'failed', textExtracted: null });
    const visible = await createAsset(user.id, 'ok.txt', { textExtracted: 'ok' });
    const out = (await listExecute([], asCtx(user.id))) as { files: { filename: string }[] };
    expect(out.files.map((f) => f.filename)).toEqual(['ok.txt']);
    expect(out.files[0].filename).toBe(visible.filename.split('/').pop());
  });

  it('signals truncation with more: true above 20 files', async () => {
    const user = await createUser('list-many@example.com');
    await Promise.all(
      Array.from({ length: 23 }, (_, i) =>
        createAsset(user.id, `f${i}.txt`, { textExtracted: 'x' }),
      ),
    );
    const out = (await listExecute([], asCtx(user.id))) as {
      files: { filename: string }[];
      more?: boolean;
    };
    expect(out.files).toHaveLength(20);
    expect(out.more).toBe(true);
  });
});

describe('read_file tool (#58)', () => {
  it('requires a userId in the request context', async () => {
    expect(await readExecute({ id: 'x' }, asCtx())).toEqual({ error: 'unavailable' });
  });

  it('gracefully rejects a missing or malformed id', async () => {
    const user = await createUser('read-bad@example.com');
    expect(await readExecute({}, asCtx(user.id))).toEqual({ error: 'not_found' });
    expect(await readExecute({ id: 'not-an-objectid' }, asCtx(user.id))).toEqual({
      error: 'not_found',
    });
  });

  it('returns metadata plus extracted text for an owned ready asset', async () => {
    const user = await createUser('read-hit@example.com');
    const asset = await createAsset(user.id, 'notes.md', { textExtracted: '# heading' });
    const out = (await readExecute({ id: asset.id }, asCtx(user.id))) as {
      file: { id: string; filename: string; contentType: string; size: number; createdAt: string };
      content: string;
      hasText: boolean;
    };
    expect(out.file).toMatchObject({
      id: asset.id,
      filename: 'notes.md',
      contentType: 'text/plain',
      size: 123,
    });
    expect(new Date(out.file.createdAt).toISOString()).toBe(out.file.createdAt);
    expect(out.content).toBe('# heading');
    expect(out.hasText).toBe(true);
  });

  it('truncates huge contents with the prompt cap', async () => {
    const user = await createUser('read-trunc@example.com');
    const big = 'x'.repeat(13_000);
    const asset = await createAsset(user.id, 'big.csv', { textExtracted: big });
    const out = (await readExecute({ id: asset.id }, asCtx(user.id))) as { content: string };
    expect(out.content).toBe(truncateForPrompt(big));
  });

  it('degrades honestly when no text was extracted', async () => {
    const user = await createUser('read-null@example.com');
    const asset = await createAsset(user.id, 'photo.png', { textExtracted: null });
    const out = (await readExecute({ id: asset.id }, asCtx(user.id))) as {
      file: { filename: string };
      content: string | null;
      hasText: boolean;
      note?: string;
    };
    expect(out.file.filename).toBe('photo.png');
    expect(out.content).toBeNull();
    expect(out.hasText).toBe(false);
    expect(out.note).toContain('No readable text');
  });

  it('falls back to converted markdown when no text was extracted (#67)', async () => {
    const user = await createUser('read-markdown@example.com');
    const asset = await createAsset(user.id, 'report.pdf', {
      textExtracted: null,
      markdownExtracted: '# converted heading',
    });
    const out = (await readExecute({ id: asset.id }, asCtx(user.id))) as {
      content: string;
      hasText: boolean;
    };
    expect(out.content).toBe('# converted heading');
    expect(out.hasText).toBe(true);
  });

  it('prefers textExtracted over markdownExtracted when both exist', async () => {
    const user = await createUser('read-both@example.com');
    const asset = await createAsset(user.id, 'notes.md', {
      textExtracted: 'fast text',
      markdownExtracted: '# markdown text',
    });
    const out = (await readExecute({ id: asset.id }, asCtx(user.id))) as { content: string };
    expect(out.content).toBe('fast text');
  });

  it('does not leak other users’ assets or non-ready ones', async () => {
    const user = await createUser('read-owner@example.com');
    const other = await createUser('read-other@example.com');
    const theirs = await createAsset(other.id, 'theirs.txt', { textExtracted: 't' });
    const notReady = await createAsset(user.id, 'pending.txt', {
      status: 'pending',
      textExtracted: null,
    });
    expect(await readExecute({ id: theirs.id }, asCtx(user.id))).toEqual({ error: 'not_found' });
    expect(await readExecute({ id: notReady.id }, asCtx(user.id))).toEqual({
      error: 'not_found',
    });
  });
});
