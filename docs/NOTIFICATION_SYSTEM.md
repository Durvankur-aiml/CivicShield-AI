# CivicShield AI — In-App Notification System (Phase 3)

> **Provider status:** IN-APP = **VERIFIED** (unit-tested, mocked Prisma
> boundary) · EMAIL = **NOT IMPLEMENTED** · SMS = **NOT IMPLEMENTED** ·
> PUSH = **NOT IMPLEMENTED**. There is no external provider in this
> repository and none is faked.

Implementation: `src/lib/notificationDomain.ts` · Model: `Notification`
(`prisma/schema.prisma`) · Types: `NOTIFICATION_TYPES` in
`src/lib/constants.ts`.

## Concept separation

| Concern | Storage |
|---|---|
| Operational state (assignments, lifecycle) | `Assignment`, `Complaint` |
| Messages delivered to a recipient | **`Notification`** |
| Timing / escalation state | derived (see `SLA_ESCALATION.md`) |
| Audit / history | `AgentActivity`, `TimelineEvent` |

Notifications are created **only from real domain events** — assignment
offered/accepted/rejected/reassigned/started/completed, SLA warning/breach,
escalation, official override — never merely because a route was called.

## Model

```
Notification
  recipientId → User   (relation, onDelete: Cascade)
  type        String   (validated string tuple, repo convention)
  title, body
  complaintId → Complaint?  ·  assignmentId → Assignment?
  dedupeKey   String?  @unique  ← idempotency guarantee
  data        String?  (optional JSON metadata, repo convention)
  readAt      DateTime? · createdAt
  @@index([recipientId, readAt])  @@index([complaintId])
```

## Idempotency (database-enforced)

Every event-scoped notification carries a deterministic `dedupeKey`
(`notificationKeys` map, e.g. `assignment:offered:<assignmentId>`,
`sla:warning:<assignmentId>`, `escalation:<complaintId>:<level>`). The UNIQUE
constraint means a retried action or a repeated cron sweep **cannot** create a
duplicate: the winner inserts, every other attempt hits P2002 and is a silent
no-op in `send()`. Keys without a natural event identity use `dedupeKey: null`
— Postgres unique indexes allow multiple NULLs, so non-event messages are
always created. `sendMany` uses `createMany + skipDuplicates` for batches.

## Read lifecycle & ownership

- `GET /api/notifications` (`?unread=true&limit=n`) — list + `unreadCount`,
  scoped by **session identity**; no client-controlled recipient exists.
- `POST /api/notifications { id }` — mark one read (404 for anyone else's
  notification — same error as unknown id, no existence leak; idempotent).
- `POST /api/notifications { all: true }` — mark all read (`updateMany`
  scoped server-side by `recipientId`).

## Payload (privacy)

`toPublicNotification` exposes exactly: `id, type, title, body, complaintId,
assignmentId, readAt, createdAt`. No phone numbers, emails, employee IDs,
coordinates, or internal `data` metadata leave the server.

## Provider boundary

`send(db, n)` / `sendMany(db, rows)` are the single seam. Future
EmailProvider/SMSProvider/PushProvider implementations would attach there —
nothing is fabricated in the meantime.
