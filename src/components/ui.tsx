"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ChevronDown, Inbox, LogIn, X } from "lucide-react";
import { statusLabels, severityLabels, categoryLabels } from "@/lib/constants";

/* ── Semantic tone maps (status / severity) ─────────────────────────
   Anchored to the approved semantics: emerald success, amber warning,
   red/crimson error, indigo progress, blue assignment.               */
export const statusTone: Record<string, string> = {
  RECEIVED: "bg-slate-500/10 text-slate-300 border-slate-400/25",
  ASSIGNED: "bg-blue-500/10 text-blue-300 border-blue-400/30",
  IN_PROGRESS: "bg-indigo-500/10 text-indigo-300 border-indigo-400/30",
  VERIFICATION: "bg-amber-500/10 text-amber-300 border-amber-400/30",
  RESOLVED: "bg-emerald-500/10 text-emerald-300 border-emerald-400/30",
  CLOSED: "bg-emerald-500/15 text-emerald-200 border-emerald-400/40",
  REOPENED: "bg-orange-500/10 text-orange-300 border-orange-400/30",
  ESCALATED: "bg-rose-500/10 text-rose-300 border-rose-400/30",
};

export const severityTone: Record<string, string> = {
  LOW: "bg-slate-500/10 text-slate-300 border-slate-400/25",
  MEDIUM: "bg-amber-500/10 text-amber-300 border-amber-400/30",
  HIGH: "bg-orange-500/10 text-orange-300 border-orange-400/30",
  CRITICAL: "bg-red-500/15 text-red-300 border-red-400/40",
};

const dotColor: Record<string, string> = {
  RECEIVED: "bg-slate-400",
  ASSIGNED: "bg-blue-400",
  IN_PROGRESS: "bg-indigo-400",
  VERIFICATION: "bg-amber-400",
  RESOLVED: "bg-emerald-400",
  CLOSED: "bg-emerald-300",
  REOPENED: "bg-orange-400",
  ESCALATED: "bg-rose-400",
};

export function StatusBadge({ status, pulse = false }: { status: string; pulse?: boolean }) {
  return (
    <span className={`cs-badge ${statusTone[status] ?? "bg-slate-500/10 text-slate-300 border-slate-400/25"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor[status] ?? "bg-slate-400"} ${pulse ? "cs-pulse-dot" : ""}`} aria-hidden />
      {statusLabels[status] ?? status}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`cs-badge ${severityTone[severity] ?? ""}`}>
      {severityLabels[severity] ?? severity}
    </span>
  );
}

export function CategoryTag({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center rounded-lg border border-blue-400/25 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-300">
      {categoryLabels[category] ?? category}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span
      title="Seeded demo record — not a live citizen report"
      className="inline-flex items-center rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-xs font-semibold text-violet-300"
    >
      DEMO
    </span>
  );
}

export function Card({ children, className = "", hover = false }: { children: React.ReactNode; className?: string; hover?: boolean }) {
  return <div className={`cs-card ${hover ? "cs-card-hover" : ""} ${className}`}>{children}</div>;
}

