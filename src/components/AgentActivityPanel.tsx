"use client";

import { BadgeCheck, Bot, Brain, Copy, Eye, Rocket, Send, Timer, type LucideIcon } from "lucide-react";
import { Card, Skeleton } from "./ui";
import { fmtDateTime } from "@/lib/client";

export type Activity = {
  id: string;
  agent: string;
  action: string;
  summary: string;
  detail: string | null;
  createdAt: string;
  complaint?: { refCode: string } | null;
};

/** Lucide icon + human role per agent (visual only — data unchanged). */
export const AGENT_META: Record<string, { icon: LucideIcon; role: string; tone: string }> = {
  VisionAgent: { icon: Eye, role: "Computer vision", tone: "text-blue-300 border-blue-400/30 bg-blue-500/10" },
  TriageAgent: { icon: Brain, role: "Classification & severity", tone: "text-indigo-300 border-indigo-400/30 bg-indigo-500/10" },
  DuplicateAgent: { icon: Copy, role: "Duplicate intelligence", tone: "text-cyan-300 border-cyan-400/30 bg-cyan-500/10" },
  RoutingAgent: { icon: Rocket, role: "Department routing", tone: "text-teal-300 border-teal-400/30 bg-teal-500/10" },
  DispatchAgent: { icon: Send, role: "Intake & notifications", tone: "text-blue-300 border-blue-400/30 bg-blue-500/10" },
  VerificationAgent: { icon: BadgeCheck, role: "Resolution verification", tone: "text-amber-300 border-amber-400/30 bg-amber-500/10" },
  SLAAgent: { icon: Timer, role: "SLA & escalation", tone: "text-red-300 border-red-400/30 bg-red-500/10" },
};

/**
 * Agent Activity panel — rendered from the persisted AgentActivity table
 * (server-side decisions), styled as a connected pipeline. Concise decision
 * factors only; no hidden chain-of-thought exists in the data.
 */
export function AgentActivityPanel({
  activities,
  title = "Agent Activity",
  loading = false,
}: {
  activities: Activity[];
  title?: string;
  loading?: boolean;
}) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="cs-pulse-dot h-2 w-2 rounded-full bg-blue-400" aria-hidden />
        <h3 className="text-sm font-semibold text-cs-text">{title}</h3>
      </div>

      {loading ? (
        <div className="mt-4 space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : activities.length === 0 ? (
        <p className="mt-3 text-sm text-cs-secondary">No agent decisions recorded for this case{title.includes("this report") ? "" : " — live submissions run the full agent pipeline."}</p>
      ) : (
        <ol className="relative mt-4 space-y-5 pl-1">
          {/* connecting line */}
          <span aria-hidden className="absolute bottom-3 left-[15px] top-3 w-px bg-gradient-to-b from-blue-400/40 via-cs-border to-transparent" />
          {activities.map((a, idx) => {
            const meta = AGENT_META[a.agent] ?? {
              icon: Bot,
              role: "Agent",
              tone: "text-slate-300 border-slate-400/30 bg-slate-500/10",
            };
            return (
              <li key={a.id} className="cs-fade-up relative flex gap-3" style={{ animationDelay: `${Math.min(idx * 60, 360)}ms` }}>
                <span
                  aria-hidden
                  className={`z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border ${meta.tone}`}
                >
                  <meta.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`cs-badge ${meta.tone}`}>{a.agent}</span>
                    <span className="font-mono text-[11px] text-cs-secondary/80">{a.action}</span>
                    {a.complaint?.refCode && <span className="text-[11px] text-cs-secondary/70">{a.complaint.refCode}</span>}
                    <span className="ml-auto text-[11px] text-cs-secondary/70">{fmtDateTime(a.createdAt)}</span>
                  </div>
                  <p className="mt-1 break-words text-sm leading-relaxed text-slate-200">{a.summary}</p>
                  {a.detail && <Reasons detail={a.detail} />}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

type ActivityDetail = {
  reasons?: string[];
  reasoning?: string[];
  provider?: string;
  model?: string;
  note?: string;
  match?: { reasons?: string[] };
};

function Reasons({ detail }: { detail: string }) {
  let parsed: ActivityDetail | null = null;
  try {
    parsed = JSON.parse(detail) as ActivityDetail;
  } catch {
    return null;
  }
  const provider = parsed?.provider;
  const model = parsed?.model;
  const note = parsed?.note;
  const reasons = parsed?.reasons ?? parsed?.reasoning ?? parsed?.match?.reasons;

  if (!provider && !note && !reasons?.length) return null;

  return (
    <div className="mt-1.5">
      {provider && <ProviderChip provider={provider} model={model} />}
      {note && <p className="text-xs italic text-cs-secondary/90">{note}</p>}
      {reasons && reasons.length > 0 && (
        <ul className="mt-1 space-y-0.5 border-l border-cs-border pl-3 text-xs text-cs-secondary">
          {reasons.map((r: string, i: number) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderChip({ provider, model }: { provider: string; model?: string }) {
  const isDev = provider.startsWith("dev");
  const realYolo = provider === "yolo-service";
  return (
    <span
      title={
        isDev
          ? "Labeled development provider — not a real model inference"
          : realYolo
            ? `Real YOLOv8 model inference via the vision service${model ? ` (${model})` : ""}`
            : "Production AI provider"
      }
      className={`mr-2 inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${
        isDev ? "border-amber-400/30 bg-amber-500/10 text-amber-300" : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
      }`}
    >
      {realYolo ? `REAL YOLO MODEL${model ? ` · ${model}` : ""}` : `AI Provider: ${provider}${isDev ? " (dev)" : ""}`}
    </span>
  );
}
