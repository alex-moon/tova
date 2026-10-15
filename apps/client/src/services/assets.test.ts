import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import AssetService from './assets';
import type { AssetSummary, BulkUploadFileResult } from './assets';

// First service-level test harness in the client suite (plan #68, item 4):
// a minimal axios mock plus a stubbed XMLHttpRequest that only captures
// open/send/setRequestHeader and exposes the onload/onprogress slots the
// service drives — no full XHR semantics emulation.
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    isAxiosError: (err: unknown) =>
      err instanceof Error && (err as { isAxiosError?: boolean }).isAxiosError === true,
  },
}));

const axiosPost = vi.mocked(axios.post);

interface FakeProgress {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

class FakeXHR {
  static sent: FakeXHR[] = [];
  status = 200;
  sent: unknown = null;
  contentType: string | null = null;
  url: string | null = null;
  upload: { onprogress: ((e: FakeProgress) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(header: string, value: string) {
    if (header.toLowerCase() === 'content-type') this.contentType = value;
  }
  send(file: unknown) {
    this.sent = file;
    FakeXHR.sent.push(this);
  }
  respond(status = 200) {
    this.status = status;
    this.onload?.();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Drive every in-flight PUT: under the worker pool, resolving one PUT lets
// the next file shift + send, so keep draining until no new XHRs appear.
// `statusFor(xhr, i)` decides each PUT's outcome (i = send order).
const flushPuts = async (statusFor: (xhr: FakeXHR, i: number) => number = () => 200) => {
  let handled = 0;
  while (FakeXHR.sent.length > handled) {
    handled = FakeXHR.sent.length;
    for (let i = 0; i < handled; i++) FakeXHR.sent[i].respond(statusFor(FakeXHR.sent[i], i));
    await tick();
  }
};

const mk = (name: string, size = 4, type = 'text/plain') =>
  new File(['x'.repeat(size)], name, { type });

const assetRow = (id: string): AssetSummary => ({
  id,
  filename: 'f',
  contentType: 'text/plain',
  size: 4,
  status: 'pending',
  hasText: false,
  createdAt: new Date().toISOString(),
});

// Per-test plan read by the axios mock: presign rejects items whose filename
// is listed; presignFail fails the whole presign route call; batchFail makes
// the route call reject with an axios-like error; confirmRejectPositions
// rejects confirm rows by payload position.
const plan = {
  presignRejectFilenames: new Set<string>(),
  presignFail: false,
  confirmRejectPositions: new Set<number>(),
  confirmFail: false,
};

let presignBodies: unknown[];
let confirmBodies: unknown[];

beforeEach(() => {
  FakeXHR.sent = [];
  plan.presignRejectFilenames.clear();
  plan.presignFail = false;
  plan.confirmRejectPositions.clear();
  plan.confirmFail = false;
  presignBodies = [];
  confirmBodies = [];
  axiosPost.mockImplementation(async (url: string, body: unknown) => {
    const path = String(url);
    if (path.endsWith('/bulk-presign')) {
      presignBodies.push(body);
      if (plan.presignFail) {
        const err = new Error('Request failed with status code 500') as Error & {
          isAxiosError: boolean;
        };
        err.isAxiosError = true;
        throw err;
      }
      const items = body as Array<{ filename: string }>;
      return {
        data: {
          results: items.map((item): BulkResult =>
            plan.presignRejectFilenames.has(item.filename)
              ? { status: 'rejected', filename: item.filename, message: 'Unsupported file type' }
              : {
                  status: 'ok',
                  filename: item.filename,
                  asset: assetRow(item.filename),
                  uploadUrl: `https://spaces/${item.filename}`,
                },
          ),
        },
      } as never;
    }
    if (path.endsWith('/bulk-confirm')) {
      confirmBodies.push(body);
      if (plan.confirmFail) {
        const err = new Error('Request failed with status code 500') as Error & {
          isAxiosError: boolean;
        };
        err.isAxiosError = true;
        throw err;
      }
      const items = body as Array<{ assetId: string }>;
      return {
        data: {
          results: items.map(({ assetId }, pos): ConfirmResult =>
            plan.confirmRejectPositions.has(pos)
              ? { status: 'rejected', assetId, message: 'Upload window has expired' }
              : { status: 'ok', assetId, asset: { ...assetRow(assetId), status: 'ready' } },
          ),
        },
      } as never;
    }
    throw new Error(`unexpected axios.post ${path}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  axiosPost.mockReset();
});

type BulkResult =
  | { status: 'ok'; filename: string; asset: AssetSummary; uploadUrl: string }
  | { status: 'rejected'; filename: string; message: string };

type ConfirmResult =
  | { status: 'ok'; assetId: string; asset: AssetSummary }
  | { status: 'rejected'; assetId: string; message: string };

const stubXhr = () => {
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
};

// Start `uploadMany`, let the presign round-trip settle, then drain all PUTs
// and return the awaited result. `statusFor` optionally fails PUTs.
const run = async (
  files: File[],
  statusFor?: (xhr: FakeXHR, i: number) => number,
  onFileProgress?: (fileIndex: number, pct: number) => void,
): Promise<BulkUploadFileResult[]> => {
  const pending = AssetService.uploadMany(files, onFileProgress);
  await tick();
  await flushPuts(statusFor);
  return pending;
};

const presignCalls = () =>
  axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/bulk-presign'));
const confirmCalls = () =>
  axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/bulk-confirm'));

describe('AssetService.uploadMany', () => {
  it('splits selections larger than the batch cap into sequential batches', async () => {
    stubXhr();
    const files = Array.from({ length: 25 }, (_, i) => mk(`f${i}.txt`));
    const results = await run(files);
    expect(results.every((r) => r.asset)).toBe(true);
    const presigns = presignCalls();
    const confirms = confirmCalls();
    expect((presigns[0] as unknown[])[1]).toHaveLength(20);
    expect((presigns[1] as unknown[])[1]).toHaveLength(5);
    expect((confirms[0] as unknown[])[1]).toHaveLength(20);
    expect((confirms[1] as unknown[])[1]).toHaveLength(5);
  });

  it('locally rejects oversized files with no API call or PUT for them', async () => {
    stubXhr();
    const big = new File([new ArrayBuffer(15 * 1024 * 1024 + 1)], 'big.bin', {
      type: 'application/octet-stream',
    });
    const results = await run([big, mk('ok.txt')]);

    expect(results[0].error).toMatch(/too large/);
    expect(results[0].asset).toBeUndefined();
    expect(results[1].asset?.status).toBe('ready');
    expect(presignBodies[0]).toHaveLength(1);
    expect(FakeXHR.sent).toHaveLength(1);
  });

  it('emits per-file PUT progress with global file indices', async () => {
    stubXhr();
    const onFileProgress = vi.fn();
    const done = AssetService.uploadMany([mk('a.txt'), mk('b.txt')], onFileProgress);

    await tick();
    FakeXHR.sent[0].upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    FakeXHR.sent[0].respond();
    FakeXHR.sent[1].upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
    FakeXHR.sent[1].respond();
    await done;

    expect(onFileProgress).toHaveBeenCalledWith(0, 25);
    expect(onFileProgress).toHaveBeenCalledWith(1, 100);
  });

  it('runs PUTs so that at most 3 are in flight', async () => {
    stubXhr();
    const files = Array.from({ length: 6 }, (_, i) => mk(`f${i}.txt`));
    const pending = AssetService.uploadMany(files);

    // Pool sends its first 3 and holds; resolving one slot starts exactly
    // one queued file.
    await tick();
    expect(FakeXHR.sent.length).toBe(3);
    FakeXHR.sent[0].respond();
    await tick();
    expect(FakeXHR.sent.length).toBe(4);
    await flushPuts();
    const results = await pending;
    expect(results.every((r) => r.asset)).toBe(true);
  });

  it('returns PUT failures as per-file errors and confirms only succeeded files', async () => {
    stubXhr();
    const done: Promise<BulkUploadFileResult[]> = AssetService.uploadMany([
      mk('a.txt'),
      mk('b.txt'),
      mk('c.txt'),
    ]);

    await tick();
    // First PUT off the queue fails at the storage side.
    FakeXHR.sent[0].respond(500);
    await tick();
    await flushPuts();
    const results = await done;

    expect(confirmBodies).toHaveLength(1);
    const ids = confirmBodies[0] as Array<{ assetId: string }>;
    expect(ids).toHaveLength(2); // PUT-failed file is never confirmed
    expect(results[0].error).toBe('The upload to storage failed');
    expect(results[1].asset?.status).toBe('ready');
    expect(results[2].asset?.status).toBe('ready');
  });

  it('maps bulk-presign per-item rejections to error rows without PUTs for them', async () => {
    stubXhr();
    plan.presignRejectFilenames.add('bad.txt');
    const results = await run([mk('bad.txt'), mk('good.txt')]);

    expect(results[0].error).toBe('Unsupported file type');
    expect(results[0].asset).toBeUndefined();
    expect(results[1].asset?.status).toBe('ready');
    expect(FakeXHR.sent).toHaveLength(1); // only the ok item is PUT
    const ids = confirmBodies[0] as Array<{ assetId: string }>;
    expect(ids).toHaveLength(1);
  });

  it('maps bulk-confirm per-item rejections to per-file errors', async () => {
    stubXhr();
    plan.confirmRejectPositions.add(1);
    const results = await run([mk('a.txt'), mk('b.txt')]);

    expect(results[0].asset?.status).toBe('ready');
    expect(results[1].error).toBe('Upload window has expired');
  });

  it('maps a batch-level presign failure to error rows without throwing', async () => {
    stubXhr();
    plan.presignFail = true;
    const results = await AssetService.uploadMany([mk('a.txt'), mk('b.txt')]);

    expect(results.every((r) => r.error !== undefined)).toBe(true);
    expect(confirmBodies).toHaveLength(0);
    expect(FakeXHR.sent).toHaveLength(0);
  });

  it('sends no bulk-confirm when every PUT of a batch fails', async () => {
    stubXhr();
    const results = await run([mk('a.txt'), mk('b.txt')], () => 500);

    expect(results.every((r) => r.error === 'The upload to storage failed')).toBe(true);
    expect(confirmBodies).toHaveLength(0);
  });
});

describe('AssetService version history (#325)', () => {
  const axiosGet = vi.mocked(axios.get);

  beforeEach(() => {
    axiosGet.mockReset();
  });

  it('lists versions from the versions endpoint', async () => {
    axiosGet.mockResolvedValue({
      data: { versions: [{ version: 2, size: 12, createdAt: '2026-01-01T00:00:00.000Z' }] },
    } as never);
    const versions = await AssetService.versions('a1');
    expect(axiosGet).toHaveBeenCalledWith('/api/assets/a1/versions');
    expect(versions).toEqual([{ version: 2, size: 12, createdAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('fetches one version body', async () => {
    axiosGet.mockResolvedValue({
      data: {
        version: {
          version: 1,
          size: 8,
          content: 'old',
          format: 'markdown',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    } as never);
    const v = await AssetService.versionContent('a1', 1);
    expect(axiosGet).toHaveBeenCalledWith('/api/assets/a1/versions/1/content');
    expect(v.content).toBe('old');
  });

  it('posts a restore and returns the updated asset', async () => {
    axiosPost.mockResolvedValueOnce({
      data: { asset: { ...assetRow('a1'), status: 'ready', version: 3 } },
    } as never);
    const restored = await AssetService.restore('a1', 1);
    expect(axiosPost).toHaveBeenCalledWith('/api/assets/a1/restore', { version: 1 });
    expect(restored.version).toBe(3);
  });
});
