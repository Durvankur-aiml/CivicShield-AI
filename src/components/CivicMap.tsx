"use client";

import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import Link from "next/link";
import { DEMO_MAP_CENTER } from "@/lib/constants";

export type MapComplaint = {
  id: string;
  refCode: string;
  title: string;
  // Phase 4: coordinates may be absent — such complaints cannot be plotted.
  lat: number | null;
  lng: number | null;
  category: string;
  severity: string;
  status: string;
  source: string;
};

export const SEVERITY_COLOR: Record<string, string> = {
  LOW: "#94A3B8",
  MEDIUM: "#F59E0B",
  HIGH: "#F97316",
  CRITICAL: "#EF4444",
};

const RADIUS: Record<string, number> = { LOW: 6, MEDIUM: 7, HIGH: 9, CRITICAL: 11 };

/** Civic Risk Map — severity-coded glowing markers over a dark-treated OSM layer.
 *  Markers are rendered from the EXACT stored lat/lng (A12) — no rounding, no
 *  city-center snapping. Complaints without coordinates are not plotted. */
export default function CivicMap({
  complaints,
  center = [DEMO_MAP_CENTER.lat, DEMO_MAP_CENTER.lng], // map viewport default only
  zoom = 13,
  height = "440px",
}: {
  complaints: MapComplaint[];
  center?: [number, number];
  zoom?: number;
  height?: string;
}) {
  const plottable = complaints.filter((c) => c.lat != null && c.lng != null);
  return (
    <div className="relative overflow-hidden rounded-2xl border border-cs-border" style={{ height }}>
      <MapContainer center={center} zoom={zoom} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {plottable.map((c) => {
          const color = SEVERITY_COLOR[c.severity] ?? "#94A3B8";
          return (
            <CircleMarker
              key={c.id}
              center={[c.lat as number, c.lng as number]}
              radius={RADIUS[c.severity] ?? 6}
              className="cs-marker"
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.35,
                weight: 2,
                opacity: 0.9,
              }}
            >
              <Popup>
                <div className="min-w-48 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-cs-secondary">{c.refCode}</span>
                    {c.source === "DEMO" && (
                      <span className="rounded border border-violet-400/30 bg-violet-500/10 px-1 text-[10px] font-semibold text-violet-300">DEMO</span>
                    )}
                  </div>
                  <div className="text-sm font-semibold">{c.title}</div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
                      {c.severity}
                    </span>
                    <span className="text-cs-secondary">· {c.status.toLowerCase()}</span>
                  </div>
                  <Link href={`/complaints/${c.id}`} className="inline-block text-xs font-semibold text-blue-400 hover:underline">
                    View report →
                  </Link>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-[500] rounded-xl border border-cs-border bg-cs-bg/85 px-3 py-2.5 backdrop-blur-sm">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-cs-secondary">Severity</div>
        <div className="flex gap-3">
          {Object.entries(SEVERITY_COLOR).map(([k, color]) => (
            <span key={k} className="flex items-center gap-1.5 text-[11px] text-slate-300">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}66` }} aria-hidden />
              {k[0] + k.slice(1).toLowerCase()}
            </span>
          ))}
        </div>
      </div>

      {/* Count chip */}
      <div className="pointer-events-none absolute right-3 top-3 z-[500] rounded-lg border border-cs-border bg-cs-bg/85 px-2.5 py-1 text-[11px] font-medium text-cs-secondary backdrop-blur-sm">
        {plottable.length} report{plottable.length === 1 ? "" : "s"} plotted
      </div>
    </div>
  );
}
