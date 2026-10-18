import type { Readable } from 'stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';

// DigitalOcean Spaces via the AWS SDK; feature-gated on env vars.
// @see #34
const bucket = (): string => config.storage.bucket;

let client: S3Client | null = null;

export const isStorageConfigured = (): boolean =>
  Boolean(config.storage.key && config.storage.secret && bucket());

const getClient = (): S3Client => {
  if (!isStorageConfigured()) {
    throw new Error('Spaces storage is not configured (DO_SPACES_* env vars missing)');
  }
  if (!client) {
    client = new S3Client({
      // Region confirmed lon1 against a real ListObjectsV2 call.
      endpoint: `https://${config.storage.region}.digitaloceanspaces.com`,
      region: config.storage.region,
      credentials: {
        accessKeyId: config.storage.key as string,
        secretAccessKey: config.storage.secret as string,
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

// Direct server-side PUT for system-generated files; no presigned round-trip.
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

// Streams an object for server-side piping; no size cap.
// @see #69
export const getObjectStream = async (key: string): Promise<Readable | null> => {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return (result.Body ?? null) as Readable | null;
};

// Buffers an object for text extraction; null = too big, not an error.
// @see #34
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

// NoSuchKey/NotFound converge to true so deletes are idempotent.
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

// All keys under one prefix, paginated; callers gate first.
// @see #143
export const listObjectKeys = async (prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let continuation: string | undefined;
  do {
    const result = await getClient().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: continuation,
      }),
    );
    for (const object of result.Contents ?? []) if (object.Key) keys.push(object.Key);
    continuation = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuation);
  return keys;
};
