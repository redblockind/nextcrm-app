"use server";
import { getSession } from "@/lib/auth-server";

import { prismadb } from "@/lib/prisma";
// storageDelete removes the file from Netlify Blobs (previously deleted from MinIO/S3)
import { storageDelete } from "@/lib/storage";

export async function deleteDocument(documentId: string) {
  const session = await getSession();
  if (!session) throw new Error("Unauthenticated");

  if (!documentId) throw new Error("Document ID is required");

  const document = await prismadb.documents.findUnique({
    where: { id: documentId },
  });

  if (!document) throw new Error("Document not found");

  await prismadb.documents.delete({ where: { id: documentId } });

  if (document.key) {
    await storageDelete(document.key);
  }
}
