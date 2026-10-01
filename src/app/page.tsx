import Link from "next/link";
import { prisma } from "@/lib/db";
import { aiProviderStatus } from "@/lib/ai";
import { Logo, ShieldMark } from "@/components/Logo";

export const dynamic = "force-dynamic";

const PIPELINE = [
  { agent: "VisionAgent", icon: "👁", tool: "analyze_image", text: "Photo + GPS + voice/text arrive from the citizen" },
  { agent: "TriageAgent", icon: "🧠", tool: "classify · severity · priority", text: "Structured classification with explainable scoring" },
  { agent: "DuplicateAgent", icon: "🧭", tool: "detect_duplicate", text: "Links related reports — no duplicate cases" },
  { agent: "RoutingAgent", icon: "🚀", tool: "find_department", text: "Routes to the responsible department" },
  { agent: "DispatchAgent", icon: "📮", tool: "create · notify", text: "Case created, SLA clock starts, citizen notified" },
  { agent: "VerificationAgent", icon: "✅", tool: "verify_resolution", text: "AI checks the repair before a case closes" },
];

/**
 * Landing aggregates degrade gracefully: with the database unreachable or
 * slow, the page still renders quickly — counts are shown as zero WITH an
 * explicit "live data unavailable" note, never as fake live numbers.
 * The probe is bounded so an unreachable DB cannot stall the page.
 */
const DB_PROBE_MS = 800;

function findRecentActivities() {
  return prisma.agentActivity.findMany({
    orderBy: { createdAt: "desc" },
    take: 4,
    include: { complaint: { select: { refCode: true } } },
  });
}

async function landingStats() {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), DB_PROBE_MS));
  const query = (async () => {
    const [total, resolved, open, activities] = await Promise.all([
      prisma.complaint.count(),
      prisma.complaint.count({ where: { status: { in: ["RESOLVED", "CLOSED"] } } }),
      prisma.complaint.count({ where: { status: { in: ["RECEIVED", "ASSIGNED", "IN_PROGRESS", "VERIFICATION", "REOPENED", "ESCALATED"] } } }),
      findRecentActivities(),
    ]);
    return { total, resolved, open, activities } as const;
  })();
  try {
    const result = await Promise.race([query, timeout]);
    if (!result) throw new Error("database probe timed out");
    return { ...result, activities: result.activities, dbOk: true };
  } catch {
    return { total: 0, resolved: 0, open: 0, activities: [] as Awaited<ReturnType<typeof findRecentActivities>>, dbOk: false };
  }
}