export function MetricCard({
  label,
  value,
  tone,
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  // Default resolved explicitly so a caller-passing undefined and the omitted
  // prop behave identically without putting a class default in the signature.
  const valueTone = tone ?? "text-cs-text";
  return (
    <Card className="cs-fade-up p-4 sm:p-5" hover>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">{label}</div>
        {icon && <span className="text-cs-faint">{icon}</span>}
      </div>
      <div className={`tnum font-display mt-2 text-[28px] font-semibold leading-none tracking-tight ${valueTone}`}>{value}</div>
      {hint && <div className="mt-1.5 text-xs text-cs-secondary">{hint}</div>}
    </Card>
  );
}

/** Backwards-compatible alias used by earlier pages. */
export function StatCard({ label, value, tone = "text-cs-text" }: { label: string; value: number | string; tone?: string }) {
  return <MetricCard label={label} value={value} tone={tone} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`cs-skeleton ${className}`} aria-hidden />;
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 rounded-full border-2 border-cs-border border-t-blue-400 ${className}`}
      style={{ animation: "cs-spin 0.8s linear infinite" }}
      role="status"
      aria-label="Loading"
    />
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="cs-fade-up mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-cs-text sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-cs-secondary">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Section-level heading inside a page (sits under the PageHeader). */
export function SectionHeading({ title, hint, aside }: { title: string; hint?: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="font-display text-base font-semibold tracking-tight text-cs-text">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-cs-secondary">{hint}</p>}
      </div>
      {aside && <div className="flex items-center gap-2 text-xs text-cs-secondary">{aside}</div>}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="cs-fade-up flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="cs-btn cs-btn-danger px-3! py-1.5! text-xs!">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="cs-fade-up flex flex-col items-center justify-center rounded-2xl border border-dashed border-cs-border bg-cs-surface/50 px-8 py-14 text-center">
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl border border-cs-border bg-cs-elevated text-cs-faint" aria-hidden>
        {icon ?? <Inbox className="h-5 w-5" />}
      </div>
      <p className="font-medium text-cs-text">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-cs-secondary">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function LoginPrompt() {
  return (
    <Card className="p-8 text-center">
      <p className="text-cs-secondary">Please sign in to continue.</p>
      <Link href="/login" className="cs-btn cs-btn-primary mt-4">
        <LogIn className="h-4 w-4" aria-hidden />
        Sign in
      </Link>
    </Card>
  );
}

/* ── Standard primitives (available to all pages) ─────────────────── */

type ButtonVariant = "primary" | "secondary" | "success" | "danger";
const buttonVariantClass: Record<ButtonVariant, string> = {
  primary: "cs-btn-primary",
  secondary: "cs-btn-secondary",
  success: "cs-btn-success",
  danger: "cs-btn-danger",
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: React.ReactNode;
};

/** Semantic button on the shared cs-btn system (defaults to type="button"). */
export function Button({ variant = "primary", size = "md", icon, className = "", children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`cs-btn ${buttonVariantClass[variant]} ${size === "sm" ? "px-3! py-1.5! text-xs!" : ""} ${className}`}
      {...rest}
    >
      {icon && (
        <span className="inline-flex shrink-0" aria-hidden>
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  icon?: React.ReactNode;
};

/** Text input on the cs-input system with optional accessible label/hint/icon. */
export function Input({ label, hint, icon, className = "", id, ...rest }: InputProps) {
  const inputId = id ?? (label ? `field-${slug(label)}` : undefined);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">
          {label}
        </label>
      )}
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-cs-faint" aria-hidden>
            {icon}
          </span>
        )}
        <input id={inputId} className={`cs-input ${icon ? "pl-9" : ""} ${className}`} {...rest} />
      </div>
      {hint && (
        <p className="mt-1 text-xs text-cs-faint">{hint}</p>
      )}
    </div>
  );
}

export type SelectOption = { value: string; label: string };

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  options?: (SelectOption | string)[];
};

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
};

/** Textarea on the cs-input system with optional accessible label/hint. */
export function Textarea({ label, hint, className = "", id, ...rest }: TextareaProps) {
  const inputId = id ?? (label ? `field-${slug(label)}` : undefined);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">
          {label}
        </label>
      )}
      <textarea id={inputId} className={`cs-input ${className}`} {...rest} />
      {hint && <p className="mt-1 text-xs text-cs-faint">{hint}</p>}
    </div>
  );
}

/** Select on the cs-input system with a consistent chevron affordance. */
export function Select({ label, options, className = "", id, children, ...rest }: SelectProps) {
  const selectId = id ?? (label ? `field-${slug(label)}` : undefined);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={selectId} className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.06em] text-cs-secondary">
          {label}
        </label>
      )}
      <div className="relative">
        <select id={selectId} className={`cs-input appearance-none pr-9 ${className}`} {...rest}>
          {options?.map((o) => {
            const opt = typeof o === "string" ? { value: o, label: o } : o;
            return (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            );
          })}
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cs-faint" aria-hidden />
      </div>
    </div>
  );
}

/**
 * Accessible modal dialog: focus is moved into the panel on open, Tab is
 * trapped inside it, Escape closes, background scroll is locked.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  const focusablesIn = (panel: HTMLElement) =>
    Array.from(
      panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);

  const keydown = (e: KeyboardEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = focusablesIn(panel);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    focusablesIn(panel ?? document.body)[0]?.focus();
    document.addEventListener("keydown", keydown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="cs-fade-in absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="cs-card cs-pop-in relative z-10 w-full max-w-lg p-5 sm:p-6"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-display text-lg font-semibold tracking-tight text-cs-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-cs-secondary transition hover:bg-white/5 hover:text-cs-text"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Card-wrapped responsive table: horizontal scroll on small screens. */
export function TableShell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`cs-card cs-scroll-x ${className}`}>
      <table className="w-full min-w-max border-collapse text-sm">{children}</table>
    </div>
  );
}

/** Header row builder; pass actionsLabel to add a trailing actions column. */
export function TableHead({ columns, actionsLabel }: { columns: string[]; actionsLabel?: string }) {
  return (
    <thead>
      <tr className="border-b border-cs-border text-left">
        {columns.map((c) => (
          <th key={c} scope="col" className="whitespace-nowrap px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">
            {c}
          </th>
        ))}
        {actionsLabel && (
          <th scope="col" className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">
            {actionsLabel}
          </th>
        )}
      </tr>
    </thead>
  );
}

/** Full-width loading / error / empty state row for tables. */
export function TableStateRow({
  colSpan,
  loading,
  error,
  empty,
  emptyHint,
}: {
  colSpan: number;
  loading?: boolean;
  error?: string;
  empty?: string;
  emptyHint?: string;
}) {
  if (!loading && !error && !empty) return null;
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10">
        {loading ? (
          <span className="flex items-center justify-center gap-2 text-sm text-cs-secondary">
            <Spinner /> Loading…
          </span>
        ) : error ? (
          <ErrorNote message={error} />
        ) : (
          <EmptyState title={empty ?? "Nothing here yet"} hint={emptyHint} />
        )}
      </td>
    </tr>
  );
}

/** Shared slug for generated field ids. */
function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
