/**
 * File upload endpoint — stores files in Netlify Blobs via lib/storage.ts.
 *
 * Despite the route name "presigned-url" (kept for backward compatibility with
 * existing client code), this endpoint no longer generates presigned S3 URLs.
 * Instead, it accepts a multipart FormData POST with `file` and `folder` fields,
 * stores the file server-side in Netlify Blobs, and returns { fileUrl, key }.
 *
 * Previously (MinIO era): clients called this route to get a presigned S3 URL,
 * then uploaded directly to MinIO. Now: clients POST the file here directly.
 *
 * @see components/ui/minio-uploader.tsx — client-side upload component
 * @see app/api/files/[key]/route.ts — serves stored files back to the client
 */
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { storageSet, storagePublicUrl } from "@/lib/storage";
import { randomUUID } from "crypto";

const ALLOWED_FOLDERS = ["avatars", "images", "documents", "uploads"] as const;
type AllowedFolder = (typeof ALLOWED_FOLDERS)[number];

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const rawFolder = (formData.get("folder") as string) || "uploads";

  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Content type not allowed" }, { status: 400 });
  }

  const filename = path.basename(file.name ?? "");
  const folder: AllowedFolder = ALLOWED_FOLDERS.includes(rawFolder as AllowedFolder)
    ? (rawFolder as AllowedFolder)
    : "uploads";

  const ext = filename.includes(".") ? filename.split(".").pop()?.trim() || "bin" : "bin";
  const key = `${folder}/${randomUUID()}.${ext}`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    await storageSet(key, arrayBuffer, { contentType: file.type });

    const fileUrl = storagePublicUrl(key);
    return NextResponse.json({ fileUrl, key });
  } catch (err) {
    console.error("Failed to upload file:", err);
    return NextResponse.json({ error: "Failed to upload file" }, { status: 500 });
  }
}