export default async function LandingPage() {
  // Real numbers only — small, honest aggregate for the City Intelligence panel.
  const { total, resolved, open, activities, dbOk } = await landingStats();
  const providers = aiProviderStatus();
  const empty = total === 0;

  return (
    <div className="min-h-screen">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-cs-border bg-cs-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-6 text-sm text-cs-secondary md:flex" aria-label="Marketing">
            <a href="#how" className="transition hover:text-cs-text">How it works</a>
            <a href="#roles" className="transition hover:text-cs-text">Roles</a>
            <a href="#honest" className="transition hover:text-cs-text">Honest AI</a>
          </nav>
          <div className="flex items-center gap-2 text-sm">
            <Link href="/login" className="cs-btn cs-btn-primary !py-1.5">Sign in with Google</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* Hero */}
        <section className="grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="cs-fade-up">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-400">Agentic AI civic-response platform</p>
            <h1 className="mt-4 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-[56px]">
              Report a problem.
              <br />
              Let AI get it to
              <br />
              the right team.
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-cs-secondary">
              Report potholes, garbage, waterlogging and other civic issues with a photo, voice or
              text. CivicShield analyzes your report, detects duplicates and routes it to the
              appropriate department — then verifies the fix before closing the case.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/citizen/submit" className="cs-btn cs-btn-primary !px-5 !py-2.5">
                Report an Issue
              </Link>
              <Link href="/citizen" className="cs-btn cs-btn-secondary !px-5 !py-2.5">
                Track My Reports
              </Link>
            </div>
            <p className="mt-6 flex items-center gap-2 text-xs text-cs-secondary">
              <ShieldMark size={16} /> From citizen complaint to verified civic action.
            </p>
          </div>

          {/* City Intelligence panel — real data */}
          <div className="cs-card cs-fade-up overflow-hidden" style={{ animationDelay: "120ms" }} id="intelligence">
            <div className="flex items-center justify-between border-b border-cs-border px-5 py-3.5">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-cs-secondary">City Intelligence</span>
              <span className="cs-pulse-dot h-2 w-2 rounded-full bg-emerald-400" aria-label="live" />
            </div>
            {!dbOk && (
              <p className="border-b border-amber-400/20 bg-amber-500/10 px-5 py-2 text-[11px] text-amber-200">
                ⚠ Live database unreachable — counts below are not current data.
              </p>
            )}
            <div className="grid grid-cols-3 divide-x divide-cs-border border-b border-cs-border">
              <Cell label="Reports" value={total} tone="text-cs-text" />
              <Cell label="Active" value={open} tone="text-sky-300" />
              <Cell label="Resolved" value={resolved} tone="text-emerald-300" />
            </div>
            <div className="px-5 py-4">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">Latest agent decisions</div>
              {empty || activities.length === 0 ? (
                <p className="py-3 text-sm text-cs-secondary">
                  No reports yet — the pipeline lights up as soon as the first one arrives.
                </p>
              ) : (
                <ul className="space-y-3">
                  {activities.map((a) => (
                    <li key={a.id} className="flex items-start gap-2.5 text-sm">
                      <span aria-hidden className="mt-0.5">{a.agent === "VisionAgent" ? "👁" : a.agent === "TriageAgent" ? "🧠" : a.agent === "DuplicateAgent" ? "🧭" : a.agent === "RoutingAgent" ? "🚀" : a.agent === "VerificationAgent" ? "✅" : a.agent === "SLAAgent" ? "⏰" : "📮"}</span>
                      <span className="min-w-0 flex-1 text-slate-300">
                        {a.summary}
                        {a.complaint?.refCode && <span className="ml-1 text-xs text-cs-secondary/70">{a.complaint.refCode}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* Pipeline */}
        <section id="how" className="py-12">
          <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">One orchestrated agent pipeline, not a chatbot</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-[15px] text-cs-secondary">
            Every decision is made by a named agent executing real tools — and every decision is
            logged to an activity panel you can audit.
          </p>
          <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PIPELINE.map((s, i) => (
              <li key={s.agent} className="cs-card cs-card-hover cs-fade-up p-5" style={{ animationDelay: `${i * 70}ms` }}>
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-xl border border-sky-400/25 bg-sky-500/10 text-base" aria-hidden>
                    {s.icon}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-cs-text">{s.agent}</div>
                    <div className="font-mono text-[11px] text-cs-secondary/80">{s.tool}</div>
                  </div>
                  <span className="ml-auto text-[11px] font-semibold text-cs-secondary/60">0{i + 1}</span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-cs-secondary">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Roles */}
        <section id="roles" className="grid gap-4 py-8 md:grid-cols-3">
          <RoleCard icon="🧑‍💼" title="Citizen" points={["Photo + voice + GPS reporting", "Duplicate-aware submissions", "Live status & agent decisions", "Karma for verified reports"]} />
          <RoleCard icon="🏛" title="Official" points={["City risk map & filters", "Priority queue with SLA clocks", "Worker assignment", "Overdue / escalation alerts"]} />
          <RoleCard icon="🛠" title="Field worker" points={["Assigned task list", "Citizen evidence on-site", "Submit resolution photo", "AI verification of the repair"]} />
        </section>

        {/* Transparency + demo credentials */}
        <section id="honest" className="grid gap-4 py-8 md:grid-cols-2">
          <div className="cs-card p-6">
            <h3 className="font-semibold text-cs-text">Honest AI — always labeled</h3>
            <p className="mt-2 text-sm leading-relaxed text-cs-secondary">
              Production providers (YOLOv8 service, Amazon Bedrock) are used when configured.
              Otherwise clearly-labeled development providers keep the pipeline demonstrable — and
              every result carries its provider label. Production AI results are never faked.
            </p>
            <ul className="mt-4 space-y-1.5 font-mono text-xs text-cs-secondary">
              <li>vision: <span className="text-sky-300">{providers.vision}</span></li>
              <li>llm: <span className="text-sky-300">{providers.llm}</span></li>
              <li>verifier: <span className="text-sky-300">{providers.verifier}</span></li>
            </ul>
          </div>
          <div className="rounded-[18px] border border-sky-400/25 bg-sky-500/[0.07] p-6">
            <h3 className="font-semibold text-sky-200">Sign in with Google</h3>
            <p className="mt-3 text-sm leading-relaxed text-sky-200/90">
              One secure sign-in for citizens, officials and field workers — your Google account
              is your identity. Access is verified server-side on every request.
            </p>
            <p className="mt-3 text-xs leading-relaxed text-sky-300/80">
              Seeded demo records are always marked <strong>DEMO</strong> in the UI. Everything
              submitted during a demo is real data created in that moment.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-cs-border py-8 text-center text-xs text-cs-secondary/70">
        CivicShield AI — an original implementation inspired by civic-AI design patterns. Built with open-source libraries.
      </footer>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="px-4 py-4 text-center">
      <div className={`text-2xl font-semibold tracking-tight ${tone}`}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] text-cs-secondary">{label}</div>
    </div>
  );
}

function RoleCard({ icon, title, points }: { icon: string; title: string; points: string[] }) {
  return (
    <div className="cs-card cs-card-hover cs-fade-up p-6">
      <span className="grid h-10 w-10 place-items-center rounded-xl border border-cs-border bg-cs-elevated text-lg" aria-hidden>
        {icon}
      </span>
      <h3 className="mt-4 font-semibold text-cs-text">{title}</h3>
      <ul className="mt-3 space-y-2 text-sm text-cs-secondary">
        {points.map((p) => (
          <li key={p} className="flex gap-2">
            <span className="text-emerald-400" aria-hidden>✓</span>
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}
