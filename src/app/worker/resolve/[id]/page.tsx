"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Card, Skeleton, ErrorNote, StatusBadge, SeverityBadge, Spinner } from "@/components/ui";
import { api, fetchMe, homeForRole, type SessionUser } from "@/lib/client";

type Detail = {
  id: string; refCode: string; title: string; description: string; category: string; severity: string;
  status: string; address: string | null; photoUrl: string | null;
};

type VerifyResponse = {
  verdict: { verified: boolean; confidence: number; reason: string; provider: string };
  status: string;
};

export default function ResolvePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [me, setMe] = useState<SessionUser | null | undefined>(undefined);
  const [c, setC] = useState<Detail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u) { setMe(null); return; }
      if (u.role !== "WORKER" && u.role !== "OFFICIAL") { router.push(homeForRole(u.role)); return; }
      setMe(u);
      api<{ complaint: Detail }>(`/api/complaints/${id}`).then((d) => setC(d.complaint)).catch((e) => setError((e as Error).message));
    });
  }, [id, router]);

  if (me === null) return <AppShell><ErrorNote message="Please sign in as the assigned worker." /></AppShell>;
  if (!c && !error) return <AppShell><div className="mx-auto max-w-2xl"><Skeleton className="h-64" /></div></AppShell>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setError("Please attach the after-resolution photo."); return; }
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.set("afterImage", file);
      if (note) fd.set("note", note);
      const res = await api<VerifyResponse>(`/api/complaints/${id}/verify`, { formData: fd });
      setResult(res);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl space-y-4">
        {result ? (
          <Card className={`cs-fade-up p-6 ${result.verdict.verified ? "border-emerald-400/30 bg-emerald-500/10" : "border-orange-400/30 bg-orange-500/10"}`}>
            <div className="flex flex-col items-center text-center">
              <div className={`grid h-12 w-12 place-items-center rounded-full border text-xl ${result.verdict.verified ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-300" : "border-orange-400/30 bg-orange-500/15 text-orange-300"}`} aria-hidden>
                {result.verdict.verified ? "✓" : "↺"}
              </div>
              <p className={`mt-3 text-xs font-semibold uppercase tracking-[0.12em] ${result.verdict.verified ? "text-emerald-300" : "text-orange-300"}`}>
                {result.verdict.verified ? "Resolution verified" : "Resolution not verified"}
              </p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">
                {result.verdict.verified ? "The AI confirmed the repair" : "Complaint reopened"}
              </h1>
              <p className="mt-2 max-w-md text-sm text-cs-secondary">{result.verdict.reason}</p>
              <p className="mt-2 text-xs text-cs-secondary">
                Confidence <strong className="text-cs-text">{(result.verdict.confidence * 100).toFixed(0)}%</strong>
                {" · "}provider <strong className="text-cs-text">{result.verdict.provider}</strong>
                {result.verdict.provider.startsWith("dev") && <span className="ml-1 text-amber-300">(labeled development provider)</span>}
                {" · "}new status: <strong className="text-cs-text">{result.status}</strong>
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <Link href={`/complaints/${id}`} className="cs-btn cs-btn-primary">View case</Link>
                <Link href="/worker" className="cs-btn cs-btn-secondary">Back to tasks</Link>
              </div>
            </div>
          </Card>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Submit resolution evidence</h1>
            {c && (
              <Card className="cs-fade-up p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-cs-secondary">{c.refCode}</span>
                  <StatusBadge status={c.status} />
                  <SeverityBadge severity={c.severity} />
                </div>
                <p className="mt-2 font-medium">{c.title}</p>
                <p className="mt-1 text-sm text-cs-secondary">{c.description}</p>
                {c.photoUrl && (
                  <figure className="mt-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.photoUrl} alt="Original issue photo" className="max-h-64 w-full rounded-xl border border-cs-border object-cover" />
                    <figcaption className="mt-1.5 text-xs text-cs-secondary">Before — citizen&apos;s original photo</figcaption>
                  </figure>
                )}
              </Card>
            )}

            <form onSubmit={submit} className="space-y-4">
              <Card className="space-y-3 p-5">
                <div>
                  <label htmlFor="after" className="text-sm font-medium text-slate-300">After-resolution photo *</label>
                  {preview ? (
                    <div className="relative mt-2 overflow-hidden rounded-xl border border-cs-border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview} alt="After-resolution preview" className="max-h-64 w-full object-cover" />
                      <button type="button" onClick={() => { setFile(null); setPreview(null); }}
                        className="absolute right-2 top-2 rounded-lg border border-cs-border bg-cs-bg/85 px-2.5 py-1 text-xs font-medium text-cs-text backdrop-blur-sm hover:bg-cs-elevated">
                        Remove
                      </button>
                    </div>
                  ) : (
                    <label htmlFor="after"
                      className="mt-2 flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-cs-border bg-cs-bg/40 px-6 py-10 text-center transition hover:border-emerald-400/50 hover:bg-emerald-500/5">
                      <span className="text-2xl" aria-hidden>📸</span>
                      <span className="text-sm font-medium">Upload after-resolution photo</span>
                      <span className="text-xs text-cs-secondary">Required — the Verification Agent reviews this image</span>
                      <input id="after" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          setFile(f);
                          setPreview(f ? URL.createObjectURL(f) : null);
                        }} />
                    </label>
                  )}
                </div>
                <div>
                  <label htmlFor="note" className="text-sm font-medium text-slate-300">Work note (optional)</label>
                  <input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Filled with gravel, compacted and levelled" className="cs-input mt-1.5" maxLength={300} />
                </div>
                <p className="rounded-xl border border-sky-400/25 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
                  ℹ️ The AI Verification Agent will independently check this photo before the case can close. A claim alone never resolves a complaint.
                </p>
              </Card>
              {error && <ErrorNote message={error} />}
              <button disabled={busy} className="cs-btn cs-btn-success w-full !py-3">
                {busy ? (<><Spinner className="border-[#04211a]/40 border-t-[#04211a]" /> Verifying…</>) : "Submit for AI verification"}
              </button>
            </form>
          </>
        )}
      </div>
    </AppShell>
  );
}
