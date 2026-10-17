import axios from 'axios';

// Where the file came from; absent ids mean unknown (never faked); absent provenance serialises as explicit null.
// @see #252 #251
export interface AssetProvenance {
  kind: 'upload' | 'chat' | 'task';
  sessionId?: string;
  taskId?: string;
  messageId?: string;
}

// File bytes go direct-to-Spaces with a presigned PUT; XHR so upload progress can be reported.
// @see #34
export interface AssetSummary {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  status: string;
  // 'system-side' is agent-only working material (no Spaces object, so download affordances must hide).
  // @see #340 #356
  origin?: 'user-upload' | 'system-generated' | 'system-side';
  // No extracted text server-side — Tova can read the filename only.
  hasText: boolean;
  // Markdown conversion lifecycle; the markdown text itself stays server-side.
  // @see #67
  markdownStatus?: string;
  // Worker's last failure reason for the failed-card tooltip.
  // @see #83
  markdownFailureReason?: string | null;
  // Derived-thumbnail lifecycle; the viewer waits for 'ready' before rendering an image preview.
  // @see #208
  thumbnailStatus?: string;
  // Provenance, or null when unknown (legacy rows / untracked).
  // @see #252
  provenance?: AssetProvenance | null;
  // Current content version; > 1 means the file has edit history.
  // @see #325
  version?: number;
  createdAt: string;
}

export interface AssetListPage {
  assets: AssetSummary[];
  nextCursor: string | null;
}

// The in-app viewer payload: the extracted body, which the list payload deliberately never carries.
// @see #197
export interface AssetContent {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  status: string;
  content: string | null;
  format: 'text' | 'markdown';
  markdownStatus?: string;
  markdownFailureReason?: string | null;
  thumbnailStatus?: string;
  // @see #252
  provenance?: AssetProvenance | null;
  // @see #325
  version?: number;
  createdAt: string;
}

// @see #325
export interface AssetVersionInfo {
  version: number;
  size: number;
  createdAt: string;
}

// @see #325
export interface AssetVersionContent {
  version: number;
  size: number;
  content: string | null;
  format: 'text' | 'markdown';
  createdAt: string;
}

// `url` is null until the worker produces the thumbnail; `status` lets the viewer keep polling while pending.
// @see #208
export interface AssetThumbnail {
  url: string | null;
  status: string;
}

export class AssetError extends Error {
  constructor(message = 'Something went wrong with that file', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AssetError';
  }
}

// Mirrors the server's asset size policy and bulk batch caps; exported so the UI reuses the same numbers.
// @see #68
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

// One bulk-presign, a pool of direct PUTs, then one bulk-confirm for the PUT-succeeded files; nothing ever throws.
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

  // Bounded parallelism for the direct PUTs; progress uses the caller's global file index.
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

  // PUT-failed files are never confirmed; results are matched back by assetId, not row order.
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
  // 'system-side' fetches ONLY agent-facing files; omitted keeps the server default, which the chat attach picker relies on.
  // @see #356
  async list(cursor?: string | null, origin?: 'system-side'): Promise<AssetListPage> {
    const res = await axios.get<AssetListPage>('/api/assets', {
      params: { ...(cursor ? { cursor } : {}), ...(origin ? { origin } : {}) },
    });
    return res.data;
  },

  // Fetch the extracted body for the in-app preview.
  // @see #197
  async content(assetId: string): Promise<AssetContent> {
    try {
      const res = await axios.get<{ asset: AssetContent }>(`/api/assets/${assetId}/content`);
      return res.data.asset;
    } catch (err) {
      throw toAssetError(err);
    }
  },

  async downloadUrl(assetId: string): Promise<string> {
    const res = await axios.get<{ url: string }>(`/api/assets/${assetId}/url`);
    return res.data.url;
  },

  // Content history of an assistant-generated file, newest first.
  // @see #325
  async versions(assetId: string): Promise<AssetVersionInfo[]> {
    try {
      const res = await axios.get<{ versions: AssetVersionInfo[] }>(
        `/api/assets/${assetId}/versions`,
      );
      return res.data.versions;
    } catch (err) {
      throw toAssetError(err);
    }
  },

  // Read one past version's body for the read-only preview.
  // @see #325
  async versionContent(assetId: string, version: number): Promise<AssetVersionContent> {
    try {
      const res = await axios.get<{ version: AssetVersionContent }>(
        `/api/assets/${assetId}/versions/${version}/content`,
      );
      return res.data.version;
    } catch (err) {
      throw toAssetError(err);
    }
  },

  // Restores the past version as a new current version.
  // @see #325
  async restore(assetId: string, version: number): Promise<AssetSummary> {
    try {
      const res = await axios.post<{ asset: AssetSummary }>(`/api/assets/${assetId}/restore`, {
        version,
      });
      return res.data.asset;
    } catch (err) {
      throw toAssetError(err);
    }
  },

  // Presigned URL for the derived thumbnail plus lifecycle status; `url` is null while pending or failed.
  // @see #208
  async thumbnailUrl(assetId: string): Promise<AssetThumbnail> {
    try {
      const res = await axios.get<AssetThumbnail>(`/api/assets/${assetId}/thumbnail-url`);
      return res.data;
    } catch (err) {
      throw toAssetError(err);
    }
  },

  // Plain GET with a repeatable `id` query param; the browser grabs the streamed zip, so just the URL for an anchor download.
  // @see #69
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

  // `scope: 'chat'` lets the server keep an incognito chat's attachments out of durable storage; `chatId`/`zdr` say which per-chat incognito decision applies.
  // @see #116 #144
  async upload(
    file: File,
    onProgress?: (pct: number) => void,
    scope?: 'chat',
    chatTarget?: { chatId: string } | { zdr: boolean },
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
          ...(chatTarget
            ? 'chatId' in chatTarget
              ? { chatId: chatTarget.chatId }
              : { zdr: chatTarget.zdr }
            : {}),
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

  // Bulk upload: one presign/confirm per chunk, direct PUTs in between; one result row per file, failures never throw, no archive container.
  // @see #68
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

    // Chunks are sequential; the server cap is a pure-number change away and the UI never exceeds it.
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
