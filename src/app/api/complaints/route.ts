import { NextResponse } from "next/server";
import { requireUser, ApiError } from "@/lib/auth";
import { handleRouteError, jsonError, rateLimit, clientKey } from "@/lib/api";
import { complaintInput, CATEGORIES, STATUSES, SEVERITIES, DEPARTMENT_CODES } from "@/lib/constants";
import { validateImage, saveImage, inspectUploadImage } from "@/lib/storage";
import { orchestrateNewComplaint } from "@/lib/agent/orchestrator";
import { validateLat, validateLng, parseCoordinateField, normalizeLocation } from "@/lib/location";
import { describeCoordinatesCached } from "@/lib/geocode";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST /api/complaints — citizen submits a complaint (multipart). */
export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    if (!rateLimit(clientKey(req, "complaint-create"), 6, 5 * 60_000)) {
      return jsonError(429, "Submission rate limit reached. Please wait a few minutes.");
    }

    const form = await req.formData();
    // Phase 4: coordinates are validated at the domain boundary BEFORE zod so
    // NaN / Infinity / garbage strings become an explicit 400 with a
    // machine-readable code instead of a generic validation error. Absent /
    // empty fields are simply absent — never coerced to 0 or a demo center.
    const latRaw = parseCoordinateField(form.get("lat"));
    const lngRaw = parseCoordinateField(form.get("lng"));
    if (latRaw === null || lngRaw === null) {
      return jsonError(400, "Invalid coordinates", { code: "INVALID_COORDINATES" });
    }
    if ((latRaw !== undefined && validateLat(latRaw) === null) || (lngRaw !== undefined && validateLng(lngRaw) === null)) {
      return jsonError(400, "Coordinates out of range (lat −90..90, lng −180..180)", { code: "INVALID_COORDINATES" });
    }
    const raw = {
      description: String(form.get("description") ?? ""),
      category: (form.get("categoryHint") as string) || undefined,
      lat: latRaw,
      lng: lngRaw,
      // Honest GPS capture metadata — clamped/normalized in the domain layer.
      accuracyMeters:
        form.get("accuracyMeters") != null && form.get("accuracyMeters") !== ""
          ? Number(form.get("accuracyMeters"))
          : undefined,
      locationSource: (form.get("locationSource") as string) || undefined,
      locationCapturedAt: form.get("locationCapturedAt") ? new Date(String(form.get("locationCapturedAt"))) : undefined,
      address: (form.get("address") as string) || undefined,
      ward: (form.get("ward") as string) || undefined,
      language: (form.get("language") as string) || "en",
      transcript: (form.get("transcript") as string) || undefined,
      source: (form.get("source") as string) || "CITIZEN",
    };
    const input = complaintInput.parse(raw);

    // File validation (type + size), then persist via storage abstraction.
    let photo: { buffer: Buffer; mime: string; key?: string; demoHint?: string } | null = null;
    const photoFile = form.get("photo");
    if (photoFile instanceof File && photoFile.size > 0) {
      const v = validateImage(photoFile);
      if (!v.ok) throw new ApiError(400, v.error);
      // Content-level check: client MIME alone is not trusted (Phase 4 B5).
      const magic = await inspectUploadImage(photoFile);
      if (!magic.ok) throw new ApiError(400, magic.error);
      const key = await saveImage(photoFile, "report");
      photo = {
        buffer: Buffer.from(await photoFile.arrayBuffer()),
        mime: photoFile.type,
        key,
        demoHint: (form.get("demoHint") as string) || undefined,
      };
    }

    // Reverse geocoding is best-effort address METADATA only (Phase 4): it can
    // add an address, never modify the submitted coordinates, and its failure
    // never blocks or degrades the complaint.
    const authoritative =
      input.lat != null && input.lng != null
        ? normalizeLocation({
            lat: input.lat,
            lng: input.lng,
            accuracyMeters: input.accuracyMeters ?? null,
            source: input.locationSource,
            capturedAt: input.locationCapturedAt ?? null,
          })
        : null;
    if (authoritative && !input.address) {
      const described = await describeCoordinatesCached({ lat: authoritative.lat, lng: authoritative.lng });
      if (described) {
        input.address = described.address;
        if (!input.ward && described.ward) input.ward = described.ward;
      }
    }

    const result = await orchestrateNewComplaint({
      description: input.description,
      categoryHint: input.category && CATEGORIES.includes(input.category as (typeof CATEGORIES)[number]) ? input.category : undefined,
      lat: authoritative ? authoritative.lat : null,
      lng: authoritative ? authoritative.lng : null,
      accuracyMeters: authoritative ? authoritative.accuracyMeters : null,
      locationSource: authoritative ? authoritative.source : null,
      locationCapturedAt: authoritative ? authoritative.capturedAt : null,
      address: input.address,
      ward: input.ward,
      language: input.language,
      transcript: input.transcript,
      photo,
      reporterId: user.id,
      source: input.source,
    });

    return NextResponse.json({ complaint: result }, { status: 201 });
  } catch (err) {
    return handleRouteError(err);
  }
}

/** GET /api/complaints — filtered, role-scoped list. */
export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") ?? (user.role === "WORKER" ? "assigned" : user.role === "OFFICIAL" ? "all" : "mine");
    const status = url.searchParams.get("status");
    const category = url.searchParams.get("category");
    const severity = url.searchParams.get("severity");
    const department = url.searchParams.get("department");
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 100));

    const where: Record<string, unknown> = {};
    if (scope === "mine") where.reporterId = user.id;
    else if (scope === "assigned") where.assignedToId = user.id;
    else if (user.role !== "OFFICIAL") throw new ApiError(403, "Citizens can only view their own complaints");
    // officials with scope=all see everything

    if (status && STATUSES.includes(status as (typeof STATUSES)[number])) where.status = status;
    if (category && CATEGORIES.includes(category as (typeof CATEGORIES)[number])) where.category = category;
    if (severity && SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) where.severity = severity;
    if (department && DEPARTMENT_CODES.includes(department as (typeof DEPARTMENT_CODES)[number])) {
      const dept = await prisma.department.findUnique({ where: { code: department } });
      where.departmentId = dept?.id ?? "none";
    }

    const complaints = await prisma.complaint.findMany({
      where,
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        id: true, refCode: true, title: true, category: true, severity: true, priority: true,
        status: true, lat: true, lng: true, address: true, ward: true, createdAt: true,
        slaDueAt: true, isOverdue: true, escalationCount: true, source: true,
        department: { select: { code: true, name: true } },
        reporter: { select: { name: true } },
        assignedTo: { select: { id: true, name: true } },
        duplicateOf: { select: { refCode: true } },
        photoKey: true,
      },
    });

    return NextResponse.json({ complaints });
  } catch (err) {
    return handleRouteError(err);
  }
}
