import { NextResponse } from "next/server";
import { requireUser, ApiError } from "@/lib/auth";
import { handleRouteError, jsonError, rateLimit, clientKey } from "@/lib/api";
import { prisma } from "@/lib/db";
import { validateImage, saveImage, publicUrlForKey, readImage, inspectUploadImage } from "@/lib/storage";
import { verifyResolution, notifyCitizen, escalateComplaint } from "@/lib/agent/tools";
import { verificationResultFor, decisionForVerification } from "@/lib/visionStates";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/complaints/:id/verify — worker submits "after" evidence.
 * The AI never blindly accepts a worker's claim: it inspects the image and
 * returns a structured verdict which decides the outcome (Phase 4 states):
 *
 *   VERIFIED     → RESOLVED (karma reward, citizen notified)
 *   FAILED       → REOPENED (+ escalation for repeated/high-severity failures)
 *   INCONCLUSIVE → case HOLDS at VERIFICATION — no approval, no punish
 *   UNAVAILABLE  → case HOLDS at VERIFICATION — verifier could not run
 *
 * Fail-safe rule (B10): only an explicit VERIFIED result can approve a repair.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await params;
    if (!rateLimit(clientKey(req, "verify"), 12, 5 * 60_000)) {
      return jsonError(429, "Too many verification submissions. Please wait.");
    }

    const complaint = await prisma.complaint.findUnique({ where: { id } });
    if (!complaint) return jsonError(404, "Complaint not found");
    if (complaint.assignedToId !== user.id && user.role !== "OFFICIAL") {
      throw new ApiError(403, "Only the assigned worker can submit resolution evidence");
    }
    if (!["IN_PROGRESS", "ASSIGNED", "REOPENED", "VERIFICATION"].includes(complaint.status)) {
      return jsonError(409, `Cannot submit evidence while status is ${complaint.status}`);
    }

    const form = await req.formData();
    const afterFile = form.get("afterImage");
    const note = (form.get("note") as string) || undefined;
    if (!(afterFile instanceof File) || afterFile.size === 0) {
      return jsonError(400, "A resolution photo is required");
    }
    const v = validateImage(afterFile);
    if (!v.ok) throw new ApiError(400, v.error);
    // Content-level check: client MIME alone is not trusted (Phase 4 B5).
    const magic = await inspectUploadImage(afterFile);
    if (!magic.ok) throw new ApiError(400, magic.error);

    const resolutionKey = await saveImage(afterFile, "resolution");
    await prisma.complaint.update({
      where: { id },
      data: { status: "VERIFICATION", submittedAt: new Date(), resolutionKey },
    });
    await prisma.timelineEvent.create({
      data: {
        complaintId: id, type: "EVIDENCE", actor: `worker:${user.name}`,
        title: "Resolution evidence submitted",
        detail: note ? `Worker note: ${note}` : "After-resolution photo uploaded for AI verification",
      },
    });

    // Load before-image (bytes + MIME) for comparison if available.
    // The MIME type must travel with the bytes so the real YOLO verifier can
    // form a valid multipart part for the BEFORE image (regression: it was
    // hardcoded to null, silently disabling before/after comparison).
    let beforeImage: Buffer | null = null;
    let beforeMime: string | null = null;
    if (complaint.photoKey) {
      const img = await readImage(complaint.photoKey);
      if (img) {
        beforeImage = img.bytes;
        beforeMime = img.mime;
      }
    }

    const runId = `verify_${Date.now().toString(36)}`;
    const logA = (agent: string, action: string, summary: string, detail?: unknown) =>
      prisma.agentActivity.create({ data: { complaintId: id, runId, agent, action, summary, detail: detail ? JSON.stringify(detail) : null } });

    await logA("VerificationAgent", "verify_resolution:start", `Analyzing after-resolution image for ${complaint.refCode}`, {
      providerHint: process.env.YOLO_SERVICE_URL ? "yolo-service" : "dev:heuristic",
      beforeImageAvailable: Boolean(beforeImage),
    });

    const verdict = await verifyResolution({
      category: complaint.category,
      originalDescription: complaint.description,
      beforeImage,
      beforeMime,
      afterImage: Buffer.from(await afterFile.arrayBuffer()),
      afterMime: afterFile.type,
    });

    // Explicit structured state — never a bare true/false. Providers that
    // predate the structured field are mapped by the fail-safe derivation.
    const result = verdict.verificationResult ?? verificationResultFor(verdict);
    // Outcome policy is centralized + unit-tested (src/lib/visionStates.ts).
    const decision = decisionForVerification(result, {
      reopenedCount: complaint.reopenedCount,
      severity: complaint.severity,
    });

    await logA("VerificationAgent",
      result === "VERIFIED" ? "verify_resolution:pass" : `verify_resolution:${result.toLowerCase()}`,
      `Verification ${result} (${(verdict.confidence * 100).toFixed(0)}% ${verdict.confidenceKind ?? "unknown"}-kind confidence) — ${verdict.reason}`,
      { provider: verdict.provider, confidence: verdict.confidence, confidenceKind: verdict.confidenceKind ?? null, reason: verdict.reason, result, beforeMime }
    );

    if (result === "VERIFIED") {
      const updated = await prisma.complaint.update({
        where: { id },
        data: {
          status: "RESOLVED",
          verified: true,
          verificationResult: "VERIFIED",
          verificationConfidence: verdict.confidence,
          verificationReason: verdict.reason,
          verificationProvider: verdict.provider,
          verifiedAt: new Date(),
          resolvedAt: new Date(),
          isOverdue: false,
        },
      });
      await prisma.timelineEvent.create({
        data: {
          complaintId: id, type: "VERIFICATION", actor: `agent:VerificationAgent`,
          title: `AI verified resolution — marked RESOLVED`,
          detail: `${verdict.reason} (provider ${verdict.provider}, confidence ${(verdict.confidence * 100).toFixed(0)}%)`,
        },
      });
      // Reward the citizen for a verified, genuine report (karma system, P2 but cheap here).
      await prisma.user.update({ where: { id: complaint.reporterId }, data: { karma: { increment: 10 } } });
      await notifyCitizen(id, `Complaint ${complaint.refCode} RESOLVED`, "AI verified the repair. Thank you for reporting!");
      await logA("DispatchAgent", "notify_citizen", `Citizen notified: ${complaint.refCode} resolved`);
      return NextResponse.json({
        verdict: { ...verdict, verificationResult: result },
        status: updated.status,
        resolutionUrl: publicUrlForKey(resolutionKey),
      });
    }

    if (result === "FAILED") {
      // Not verified → REOPENED, and escalate if repeated failures or high severity.
      let status = "REOPENED";
      const reopenedCount = complaint.reopenedCount + 1;
      await prisma.complaint.update({
        where: { id },
        data: {
          status: "REOPENED",
          verified: false,
          verificationResult: "FAILED",
          verificationConfidence: verdict.confidence,
          verificationReason: verdict.reason,
          verificationProvider: verdict.provider,
          reopenedCount,
        },
      });
      await prisma.timelineEvent.create({
        data: {
          complaintId: id, type: "VERIFICATION", actor: "agent:VerificationAgent",
          title: `AI could NOT verify resolution — complaint REOPENED`,
          detail: verdict.reason,
        },
      });
      await notifyCitizen(id, `Complaint ${complaint.refCode} reopened`, "Our AI could not confirm the repair. The case was reopened for another attempt.");

      if (decision.escalate) {
        const esc = await escalateComplaint(id, "AI verification failed — escalating for supervisory review");
        status = esc.status;
        await prisma.timelineEvent.create({
          data: { complaintId: id, type: "ESCALATION", actor: "agent:VerificationAgent", title: `Escalated (level ${esc.escalationCount})`, detail: "Repeated verification failure" },
        });
        await logA("SLAAgent", "escalate_complaint", `${complaint.refCode} escalated to level ${esc.escalationCount}`);
      }

      return NextResponse.json({
        verdict: { ...verdict, verificationResult: result },
        status,
        resolutionUrl: publicUrlForKey(resolutionKey),
      });
    }

    // INCONCLUSIVE or UNAVAILABLE — fail safe: the case HOLDS at VERIFICATION.
    // No auto-approval, no punishment, no karma change; an official (or a
    // re-run once evidence/the verifier recovers) decides what happens next.
    await prisma.complaint.update({
      where: { id },
      data: {
        verified: false,
        verificationResult: result,
        verificationConfidence: null,
        verificationReason: verdict.reason,
        verificationProvider: verdict.provider,
      },
    });
    await prisma.timelineEvent.create({
      data: {
        complaintId: id, type: "VERIFICATION", actor: "agent:VerificationAgent",
        title: result === "UNAVAILABLE"
          ? `Verification service unavailable — case held for manual review`
          : `Verification inconclusive — case held for manual review`,
        detail: verdict.reason,
      },
    });
    await notifyCitizen(
      id,
      `Complaint ${complaint.refCode} is being reviewed`,
      result === "UNAVAILABLE"
        ? "Our verification system is temporarily unavailable. Your report is queued for manual review — no action needed."
        : "The resolution photo could not be conclusively evaluated. Your report is queued for manual review."
    );

    return NextResponse.json({
      verdict: { ...verdict, verificationResult: result },
      status: "VERIFICATION",
      resolutionUrl: publicUrlForKey(resolutionKey),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
