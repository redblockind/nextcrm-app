"use server";

import { prismadb } from "@/lib/prisma";
import { getUser } from "@/actions/get-user";
import resendHelper from "@/lib/resend";
import { getInvoicePdfStream } from "@/lib/invoices/storage";
import { InvoiceEmail } from "@/emails/InvoiceEmail";
import { render } from "@react-email/render";

// Netlify Blobs returns a Web ReadableStream, not a Node.js stream.
// This helper converts it to a Buffer for the Resend email attachment API.
async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

interface SendInvoiceEmailInput {
  invoiceId: string;
  to: string;
  subject?: string;
  message?: string;
}

export async function sendInvoiceEmail(input: SendInvoiceEmailInput) {
  const user = await getUser();

  const invoice = await prismadb.invoices.findUniqueOrThrow({
    where: { id: input.invoiceId },
    select: {
      id: true,
      number: true,
      status: true,
      createdBy: true,
      pdfStorageKey: true,
      account: { select: { name: true } },
    },
  });

  if (invoice.createdBy !== user.id && !user.is_admin) {
    throw new Error("Forbidden");
  }

  if (!invoice.pdfStorageKey) {
    throw new Error("Invoice PDF not generated yet. Please issue the invoice first.");
  }

  // Fetch PDF from storage
  const pdfBody = await getInvoicePdfStream(invoice.pdfStorageKey);
  if (!pdfBody) {
    throw new Error("Failed to retrieve invoice PDF from storage");
  }

  const pdfBuffer = await streamToBuffer(pdfBody);

  const resend = await resendHelper();
  const fromEmail = process.env.EMAIL_FROM ?? `invoices@${process.env.NEXT_PUBLIC_APP_DOMAIN ?? "nextcrm.app"}`;

  const subject =
    input.subject ?? `Invoice ${invoice.number ?? invoice.id} — ${invoice.account.name}`;
  const message =
    input.message ?? "Please find attached your invoice as a PDF.";

  const html = await render(
    InvoiceEmail({
      number: invoice.number ?? "",
      message,
      userLanguage: user.userLanguage ?? "en",
    })
  );

  await resend.emails.send({
    from: fromEmail,
    to: input.to,
    subject,
    html,
    attachments: [
      {
        filename: `invoice-${invoice.number ?? invoice.id}.pdf`,
        content: pdfBuffer,
      },
    ],
  });

  // Update status to SENT only if currently ISSUED
  if (invoice.status === "ISSUED") {
    await prismadb.invoices.update({
      where: { id: invoice.id },
      data: {
        status: "SENT",
        activity: {
          create: {
            actorId: user.id,
            action: "SENT",
            meta: { to: input.to, subject },
          },
        },
      },
    });
  } else {
    // Log activity even if we don't change status
    await prismadb.invoice_Activity.create({
      data: {
        invoiceId: invoice.id,
        actorId: user.id,
        action: "EMAIL_SENT",
        meta: { to: input.to, subject },
      },
    });
  }

  return { success: true };
}
