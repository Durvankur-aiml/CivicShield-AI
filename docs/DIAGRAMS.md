# CivicShield AI — Flow & Block Diagrams (PPT-ready)

Everything below is generated from the real codebase (`src/lib/agent/orchestrator.ts`,
`prisma/schema.prisma`, API routes). Mermaid blocks render directly in mermaid.live,
Notion, or GitHub; ASCII versions paste anywhere (PowerPoint text boxes included).

---

## 1. MASTER FLOW DIAGRAM (full user journey)

### Mermaid (paste into https://mermaid.live → export PNG for the slide)

```mermaid
flowchart TD
    A["📱 CITIZEN<br/>Reports civic issue<br/>(photo + voice/text + GPS)"] --> B["🌐 SUBMIT<br/>Next.js form → POST /api/complaints<br/>Auth + validation + image checks"]
    B --> C{"👁 VISION AGENT<br/>analyze_image()<br/>photo attached?"}
    C -- "yes" --> D["YOLOv8 vision service<br/>or labeled dev provider<br/>→ issue + confidence"]
    C -- "no" --> E
    D --> E["🧠 TRIAGE AGENT<br/>classify_issue()<br/>calculate_severity()<br/>calculate_priority()"]
    E --> F["🧭 DUPLICATE AGENT<br/>find_nearby_complaints()<br/>detect_duplicate()"]
    F -- "match found" --> G["⛓ Link as<br/>'Potentially related'<br/>(no duplicate case)"]
    F -- "none" --> H
    G --> H["🚀 ROUTING AGENT<br/>find_department()<br/>POTHOLE→PWD · GARBAGE→SWM<br/>WATER→WATER · LIGHT→ELECT"]
    H --> I["📮 DISPATCH AGENT<br/>create_complaint()<br/>notify_citizen()"]
    I --> J["🗄 DATABASE<br/>Complaint + SLA clock<br/>CS-2026-XXXXXX"]
    J --> K["🏛 OFFICIAL COMMAND CENTER<br/>Risk map · stats · priority queue"]
    K --> L["👷 ASSIGN WORKER<br/>assign_worker()"]
    L --> M["WORKER FLOW<br/>Accept → Start → Repair →<br/>upload resolution evidence"]
    M --> N{"✅ VERIFICATION AGENT<br/>verify_resolution()<br/>AI checks 'after' photo"}
    N -- "verified" --> O["🟢 RESOLVED<br/>case closable"]
    N -- "not verified" --> P["🟠 REOPENED<br/>→ ESCALATED if repeated<br/>+ SLAAgent clock checks"]
    P --> M
    O --> Q["🏁 CLOSED<br/>citizen karma awarded"]
```

### ASCII version (paste anywhere)

```
CITIZEN (photo + voice/text + GPS)
        │
        ▼
SUBMIT ── POST /api/complaints ── auth + validation + image checks
        │
        ▼
VISION AGENT ── analyze_image()          (only if photo attached)
        │        YOLOv8 service / labeled dev provider
        ▼
TRIAGE AGENT ── classify_issue() → category
        │        calculate_severity() → LOW/MED/HIGH/CRITICAL
        │        calculate_priority() → score 1–100 (explainable)
        ▼
DUPLICATE AGENT ── find_nearby_complaints() + detect_duplicate()
        │            match → link "potentially related", no new case
        ▼
ROUTING AGENT ── find_department()
        │          POTHOLE→PWD  GARBAGE→SWM  WATER→WATER  STREETLIGHT→ELECT
        ▼
DISPATCH AGENT ── create_complaint() + notify_citizen()
        │           SLA clock starts (12/24/48/72h by severity)
        ▼
DATABASE (Complaint · TimelineEvent · AgentActivity · Escalation)
        │
        ▼
OFFICIAL COMMAND CENTER ── risk map + stats + priority queue
        │
        ▼
ASSIGN WORKER
        │
        ▼
WORKER: Accept → Start work → repair → upload after-photo
        │
        ▼
VERIFICATION AGENT ── verify_resolution()
        │
   ┌────┴─────────┐
   ▼              ▼
VERIFIED       NOT VERIFIED
   │              │
RESOLVED       REOPENED → ESCALATED → back to worker
   │
CLOSED (+ citizen karma)
```

---

## 2. SYSTEM BLOCK DIAGRAM (architecture layers)

### Mermaid

```mermaid
flowchart LR
    subgraph CLIENT["Client — Next.js 16 · TypeScript · Tailwind v4"]
        C1["Citizen app<br/>report · track · karma"]
        C2["Official Command Center<br/>map · stats · queue"]
        C3["Worker app<br/>tasks · evidence upload"]
    end
    subgraph API["API layer — Next.js Route Handlers"]
        A1["auth: login · register · me<br/>httpOnly cookie sessions"]
        A2["complaints: submit · list · detail<br/>assign · status · verify · escalate"]
        A3["stats · activity · workers<br/>cron/sla · demo/sla"]
    end
    subgraph AGENTS["Agent Orchestrator (src/lib/agent)"]
        G1["VisionAgent"]
        G2["TriageAgent"]
        G3["DuplicateAgent"]
        G4["RoutingAgent"]
        G5["DispatchAgent"]
        G6["VerificationAgent"]
        G7["SLAAgent"]
    end
    subgraph AI["AI provider abstraction (labeled)"]
        P1["Vision: YOLOv8 service<br/>or dev provider"]
        P2["LLM: Amazon Bedrock<br/>or dev rules"]
        P3["Verifier: model/heuristic<br/>(provider id on every result)"]
    end
    subgraph DATA["Data & storage"]
        D1[("Prisma + PostgreSQL<br/>(Supabase in prod)")]
        D2[("File storage<br/>before/after photos")]
        M1["Leaflet + OpenStreetMap<br/>Civic Risk Map"]
    end

    C1 & C2 & C3 --> A1 & A2 & A3
    A2 --> AGENTS
    G1 --> P1
    G2 --> P2
    G6 --> P3
    AGENTS --> D1
    A2 --> D1
    A2 --> D2
    C2 --> M1
    D1 -. "complaint rows" .-> M1
```

