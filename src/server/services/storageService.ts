import type { Readable } from 'stream';
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
      // Region confirmed lon1 against a real ListObjectsV2 call (open
      // question 3 in the plan is resolved; env override kept for the live
      // host to be decisive).
      endpoint: `https://${process.env.DO_SPACES_REGION || 'lon1'}.digitaloceanspaces.com`,
      region: process.env.DO_SPACES_REGION || 'lon1',
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY as string,
        secretAccessKey: process.env.DO_SPACES_SECRET as string,
      },
    });
  }
  return client;
};

export const presignPutUrl = async (
  key: string,
  expiresIn = 60,
  contentType?: string,
): Promise<string> =>
  getSignedUrl(
    getClient(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    { expiresIn },
  );

// Direct server-side PUT (issue #66): system-generated files are written by
// the server itself, so no presigned-URL round-trip is needed. Throws on
// failure like the other direct commands.
export const putObject = async (key: string, body: Buffer, contentType?: string): Promise<void> => {
  await getClient().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, Body: body }),
  );
};

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

// Streams an object back for server-side piping (e.g. #69 bulk zip
// download). Unlike getObjectBuffer there is no size cap: callers decide
// what is safe to stream. Returns the raw Body stream.
export const getObjectStream = async (key: string): Promise<Readable | null> => {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return (result.Body ?? null) as Readable | null;
};

// Buffers an object for light text extraction at confirm time (issue #34).
// Objects larger than maxBytes are not downloaded (extraction stays light);
// null means "either too big to pull or no body" and callers treat it as no
// text extracted rather than an error.
export const getObjectBuffer = async (
  key: string,
  maxBytes = 1_000_000,
): Promise<Buffer | null> => {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if ((result.ContentLength ?? 0) > maxBytes) {
    (result.Body as unknown as { destroy?: () => void })?.destroy?.();
    return null;
  }
  const bytes = await result.Body?.transformToByteArray?.();
  return bytes ? Buffer.from(bytes) : null;
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
