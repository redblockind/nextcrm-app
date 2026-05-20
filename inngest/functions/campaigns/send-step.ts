import { inngest } from "@/inngest/client";
import { prismadb } from "@/lib/prisma";
import resendHelper from "@/lib/resend";
import { resolveMergeTags } from "@/lib/campaigns/merge-tags";

export const campaignSendStep = inngest.createFunction(
  {
    id: "campaign-send-step",
    name: "Campaign: Send Step",
    triggers: [{ event: "campaigns/send-step" }],
  },
  async ({ event, step }) => {
    const { sendId, campaignId } = event.data as {
      sendId: string;
      campaignId: string;
    };

    const sendRecord = await step.run("load-send-record", async () => {
      return prismadb.crm_campaign_sends.findUnique({
        where: { id: sendId },
        include: {
          campaign: { select: { status: true, from_name: true, reply_to: true } },
          step: { include: { template: true } },
          target: true,
        },
      });
    });

    if (!sendRecord) return { skipped: true, reason: "send record not found" };
    if (sendRecord.campaign.status === "paused") return { skipped: true, reason: "paused" };

    const html = resolveMergeTags(
      sendRecord.step.content_html ?? sendRecord.step.template.content_html,
      sendRecord.target
    );

    const fromEmail = process.env.EMAIL_FROM;
    const fromAddress = sendRecord.campaign.from_name
      ? `${sendRecord.campaign.from_name} <${fromEmail}>`
      : fromEmail!;

    const result = await step.run("send-email", async () => {
      let resend;
      try {
        resend = await resendHelper();
      } catch (error: any) {
        return {
          data: null,
          error: { message: error?.message || "Resend API key not configured" },
        };
      }
      return resend.emails.send({
        from: fromAddress,
        to: sendRecord.email,
        subject: resolveMergeTags(sendRecord.step.subject, sendRecord.target),
        html,
        ...(sendRecord.campaign.reply_to ? { replyTo: sendRecord.campaign.reply_to } : {}),
        headers: {
          "List-Unsubscribe": `<${process.env.NEXTAUTH_URL}/api/campaigns/unsubscribe?token=${sendRecord.unsubscribe_token}>`,
        },
      });
    });

    await step.run("update-send-record", async () => {
      if (result.error) {
        return prismadb.crm_campaign_sends.update({
          where: { id: sendId },
          data: { status: "failed", error_message: result.error?.message },
        });
      }
      return prismadb.crm_campaign_sends.update({
        where: { id: sendId },
        data: {
          status: "sent",
          resend_message_id: result.data?.id,
          sent_at: new Date(),
        },
      });
    });

    // After each individual send completes, check whether the entire campaign
    // is finished so we can transition it out of the "sending" state.
    await step.run("maybe-finalize-campaign", async () => {
      // If any campaign step has zero send records, a follow-up hasn't been
      // processed yet — don't finalize prematurely.
      const allSteps = await prismadb.crm_campaign_steps.findMany({
        where: { campaign_id: campaignId },
        select: { id: true },
      });
      for (const s of allSteps) {
        const count = await prismadb.crm_campaign_sends.count({
          where: { step_id: s.id },
        });
        if (count === 0) return;
      }

      // All steps have sends — check if any are still queued (in-flight).
      const queuedCount = await prismadb.crm_campaign_sends.count({
        where: { campaign_id: campaignId, status: "queued" },
      });
      if (queuedCount > 0) return;

      // Every send is in a terminal state. Determine the campaign outcome.
      const [failedCount, totalCount] = await Promise.all([
        prismadb.crm_campaign_sends.count({
          where: { campaign_id: campaignId, status: "failed" },
        }),
        prismadb.crm_campaign_sends.count({
          where: { campaign_id: campaignId },
        }),
      ]);

      await prismadb.crm_campaigns.update({
        where: { id: campaignId },
        data: {
          status: failedCount === totalCount ? "failed" : "sent",
          sent_at: new Date(),
        },
      });
    });

    return { sent: !result.error };
  }
);
