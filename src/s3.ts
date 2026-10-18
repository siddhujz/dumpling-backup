import { S3Client, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import type { StorageConfig } from "./config";
import type { ListedObject } from "./retention";

export function makeClient(storage: StorageConfig) {
  return new S3Client({
    // The SDK default is no timeout at all; a stalled endpoint must not hang a run forever.
    // socketTimeout = inactivity; requestTimeout only bites with throwOnRequestTimeout.
    requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000, requestTimeout: 900_000, throwOnRequestTimeout: true },
    region: storage.region || "auto",
    endpoint: storage.endpoint || undefined,
    forcePathStyle: storage.forcePathStyle,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
  });
}

export function joinKey(...parts: (string | undefined | null)[]) {
  return parts
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

export function describeS3Error(e: unknown): string {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = err.$metadata?.httpStatusCode;
  return `${err.name ?? "Error"}${status ? ` (HTTP ${status})` : ""}: ${err.message ?? String(e)}`;
}

/**
 * S3 allows 10,000 parts. With no size cap the default 64 MB part gives a 640 GB ceiling at
 * about 192 MB of buffered memory (queue of 3); a MAX_DUMP_GB cap sizes parts so 2x the cap fits.
 */
export function partSizeFor(maxBytes: number): number {
  const min = 64 * 1024 * 1024;
  if (!maxBytes) return min;
  return Math.max(min, Math.ceil(maxBytes / 9000 / min) * min);
}

/** Streams a body of unknown length to S3 using multipart upload; on any error the upload is aborted, never completed. */
export async function uploadStream(storage: StorageConfig, key: string, body: Readable, opts: { abortController: AbortController; maxBytes: number }) {
  const client = makeClient(storage);
  const upload = new Upload({
    client,
    params: { Bucket: storage.bucket, Key: key, Body: body },
    queueSize: 3,
    partSize: partSizeFor(opts.maxBytes),
    leavePartsOnError: false,
    abortController: opts.abortController,
  });
  try {
    await upload.done();
  } finally {
    client.destroy();
  }
}

export async function listBackups(storage: StorageConfig, folder: string, abortSignal?: AbortSignal): Promise<ListedObject[]> {
  const client = makeClient(storage);
  const prefix = joinKey(storage.prefix, folder) + "/";
  const out: ListedObject[] = [];
  let token: string | undefined;
  let pages = 0;
  try {
    do {
      if (++pages > 100) throw new Error("Listing the backup folder did not finish within 100 pages; retention skipped.");
      const res = await client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: token }), { abortSignal });
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
  return out;
}

export async function deleteKeys(storage: StorageConfig, keys: string[], abortSignal?: AbortSignal) {
  if (keys.length === 0) return;
  const client = makeClient(storage);
  try {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      // Some providers lack DeleteObjects; fall back to singles.
      try {
        await client.send(new DeleteObjectsCommand({ Bucket: storage.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }), { abortSignal });
      } catch {
        for (const Key of chunk) {
          if (abortSignal?.aborted) throw new Error("aborted");
          await client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key }), { abortSignal });
        }
      }
    }
  } finally {
    client.destroy();
  }
}
