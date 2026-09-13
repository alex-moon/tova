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

  async delete(assetId: string): Promise<void> {
    try {
      await axios.delete(`/api/assets/${assetId}`);
    } catch (err) {
      throw toAssetError(err);
    }
  },

  async upload(file: File, onProgress?: (pct: number) => void): Promise<AssetSummary> {
    let created: { uploadUrl: string; asset: AssetSummary };
    try {
      const res = await axios.post<{ uploadUrl: string; asset: AssetSummary }>(
        '/api/assets/presign',
        {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
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
};

export default AssetService;
