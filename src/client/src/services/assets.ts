import axios from 'axios';

// Asset connector (issue #34): the browser uploads file bytes directly to
// Spaces with a presigned PUT; this service only talks to our own API for
// presign/confirm/list/url/delete and performs the direct PUT with XHR so
// upload progress can be reported.
export interface AssetSummary {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  status: string;
  // No extracted text server-side — Tova can read the filename only.
  hasText: boolean;
  // Issue #67: markdown conversion lifecycle ('none'|'pending'|'ready'|'failed');
  // the markdown text itself stays server-side.
  markdownStatus?: string;
  // Issue #83: worker's last failure reason for the failed-card tooltip.
  markdownFailureReason?: string | null;
  createdAt: string;
}

export interface AssetListPage {
  assets: AssetSummary[];
  nextCursor: string | null;
}

export class AssetError extends Error {
  constructor(message = 'Something went wrong with that file', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AssetError';
  }
}

// Mirrors the server's asset size policy and #68's bulk batch caps. Exported
// so the library UI reuses the same numbers instead of duplicating them.
export const MAX_ASSET_SIZE = 15 * 1024 * 1024;
export const BULK_BATCH_SIZE = 20;
const BULK_PUT_CONCURRENCY = 3;

export interface BulkUploadFileResult {
  file: File;
  asset?: AssetSummary;
  error?: string;
}

const toAssetError = (err: unknown): AssetError => {
  if (axios.isAxiosError(err)) {
    const message = (err.response?.data as { message?: string } | undefined)?.message;
    if (message) return new AssetError(message, { cause: err });
  }
  return new AssetError('Something went wrong with that file', { cause: err });
};

const putUpload = (
  url: string,
  file: File,
  contentType: string,
  onProgress?: (pct: number) => void,
) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    if (xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new AssetError('The upload to storage failed'));
      }
    };
    xhr.onerror = () => reject(new AssetError('The upload to storage failed'));
    xhr.send(file);
  });

const contentTypeOf = (file: File) => file.type || 'application/octet-stream';

// One chunk of `uploadMany`: one bulk-presign, a pool of direct PUTs, then
// one bulk-confirm covering only the files whose PUT succeeded. Per-file
// failures land in `results[index].error`; only a route-level failure of the
// batch calls degrades every file of this chunk to an error row — nothing
// ever throws (partial success stays visible even when a whole chunk fails).
const uploadBatch = async (
  batch: number[],
  files: File[],
  results: BulkUploadFileResult[],
  onFileProgress?: (fileIndex: number, pct: number) => void,
) => {
  let okItems: { index: number; assetId: string; uploadUrl: string }[];
  try {
    const res = await axios.post<{
      results: Array<
        | { status: 'ok'; filename: string; asset: AssetSummary; uploadUrl: string }
        | {
            status: 'rejected';
            filename: string;
            message: string;
          }
      >;
    }>(
      '/api/assets/bulk-presign',
      batch.map((i) => ({
        filename: files[i].name,
        contentType: contentTypeOf(files[i]),
        size: files[i].size,
      })),
    );
    okItems = [];
    res.data.results.forEach((row, pos) => {
      const index = batch[pos];
      if (!row || row.status !== 'ok') {
        results[index].error =
          (row as { message?: string } | undefined)?.message ?? 'The file was rejected';
      } else {
        okItems.push({ index, assetId: row.asset.id, uploadUrl: row.uploadUrl });
      }
    });
  } catch (err) {
    const message = toAssetError(err).message;
    for (const index of batch) results[index].error = message;
    return;
  }

  // Worker pool of 3 over an index queue: bounded parallelism for the direct
  // Spaces PUTs. Progress uses the caller's global file index so the UI can
  // map callbacks to rows without batch knowledge.
  const queue = [...okItems];
  const putSucceeded: typeof okItems = [];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        await putUpload(
          item.uploadUrl,
          files[item.index],
          contentTypeOf(files[item.index]),
          (pct) => onFileProgress?.(item.index, pct),
        );
        putSucceeded.push(item);
      } catch {
        results[item.index].error = 'The upload to storage failed';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BULK_PUT_CONCURRENCY, queue.length) }, worker));

  // One bulk-confirm per batch for only the PUT-succeeded files — PUT-failed
  // files are never confirmed (their rows are already errors). Results are
  // matched back by assetId, not row order.
  if (!putSucceeded.length) return;

  try {
    const res = await axios.post<{
      results: Array<
        | { status: 'ok'; assetId: string; asset: AssetSummary }
        | {
            status: 'rejected';
            assetId: string | null;
            message: string;
          }
      >;
    }>(
      '/api/assets/bulk-confirm',
      putSucceeded.map((item) => ({ assetId: item.assetId })),
    );
    const byId = new Map(res.data.results.map((row) => [row.assetId ?? '', row] as const));
    for (const item of putSucceeded) {
      const row = byId.get(item.assetId);
      if (row && row.status === 'ok') {
        results[item.index].asset = row.asset;
      } else {
        results[item.index].error =
          (row as { message?: string } | undefined)?.message ?? 'Error confirming upload';
      }
    }
  } catch (err) {
    const message = toAssetError(err).message;
    for (const item of putSucceeded) results[item.index].error = message;
  }
};

