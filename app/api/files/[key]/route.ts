/**
 * Authenticated file-serving route — reads files from Netlify Blobs.
 *
 * This route was introduced as part of the MinIO-to-Netlify-Blobs migration.
 * Previously, files were served directly from MinIO via public or presigned URLs.
 * Since Netlify Blobs does not expose public URLs, this route acts as the
 * authenticated proxy: storagePublicUrl() in lib/storage.ts returns
 * `/api/files/<key>`, and this route fetches the blob and streams it back.
 *
 * All document URLs stored in the database (document_file_url, thumbnail_url)
 * point to this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { storageGet } from "@/lib/storage";

const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key } = await params;
  const decodedKey = decodeURIComponent(key);
  const data = await storageGet(decodedKey);

  if (!data) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const ext = decodedKey.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME_MAP[ext] ?? "application/octet-stream";

  return new NextResponse(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
