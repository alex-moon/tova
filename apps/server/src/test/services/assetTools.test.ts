import { RequestContext } from '@mastra/core/request-context';
import { Asset } from '../../main/models/Asset';
import { AssetVersion } from '../../main/models/AssetVersion';
import { User } from '../../main/models/User';
import { Types } from 'mongoose';
import {
  editFileTool,
  generateFileTool,
  listFilesTool,
  readFileTool,
} from '../../main/services/llm/mastraService';
import { toolIsFailed } from '../../main/services/llm/toolDegrade';
import { truncateForPrompt } from '../../main/services/content/textExtraction';

jest.mock('../../main/services/storageService', () => ({
  isStorageConfigured: jest.fn(),
  putObject: jest.fn(),
  // list_files/read_file never touch storageService; keep it complete.
  presignPutUrl: jest.fn(),
  presignGetUrl: jest.fn(),
}));

const storageMocks = jest.requireMock('../../main/services/storageService') as {
  isStorageConfigured: jest.Mock;
  putObject: jest.Mock;
};

/* Tool-level tests: createTool is the identity, so `execute` runs directly. */
// @see #58

const asCtx = (userId?: string) => {
  const requestContext = new RequestContext();
  if (userId) requestContext.set('userId', userId);
  return { requestContext };
};

// A context carrying a session id, to exercise provenance attribution.
// @see #252
const asCtxWithSession = (userId: string, sessionId: string) => {
  const requestContext = new RequestContext();
  requestContext.set('userId', userId);
  requestContext.set('sessionId', sessionId);
  return { requestContext };
};

// A context carrying a task id (no session), to exercise task provenance.
// @see #298
const asCtxWithTask = (userId: string, taskId: string) => {
  const requestContext = new RequestContext();
  requestContext.set('userId', userId);
  requestContext.set('taskId', taskId);
  return { requestContext };
};

// `createTool` is the identity stub; pick the execute off to invoke direct.
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

