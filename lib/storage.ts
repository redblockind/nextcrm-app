/**
 * Unified file storage abstraction using Netlify Blobs.
 *
 * This module replaces the previous MinIO/S3-based storage layer (lib/minio.ts).
 * MinIO required Docker infrastructure and MINIO_ENDPOINT / MINIO_ACCESS_KEY /
 * MINIO_SECRET_KEY environment variables that are unavailable in Netlify's
 * deployment environment. Netlify Blobs is a platform-native object store that
 * requires no external configuration.
 *
 * All file operations in the app — document uploads, invoice PDFs, thumbnails,
 * and enrichment — flow through this module. If you need to add a new storage
 * operation, add it here rather than importing @netlify/blobs directly.
 *
 * Files are served to the client via the authenticated route at
 * /api/files/[key] (see app/api/files/[key]/route.ts).
 *
 * @see lib/minio.ts — deprecated, retained only for Docker self-hosting reference
 * @see lib/invoices/storage.ts — invoice-specific wrappers built on this module
 */
import { getStore } from "@netlify/blobs";

const STORE_NAME = "uploads";

function store() {
  return getStore(STORE_NAME);
}

export async function storageSet(
  key: string,
  data: ArrayBuffer | Buffer | Uint8Array,
  metadata?: Record<string, string>,
): Promise<void> {
  let arrayBuf: ArrayBuffer;
  if (data instanceof ArrayBuffer) {
    arrayBuf = data;
  } else {
    arrayBuf = new ArrayBuffer(data.byteLength);
    new Uint8Array(arrayBuf).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  await store().set(key, arrayBuf, metadata ? { metadata } : undefined);
}

export async function storageGet(key: string): Promise<ArrayBuffer | null> {
  return store().get(key, { type: "arrayBuffer" });
}

export async function storageGetStream(key: string): Promise<ReadableStream | null> {
  return store().get(key, { type: "stream" }) as Promise<ReadableStream | null>;
}

export async function storageDelete(key: string): Promise<void> {
  await store().delete(key);
}

export function storagePublicUrl(key: string): string {
  return `/api/files/${encodeURIComponent(key)}`;
}
