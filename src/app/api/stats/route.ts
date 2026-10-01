import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { checkSla } from "@/lib/agent/tools";

export const runtime = "nodejs";

let lastSweep = 0;

/** GET /api/stats — aggregate dashboard metrics for officials. */
export async function GET(req: Request) {
  try {
    await requireRole(req, "OFFICIAL");

    // Lazily run the SLA sweep at most once per minute so dashboard loads
    // surface overdue/escalated complaints without needing a scheduler.
    const now = Date.now();
    let sweep: Awaited<ReturnType<typeof checkSla>> = [];
    if (now - lastSweep > 60_000) {
      lastSweep = now;
      try {
        sweep = await checkSla();
      } catch (e) {
        console.error("[stats] SLA sweep failed:", e);
      }
    }

    const [total, open, inProgress, verification, resolved, escalated, overdue, reopened] = await Promise.all([
      prisma.complaint.count(),
      prisma.complaint.count({ where: { status: { in: ["RECEIVED", "ASSIGNED"] } } }),
      prisma.complaint.count({ where: { status: "IN_PROGRESS" } }),
      prisma.complaint.count({ where: { status: "VERIFICATION" } }),
      prisma.complaint.count({ where: { status: { in: ["RESOLVED", "CLOSED"] } } }),
      prisma.complaint.count({ where: { status: "ESCALATED" } }),
      prisma.complaint.count({ where: { isOverdue: true, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
      prisma.complaint.count({ where: { status: "REOPENED" } }),
    ]);

    const byCategory = await prisma.complaint.groupBy({ by: ["category"], _count: { _all: true } });
    const byDepartment = await prisma.complaint.groupBy({ by: ["departmentId"], _count: { _all: true }, where: { departmentId: { not: null } } });
    const depts = await prisma.department.findMany();

    return NextResponse.json({
      totals: { total, open, inProgress, verification, resolved, escalated, overdue, reopened },
      byCategory: byCategory.map((c) => ({ category: c.category, count: c._count._all })),
      byDepartment: byDepartment.map((d) => ({
        department: depts.find((x) => x.id === d.departmentId)?.code ?? "GEN",
        count: d._count._all,
      })),
      slaSweep: sweep,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
