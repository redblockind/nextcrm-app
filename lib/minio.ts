/**
 * @deprecated — This MinIO/S3 client is no longer used in the Netlify deployment.
 *
 * File storage has been migrated to Netlify Blobs (see lib/storage.ts).
 * This file is retained only as a reference for the Docker self-hosting setup,
 * which still uses MinIO as its object storage backend via docker-compose.yml.
 *
 * DO NOT import from this file for new features. Use lib/storage.ts instead,
 * which provides: storageSet, storageGet, storageGetStream, storageDelete,
 * and storagePublicUrl.
 */
import { S3Client } from "@aws-sdk/client-s3";

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  if (!process.env.MINIO_ENDPOINT) throw new Error("MINIO_ENDPOINT is not defined");
  if (!process.env.MINIO_ACCESS_KEY) throw new Error("MINIO_ACCESS_KEY is not defined");
  if (!process.env.MINIO_SECRET_KEY) throw new Error("MINIO_SECRET_KEY is not defined");
  _client = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: "us-east-1", // MinIO requires a region value; actual value doesn't matter
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY,
      secretAccessKey: process.env.MINIO_SECRET_KEY,
    },
    forcePathStyle: true, // REQUIRED for MinIO — without this, SDK uses virtual-hosted-style which breaks
  });
  return _client;
}

// Lazily resolve the S3 client on first access so that modules importing this file
// do not crash at build time when MinIO env vars are absent (e.g. during
// Next.js "Collecting page data").
export const minioClient = new Proxy({} as S3Client, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export const MINIO_BUCKET = process.env.MINIO_BUCKET as string;
export const MINIO_PUBLIC_URL = process.env.NEXT_PUBLIC_MINIO_ENDPOINT;
