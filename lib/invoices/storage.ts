/**
 * Invoice file storage — thin wrappers around the Netlify Blobs abstraction.
 *
 * Previously used MinIO S3 directly. Now delegates to lib/storage.ts which
 * uses Netlify Blobs. Invoice PDFs are stored under the "invoices/" key prefix,
 * and attachments under "invoices/{id}/attachments/".
 *
 * @see lib/storage.ts — the underlying Netlify Blobs storage layer
 */
import { storageSet, storageGet, storageGetStream, storagePublicUrl } from "@/lib/storage";

function invoiceKey(invoiceId: string) {
  return `invoices/${invoiceId}.pdf`;
}

export async function uploadInvoicePdf(invoiceId: string, pdf: Buffer): Promise<string> {
  const key = invoiceKey(invoiceId);
  await storageSet(key, pdf, { contentType: "application/pdf" });
  return key;
}

export async function getInvoicePdfStream(key: string) {
  return storageGetStream(key);
}

export async function getInvoicePdfUrl(key: string): Promise<string> {
  return storagePublicUrl(key);
}

export async function uploadInvoiceAttachment(
  invoiceId: string,
  attachmentId: string,
  buf: Buffer,
  mime: string,
): Promise<string> {
  const key = `invoices/${invoiceId}/attachments/${attachmentId}`;
  await storageSet(key, buf, { contentType: mime });
  return key;
}