const AssetService = {
  async list(cursor?: string | null): Promise<AssetListPage> {
    const res = await axios.get<AssetListPage>('/api/assets', {
      params: cursor ? { cursor } : {},
    });
    return res.data;
  },

  async downloadUrl(assetId: string): Promise<string> {
    const res = await axios.get<{ url: string }>(`/api/assets/${assetId}/url`);
    return res.data.url;
  },

  // Issue #69: bulk download is a plain GET with a repeatable `id` query
  // param; the browser grabs the streamed zip (cookies ride along), so no
  // axios call is needed — just the URL for an anchor download.
  bulkDownloadUrl(assetIds: string[]): string {
    return `/api/assets/bulk-download?${assetIds
      .map((id) => `id=${encodeURIComponent(id)}`)
      .join('&')}`;
  },

  // Batch delete uses the same repeated `?id=` contract as bulk download.
  async bulkDelete(assetIds: string[]): Promise<void> {
    try {
      await axios.delete(
        `/api/assets/bulk-delete?${assetIds.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`,
      );
    } catch (err) {
      throw toAssetError(err);
    }
  },

  async delete(assetId: string): Promise<void> {
    try {
      await axios.delete(`/api/assets/${assetId}`);
    } catch (err) {
      throw toAssetError(err);
    }
  },

  // `scope` (issue #116): the chat composer tags its uploads as 'chat' so the
  // server can keep a ZDR account's chat attachments out of durable storage.
  // Assets-page uploads omit it and remain durable by default.
  async upload(
    file: File,
    onProgress?: (pct: number) => void,
    scope?: 'chat',
  ): Promise<AssetSummary> {
    let created: { uploadUrl: string; asset: AssetSummary };
    try {
      const res = await axios.post<{ uploadUrl: string; asset: AssetSummary }>(
        '/api/assets/presign',
        {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          ...(scope ? { scope } : {}),
        },
      );
      created = res.data;
    } catch (err) {
      throw toAssetError(err);
    }

    await putUpload(created.uploadUrl, file, file.type || 'application/octet-stream', onProgress);

    try {
      const res = await axios.post<{ asset: AssetSummary }>(
        `/api/assets/${created.asset.id}/confirm`,
        {},
      );
      return res.data.asset;
    } catch (err) {
      throw toAssetError(err);
    }
  },

  // Bulk upload (issue #68): many files via N normal singleton uploads — one
  // bulk-presign and one bulk-confirm per chunk of at most BULK_BATCH_SIZE
  // files, direct PUTs to Spaces in between with a worker pool of 3. Maps
  // `FileList` → `File[]`, rejects oversized files locally (no API call),
  // and resolves with one result row per file: `asset` for success, `error`
  // otherwise. Per-file failures never throw; nothing here sends or accepts
  // any archive container — bulk is just many normal uploads, and uploads are
  // never zips.
  async uploadMany(
    files: File[] | FileList,
    onFileProgress?: (fileIndex: number, pct: number) => void,
  ): Promise<BulkUploadFileResult[]> {
    const all = Array.from(files);
    const results: BulkUploadFileResult[] = all.map((file) => ({ file: file as File }));

    const pending: number[] = [];
    for (let i = 0; i < all.length; i++) {
      const file = all[i] as File;
      if (file.size > MAX_ASSET_SIZE) {
        results[i].error = `"${file.name}" is too large (max 15 MB)`;
      } else {
        pending.push(i);
      }
    }

    // Chunks are processed sequentially: the server cap (MAX_BULK_FILES) is
    // a pure-number change away, and our UI never exceeds it.
    for (let start = 0; start < pending.length; start += BULK_BATCH_SIZE) {
      await uploadBatch(
        pending.slice(start, start + BULK_BATCH_SIZE),
        all,
        results,
        onFileProgress,
      );
    }
    return results;
  },
};

export default AssetService;