const editExecute = (
  editFileTool as unknown as {
    execute: (
      args: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<{ file?: { id: string; version: number }; error?: string; note?: string }>;
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
    // Round-trip: the generated file is immediately listable and readable.
    // @see #66
    const listed = (await listExecute([], asCtx(user.id))) as { files: { id: string }[] };
    expect(listed.files.map((f) => f.id)).toContain(out.file?.id);
    const read = (await readExecute({ id: out.file?.id }, asCtx(user.id))) as {
      content?: string;
      hasText?: boolean;
    };
    expect(read.content).toBe(good.content);
    expect(read.hasText).toBe(true);
  });

  it('stamps chat provenance when a session rides on the context (#252)', async () => {
    const user = await createUser('generate-provenance@example.com');
    const sessionId = new Types.ObjectId().toString();
    const out = (await generateExecute(good, asCtxWithSession(user.id, sessionId))) as {
      file?: { id: string };
    };
    const stored = await Asset.findById(out.file?.id);
    expect(stored?.provenance?.kind).toBe('chat');
    expect(stored?.provenance?.sessionId).toBe(sessionId);
  });

  it('stamps task provenance when a task id rides on the context (#298)', async () => {
    const user = await createUser('generate-task-provenance@example.com');
    const taskId = new Types.ObjectId().toString();
    const out = (await generateExecute(good, asCtxWithTask(user.id, taskId))) as {
      file?: { id: string };
    };
    const stored = await Asset.findById(out.file?.id);
    expect(stored?.provenance?.kind).toBe('task');
    expect(stored?.provenance?.taskId).toBe(taskId);
  });

  it('leaves provenance absent when no session is on the context (#252)', async () => {
    const user = await createUser('generate-no-session@example.com');
    const out = (await generateExecute(good, asCtx(user.id))) as { file?: { id: string } };
    const stored = await Asset.findById(out.file?.id);
    expect(stored?.provenance).toBeUndefined();
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

describe('edit_file tool (#325)', () => {
  const generated = async (userId: string, content = '# draft\n\nbody') => {
    const id = new Types.ObjectId();
    await Asset.create({
      _id: id,
      userId,
      filename: 'notes.md',
      key: `${userId}/${String(id)}/notes.md`,
      contentType: 'text/markdown',
      size: Buffer.byteLength(content, 'utf8'),
      status: 'ready',
      origin: 'system-generated',
      textExtracted: content,
    });
    return String(id);
  };

  beforeEach(() => {
    storageMocks.isStorageConfigured.mockReset().mockReturnValue(true);
    storageMocks.putObject.mockReset().mockResolvedValue(undefined);
  });

  it('requires a userId in the request context', async () => {
    expect(await editExecute({ id: 'x', edits: [] }, asCtx())).toEqual({ error: 'unavailable' });
  });

  it('degrades to unavailable when storage is unconfigured', async () => {
    storageMocks.isStorageConfigured.mockReturnValue(false);
    const user = await createUser('edit-unconfigured@example.com');
    expect(
      await editExecute({ id: new Types.ObjectId().toString(), edits: [] }, asCtx(user.id)),
    ).toEqual({ error: 'unavailable' });
  });

  it('gracefully rejects a missing or malformed id', async () => {
    const user = await createUser('edit-bad-id@example.com');
    expect(await editExecute({ id: 'not-an-objectid', edits: [] }, asCtx(user.id))).toEqual({
      error: 'not_found',
    });
  });

  it('does not edit another user’s file', async () => {
    const owner = await createUser('edit-owner@example.com');
    const other = await createUser('edit-other@example.com');
    const id = await generated(owner.id);
    expect(
      await editExecute({ id, edits: [{ oldText: 'body', newText: 'x' }] }, asCtx(other.id)),
    ).toEqual({ error: 'not_found' });
  });

  it('applies edits to a generated file and bumps the version', async () => {
    const user = await createUser('edit-happy@example.com');
    const id = await generated(user.id);
    const out = await editExecute(
      { id, edits: [{ oldText: 'body', newText: 'body v2' }] },
      asCtx(user.id),
    );
    expect(out.error).toBeUndefined();
    expect(out.file).toMatchObject({ id, version: 2 });
    const stored = await Asset.findById(id);
    expect(stored?.textExtracted).toBe('# draft\n\nbody v2');
    expect(await AssetVersion.countDocuments({ assetId: id })).toBe(2);
  });

  it('refuses to edit a user upload', async () => {
    const user = await createUser('edit-upload@example.com');
    const asset = await createAsset(user.id, 'uploaded.txt', { textExtracted: 'hello' });
    const out = await editExecute(
      { id: asset.id, edits: [{ oldText: 'hello', newText: 'hi' }] },
      asCtx(user.id),
    );
    expect(out.error).toBe('not_editable');
    expect(storageMocks.putObject).not.toHaveBeenCalled();
  });

  it('returns a retryable no_match error with guidance', async () => {
    const user = await createUser('edit-nomatch@example.com');
    const id = await generated(user.id);
    const out = await editExecute(
      { id, edits: [{ oldText: 'absent', newText: 'x' }] },
      asCtx(user.id),
    );
    expect(out.error).toBe('no_match');
    expect(out.note).toContain('not found');
    expect(storageMocks.putObject).not.toHaveBeenCalled();
  });

  it('returns an ambiguous error when the block matches more than once', async () => {
    const user = await createUser('edit-ambiguous@example.com');
    const id = await generated(user.id, 'same\nsame');
    const out = await editExecute(
      { id, edits: [{ oldText: 'same', newText: 'x' }] },
      asCtx(user.id),
    );
    expect(out.error).toBe('ambiguous');
    expect(out.note).toContain('more than once');
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

  it('lists agent-side rows with their sourceUrl (#356) — cross-session rediscovery', async () => {
    const user = await createUser('list-agentside@example.com');
    await createAsset(user.id, 'mine.txt', { textExtracted: 'mine' });
    const scraped = await createAsset(user.id, 'web-example.com-page.md', {
      textExtracted: '# scraped page',
    });
    await Asset.updateOne(
      { _id: scraped.id },
      { $set: { origin: 'system-side', sourceUrl: 'https://example.com/page' } },
    );
    const out = (await listExecute([], asCtx(user.id))) as {
      files: { filename: string; sourceUrl?: string }[];
    };
    expect(out.files.map((f) => f.filename)).toEqual(
      expect.arrayContaining(['mine.txt', 'web-example.com-page.md']),
    );
    const cached = out.files.find((f) => f.filename === 'web-example.com-page.md');
    expect(cached?.sourceUrl).toBe('https://example.com/page');
    // Uploads carry no sourceUrl — the flag marks agent-saved pages only.
    expect(out.files.find((f) => f.filename === 'mine.txt')?.sourceUrl).toBeUndefined();
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

describe('read_file line paging (#350)', () => {
  const PAGES = ['intro text, phone 0400', 'second page '.repeat(12), 'PREFACE'.padStart(10, 'x')];
  const markdown = PAGES.join('\n');

  const setUnits = (assetId: string, units: { index: number; label: string; text: string }[]) =>
    Asset.updateOne({ _id: assetId }, { $set: { units } });

  const createPdf = async (userId: string) => {
    const asset = await createAsset(userId, 'report.pdf', {
      textExtracted: null,
      markdownExtracted: markdown,
    });
    await setUnits(
      asset.id,
      PAGES.map((text, i) => ({ index: i + 1, label: `Page ${i + 1}`, text })),
    );
    return asset;
  };

  it('lists units as a table of contents with start lines via unitsOnly', async () => {
    const user = await createUser('units-list@example.com');
    const asset = await createPdf(user.id);
    const out = (await readExecute({ id: asset.id, unitsOnly: true }, asCtx(user.id))) as {
      units: { index: number; label: string; startLine: number; preview: string }[];
    };
    expect(out.units).toHaveLength(3);
    expect(out.units[0]).toMatchObject({ index: 1, label: 'Page 1', startLine: 1 });
    expect(out.units[1].startLine).toBe(2);
    expect(out.units[2].startLine).toBe(3);
    expect(out.units[1].preview).toHaveLength(120);
  });

  it('accepts unitsOnly as a boolean-string ("true") from the wire (#159 live run)', async () => {
    const user = await createUser('units-string-boolean@example.com');
    const asset = await createPdf(user.id);
    const out = (await readExecute({ id: asset.id, unitsOnly: 'true' }, asCtx(user.id))) as {
      units?: { index: number }[];
    };
    expect(out.units).toHaveLength(3);
  });

  it('reads a line range with paging metadata', async () => {
    const user = await createUser('units-read@example.com');
    const asset = await createPdf(user.id);
    const out = (await readExecute({ id: asset.id, offset: 2, limit: 1 }, asCtx(user.id))) as {
      content: string;
      offset: number;
      endLine: number;
      totalLines: number;
      totalChars: number;
      truncated: boolean;
    };
    expect(out.content).toBe(PAGES[1]);
    expect(out.offset).toBe(2);
    expect(out.endLine).toBe(2);
    expect(out.totalLines).toBe(3);
    expect(out.totalChars).toBe(markdown.length);
    expect(out.truncated).toBe(true); // line 3 remains
  });

  it('coerces numeric string offset/limit (#159 live run)', async () => {
    const user = await createUser('units-numeric-string@example.com');
    const asset = await createPdf(user.id);
    const out = (await readExecute({ id: asset.id, offset: '3', limit: '1' }, asCtx(user.id))) as {
      content: string;
      endLine: number;
      truncated: boolean;
    };
    expect(out.content).toBe('xxxPREFACE');
    expect(out.endLine).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('rejects offset/limit outside the real range', async () => {
    const user = await createUser('units-oor@example.com');
    const asset = await createPdf(user.id);
    for (const args of [{ offset: 0 }, { offset: 4 }, { limit: 0 }, { offset: 'x' }]) {
      const out = (await readExecute({ id: asset.id, ...args }, asCtx(user.id))) as {
        error?: string;
      };
      expect(out.error).toBe('invalid');
      expect(toolIsFailed(asCtx('other'), 'read_file')).toBe(false);
    }
  });

  it('default read returns the head with metadata (no silent truncation)', async () => {
    const user = await createUser('units-default@example.com');
    const asset = await createPdf(user.id);
    const out = (await readExecute({ id: asset.id }, asCtx(user.id))) as {
      content: string;
      offset: number;
      endLine: number;
      totalLines: number;
      truncated: boolean;
    };
    expect(out.content).toBe(markdown);
    expect(out.offset).toBe(1);
    expect(out.endLine).toBe(3);
    expect(out.totalLines).toBe(3);
    expect(out.truncated).toBe(false); // whole doc fits under the cap
  });

  it('keeps line reads working for documents without units (item 3)', async () => {
    const user = await createUser('units-legacy@example.com');
    // No units set — an asset ingested before the units feature.
    // @see #159
    const asset = await createAsset(user.id, 'report.pdf', {
      textExtracted: null,
      markdownExtracted: 'line one\nline two\nline three',
    });
    const out = (await readExecute({ id: asset.id, offset: 2, limit: 1 }, asCtx(user.id))) as {
      content: string;
    };
    expect(out.content).toBe('line two');
    const unitsOnly = (await readExecute({ id: asset.id, unitsOnly: true }, asCtx(user.id))) as {
      units?: unknown[];
      note?: string;
    };
    expect(unitsOnly.units).toBeUndefined();
    expect(unitsOnly.note).toContain('no per-unit text');
  });
});

describe('asset tools degradation (#82)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('list_files: degrades with the failure reason, marks failed, and remembers it on retry', async () => {
    const findSpy = jest.spyOn(Asset, 'find').mockImplementation(() => {
      throw new Error('db down');
    });
    const ctxA = asCtx('owner-id');
    const first = (await listExecute([], ctxA)) as { files: unknown[]; error?: string };
    expect(first.files).toEqual([]);
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(first.error).toContain('list_files');
    expect(first.error).toContain('db down');
    expect(toolIsFailed(ctxA, 'list_files')).toBe(true);
    const second = (await listExecute([], ctxA)) as { error?: string };
    expect(findSpy).toHaveBeenCalledTimes(1); // short-circuit: no second query
    expect(second.error).toContain('db down'); // original reason remembered
    expect(toolIsFailed(asCtx('other'), 'list_files')).toBe(false); // scope is per-completion
  });

  it('list_files: model sees the "tried and failed" instruction', async () => {
    jest.spyOn(Asset, 'find').mockImplementation(() => {
      throw new Error('x');
    });
    const out = (await listExecute([], asCtx('owner-id'))) as { error?: string };
    expect(out.error).toContain('tell the user');
  });

  it('read_file: degrades with the failure reason, marks failed, and remembers it on retry', async () => {
    const findOneSpy = jest.spyOn(Asset, 'findOne').mockImplementation(() => {
      throw new Error('read blew up');
    });
    const ctxA = asCtx('owner-id');
    const id = new Types.ObjectId().toString();
    const first = (await readExecute({ id }, ctxA)) as { error?: string };
    expect(first.error).toContain('read_file');
    expect(first.error).toContain('read blew up');
    expect(findOneSpy).toHaveBeenCalledTimes(1);
    expect(toolIsFailed(ctxA, 'read_file')).toBe(true);
    const second = (await readExecute({ id }, ctxA)) as { error?: string };
    expect(findOneSpy).toHaveBeenCalledTimes(1); // short-circuit: no second query
    expect(second.error).toContain('read blew up');
  });

  it('read_file: a valid id path does not mark the tool failed', async () => {
    const user = await createUser('read-ok@example.com');
    const asset = await createAsset(user.id, 'ok.txt', { textExtracted: 'ok' });
    const ctx = asCtx(user.id);
    await readExecute({ id: asset.id }, ctx);
    expect(toolIsFailed(ctx, 'read_file')).toBe(false);
  });

  it('a userId-less context returns the config-unavailable result without marking failure', async () => {
    const ctx = asCtx();
    expect(await listExecute([], ctx)).toEqual({ files: [], error: 'unavailable' });
    expect(toolIsFailed(ctx, 'list_files')).toBe(false);
    expect(await readExecute({}, ctx)).toEqual({ error: 'unavailable' });
    expect(toolIsFailed(ctx, 'read_file')).toBe(false);
  });
});
