import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/api";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const record = await prisma.user.findUnique({ where: { id: user.id }, select: { karma: true, departmentId: true } });
    return NextResponse.json({ user: { ...user, karma: record?.karma ?? 0, departmentId: record?.departmentId ?? user.departmentId } });
  } catch (err) {
    return handleRouteError(err);
  }
}
