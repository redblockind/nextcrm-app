/**
 * Generates a thumbnail for uploaded image documents.
 *
 * Reads the original file from Netlify Blobs, resizes it with sharp, and
 * writes the thumbnail back to Netlify Blobs under the "thumbnails/" prefix.
 * Previously read/wrote directly to MinIO via S3 SDK commands.
 *
 * @see lib/storage.ts — Netlify Blobs abstraction used for all file I/O
 */
import { inngest } from "@/inngest/client";
import { prismadb } from "@/lib/prisma";
import { storageGet, storageSet, storagePublicUrl } from "@/lib/storage";
import sharp from "sharp";

const THUMB_WIDTH = 200;
const THUMB_HEIGHT = 200;

async function fetchFileBuffer(key: string): Promise<Buffer> {
  const data = await storageGet(key);
  if (!data) throw new Error(`File not found: ${key}`);
  return Buffer.from(data);
}

export const generateDocumentThumbnail = inngest.createFunction(
  {
    id: "document-generate-thumbnail",
    name: "Generate Document Thumbnail",
    triggers: [{ event: "document/uploaded" }],
    retries: 2,
  },
  async ({ event }) => {
    const { documentId } = event.data as { documentId: string };

    const document = await prismadb.documents.findUnique({
      where: { id: documentId },
      select: { id: true, key: true, document_file_mimeType: true },
    });
    if (!document?.key) return { skipped: "no key" };

    const isImage = document.document_file_mimeType.startsWith("image/");
    if (!isImage) {
      return { skipped: "non-image file" };
    }

    const buffer = await fetchFileBuffer(document.key);
    const thumbnail = await sharp(buffer)
      .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: "cover" })
      .png()
      .toBuffer();

    const thumbnailKey = `thumbnails/${documentId}.png`;
    await storageSet(thumbnailKey, thumbnail, { contentType: "image/png" });

    const thumbnailUrl = storagePublicUrl(thumbnailKey);

    await prismadb.documents.update({
      where: { id: documentId },
      data: { thumbnail_url: thumbnailUrl },
    });

    return { documentId, thumbnailUrl };
  }
);