### ASCII version

```
┌──────────────────────── CLIENT (Next.js 16 + TS + Tailwind) ───────────────────────┐
│  Citizen app          Official Command Center           Worker app                 │
│  report/track/karma   risk map · stats · queue          tasks · evidence upload    │
└──────────┬──────────────────────┬──────────────────────────────┬────────────────────┘
           │  fetch (httpOnly-cookie auth, JSON)                                      │
┌──────────▼──────────────────────▼──────────────────────────────▼────────────────────┐
│                          API LAYER (Next.js Route Handlers)                          │
│  /api/auth/*   /api/complaints[/id][/assign|status|verify|escalate]                  │
│  /api/stats    /api/activity    /api/official/workers    /api/cron/sla  /api/demo/sla│
└──────────┬───────────────────────────────────────────────────────────────────────────┘
           │
┌──────────▼───────────────── AGENT ORCHESTRATOR ────────────────────────────────────┐
│  VisionAgent → TriageAgent → DuplicateAgent → RoutingAgent → DispatchAgent          │
│                        VerificationAgent · SLAAgent (later in lifecycle)            │
│  every decision persisted to AgentActivity (public decision log)                    │
└──┬──────────────┬──────────────┬──────────────────┬────────────────────────────────┘
   │              │              │                  │
┌──▼───┐     ┌────▼────┐   ┌─────▼──────┐    ┌──────▼───────┐      AI PROVIDERS
│Vision│     │   LLM   │   │ Duplicate  │    │ Verifier     │      (always labeled)
│YOLO/ │     │Bedrock/ │   │ Haversine+ │    │ model /      │
│dev   │     │dev rules│   │ Jaccard    │    │ heuristic    │
└──────┘     └─────────┘   └────────────┘    └──────────────┘
   │              │              │                  │
┌──▼──────────────▼──────────────▼──────────────────▼─────────────────────────────────┐
│  DATA: Prisma + PostgreSQL (Supabase in prod) · file storage · Leaflet + OpenStreetMap  │
│  Models: User · Department · Complaint · TimelineEvent · AgentActivity · Escalation  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. AGENT PIPELINE DETAIL (per-report sequence)

```mermaid
sequenceDiagram
    participant U as Citizen
    participant API as POST /api/complaints
    participant V as VisionAgent
    participant T as TriageAgent
    participant D as DuplicateAgent
    participant R as RoutingAgent
    participant P as DispatchAgent
    participant DB as Database

    U->>API: photo + description + GPS
    API->>V: analyze_image(buffer)
    V-->>API: { category, confidence, provider }
    API->>T: classify_issue(text + vision)
    T-->>API: { category, severity, priority, reasons[] }
    API->>D: nearby + duplicate check
    D-->>API: match? link duplicateOfId
    API->>R: find_department(category)
    R-->>API: departmentCode
    API->>P: create_complaint + notify_citizen
    P->>DB: Complaint + AgentActivity rows
    DB-->>U: refCode CS-2026-XXXXXX + live decision log
```

---

## 4. COMPLAINT LIFECYCLE (state machine)

```
RECEIVED ──assign──► ASSIGNED ──accept/start──► IN_PROGRESS
    │                                             │
    │                                    upload evidence
    │                                             ▼
    │                                        VERIFICATION
    │                                    ┌───────┴────────┐
    │                              verified          not verified
    │                                    ▼                ▼
    │                                RESOLVED ◄────  REOPENED ──► ESCALATED
    │                                    │              (back to worker)  │
    └── overdue SLA ──► OVERDUE ──► ESCALATED ◄───────────────────────────┘
                                         │
                                      CLOSED (+ karma)
```

## 5. SLA RULES (configurable via env)

| Severity | SLA hours | Escalation on breach |
|----------|-----------|----------------------|
| CRITICAL | 12        | overdue sweep → Escalation L1+ |
| HIGH     | 24        | ↑ |
| MEDIUM   | 48        | ↑ |
| LOW      | 72        | ↑ |

## 6. ROUTING TABLE (actual `CATEGORY_DEPARTMENT` map)

| Category | Department |
|----------|------------|
| POTHOLE, ROAD_DAMAGE | PWD — Public Works |
| GARBAGE, WASTE_OVERFLOW | SWM — Solid Waste Mgmt |
| WATERLOGGING | WATER — Water Dept |
| STREETLIGHT | ELECT — Electrical |
| OTHER | GEN — General Municipal |

---

### PPT drawing tips
- Mermaid → PNG: paste each block at mermaid.live, set theme "dark", export at 2x.
- PowerPoint: Insert → Icons for the agent emojis; keep one agent per box, arrows top-to-bottom.
- Colors already used in the app: navy #07111F · surface #0D1B2A · blue #2563EB ·
  emerald #10B981 · amber #F59E0B · red #EF4444 — reuse them for a matching deck.
