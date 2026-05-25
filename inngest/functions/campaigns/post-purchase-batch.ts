import { inngest } from "@/inngest/client";
import { prismadb } from "@/lib/prisma";
import { randomUUID } from "crypto";

const PENDING_LIST_NAME = "Pending Post-Purchase";
const SENT_LIST_NAME = "Sent Post-Purchase";
const POST_PURCHASE_TAG = "post-purchase-auto";
const DELAY_DAYS = 7;

export const postPurchaseBatchCron = inngest.createFunction(
  {
    id: "post-purchase-batch-cron",
    name: "Campaigns: Post-Purchase Daily Batch",
    triggers: [{ cron: "0 9 * * *" }],
  },
  async ({ step }: { step: any }) => {
    const pendingList = await step.run("find-pending-list", async () => {
      return prismadb.crm_TargetLists.findFirst({
        where: { name: PENDING_LIST_NAME, deletedAt: null },
        select: { id: true },
      });
    });
    if (!pendingList) {
      return { dispatched: 0, reason: "no pending list found" };
    }

    const cutoff = new Date(Date.now() - DELAY_DAYS * 86_400_000);

    const eligibleTargets: Array<{ id: string; email: string }> = await step.run(
      "find-eligible-targets",
      async () => {
        const memberships = await prismadb.targetsToTargetLists.findMany({
          where: { target_list_id: pendingList.id },
          include: {
            target: {
              select: {
                id: true,
                email: true,
                first_name: true,
                last_name: true,
                created_on: true,
                deletedAt: true,
              },
            },
          },
        });

        return memberships
          .filter((m: any) => {
            const t = m.target;
            if (!t.email || t.deletedAt) return false;
            if (!t.created_on || new Date(t.created_on) > cutoff) return false;
            return true;
          })
          .map((m: any) => ({
            id: m.target.id,
            email: m.target.email!,
          }));
      }
    );

    if (eligibleTargets.length === 0) {
      return { dispatched: 0, reason: "no eligible targets (all too recent)" };
    }

    const newTargets: Array<{ id: string; email: string }> = await step.run(
      "filter-already-sent",
      async () => {
        const alreadySent = await prismadb.crm_campaign_sends.findMany({
          where: {
            target_id: { in: eligibleTargets.map((t: { id: string }) => t.id) },
            campaign: { tags: { has: POST_PURCHASE_TAG } },
          },
          select: { target_id: true },
        });
        const sentIds = new Set(alreadySent.map((s: any) => s.target_id));
        return eligibleTargets.filter((t: { id: string }) => !sentIds.has(t.id));
      }
    );

    if (newTargets.length === 0) {
      return { dispatched: 0, reason: "all eligible targets already sent" };
    }

    const today = new Date().toISOString().slice(0, 10);

    const template = await step.run("find-template", async () => {
      return prismadb.crm_campaign_templates.findFirst({
        where: { tags: { has: POST_PURCHASE_TAG } },
        select: { id: true, subject_default: true, content_html: true },
      });
    });

    if (!template) {
      return {
        dispatched: 0,
        reason: `no template tagged "${POST_PURCHASE_TAG}" found — create one first`,
      };
    }

    const batchList = await step.run("create-batch-list", async () => {
      const list = await prismadb.crm_TargetLists.create({
        data: {
          name: `Post-Purchase Batch ${today}`,
          description: `Auto-generated batch for ${newTargets.length} targets on ${today}`,
        },
        select: { id: true },
      });
      await prismadb.targetsToTargetLists.createMany({
        data: newTargets.map((t: { id: string }) => ({
          target_id: t.id,
          target_list_id: list.id,
        })),
        skipDuplicates: true,
      });
      return list;
    });

    const campaign = await step.run("create-campaign", async () => {
      return prismadb.crm_campaigns.create({
        data: {
          v: 0,
          name: `Post-Purchase Email — ${today}`,
          description: `Automated post-purchase email for ${newTargets.length} targets`,
          status: "scheduled",
          template_id: template.id,
          tags: [POST_PURCHASE_TAG],
          target_lists: {
            create: { target_list_id: batchList.id },
          },
          steps: {
            create: {
              order: 0,
              template_id: template.id,
              subject: template.subject_default || "Your post-purchase materials",
              content_html: template.content_html || "",
              delay_days: 0,
              send_to: "all",
            },
          },
        },
        select: { id: true },
      });
    });

    const step0 = await step.run("get-step-0", async () => {
      return prismadb.crm_campaign_steps.findFirst({
        where: { campaign_id: campaign.id, order: 0 },
      });
    });

    const sendRecords = await step.run("create-send-records", async () => {
      await prismadb.crm_campaign_sends.createMany({
        data: newTargets.map((t: { id: string; email: string }) => ({
          campaign_id: campaign.id,
          step_id: step0!.id,
          target_id: t.id,
          email: t.email,
          unsubscribe_token: randomUUID(),
        })),
        skipDuplicates: true,
      });
      return prismadb.crm_campaign_sends.findMany({
        where: { step_id: step0!.id },
        select: { id: true },
      });
    });

    await step.run("mark-sending", async () => {
      return prismadb.crm_campaigns.update({
        where: { id: campaign.id },
        data: { status: "sending" },
      });
    });

    await step.sendEvent(
      "fan-out-sends",
      sendRecords.map((s: { id: string }) => ({
        name: "campaigns/send-step" as const,
        data: { sendId: s.id, campaignId: campaign.id },
      }))
    );

    await step.run("move-to-sent-list", async () => {
      let sentList = await prismadb.crm_TargetLists.findFirst({
        where: { name: SENT_LIST_NAME, deletedAt: null },
        select: { id: true },
      });
      if (!sentList) {
        sentList = await prismadb.crm_TargetLists.create({
          data: {
            name: SENT_LIST_NAME,
            description:
              "Targets that have received their post-purchase email.",
          },
          select: { id: true },
        });
      }

      const targetIds = newTargets.map((t: { id: string }) => t.id);

      await prismadb.targetsToTargetLists.createMany({
        data: targetIds.map((id: string) => ({
          target_id: id,
          target_list_id: sentList.id,
        })),
        skipDuplicates: true,
      });

      await prismadb.targetsToTargetLists.deleteMany({
        where: {
          target_list_id: pendingList.id,
          target_id: { in: targetIds },
        },
      });
    });

    return {
      dispatched: sendRecords.length,
      campaignId: campaign.id,
      batchListId: batchList.id,
      batchDate: today,
    };
  }
);
