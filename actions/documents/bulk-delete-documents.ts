"use server";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
// storageDelete removes files from Netlify Blobs (previously deleted from MinIO/S3)
import { storageDelete } from "@/lib/storage";

export async function bulkDeleteDocuments(documentIds: string[]) {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");

  const documents = await prismadb.documents.findMany({
    where: { id: { in: documentIds } },
    select: { id: true, key: true },
  });

  await Promise.allSettled(
    documents.map((doc: { id: string; key: string | null }) =>
      doc.key ? storageDelete(doc.key) : Promise.resolve()
    )
  );

  await prismadb.documents.deleteMany({
    where: { id: { in: documentIds } },
  });

  revalidatePath("/[locale]/(routes)/documents");
}
