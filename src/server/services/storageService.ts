import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// DigitalOcean Spaces is S3-compatible; AWS SDK v3 against a Spaces endpoint
// is the standard integration (issue #34). Feature-gated like
// webSearchService: when the env vars are absent, isStorageConfigured()
// returns false and callers degrade gracefully instead of crashing.
// Read lazily (not as module constants): env may be loaded after module
// import in some entrypoints, and tests mutate env directly.
const bucket = (): string => process.env.DO_SPACES_BUCKET || '';

let client: S3Client | null = null;

export const isStorageConfigured = (): boolean =>
  Boolean(process.env.DO_SPACES_KEY && process.env.DO_SPACES_SECRET && bucket());

const getClient = (): S3Client => {
  if (!isStorageConfigured()) {
    throw new Error('Spaces storage is not configured (DO_SPACES_* env vars missing)');
  }
  if (!client) {
    client = new S3Client({
      // Region guess (nyc3) is confirmed against a real presigned PUT during
      // e2e verification (plan open question 3).
      endpoint: `https://${process.env.DO_SPACES_REGION || 'nyc3'}.digitaloceanspaces.com`,
      region: process.env.DO_SPACES_REGION || 'nyc3',
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY as string,
        secretAccessKey: process.env.DO_SPACES_SECRET as string,
      },
    });
  }
  return client;
};

export const presignPutUrl = async (key: string, expiresIn = 60): Promise<string> =>
  getSignedUrl(getClient(), new PutObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn });

export const presignGetUrl = async (key: string, expiresIn = 300): Promise<string> =>
  getSignedUrl(getClient(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn });

export interface HeadObjectInfo {
  size: number;
  contentType?: string;
}

export const headObject = async (key: string): Promise<HeadObjectInfo> => {
  const result = await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  return { size: result.ContentLength ?? 0, contentType: result.ContentType };
};

// Returns true when the object existed and was deleted; NoSuchKey and
// NoSuchBucket-side "already gone" cases converge to true so deletes are
// idempotent from callers' perspective.
export const deleteObject = async (key: string): Promise<boolean> => {
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'NoSuchKey' || name === 'NotFound') return true;
    throw err;
  }
};
