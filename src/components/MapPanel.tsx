"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type CivicMapType from "./CivicMap";

const CivicMap = dynamic(() => import("./CivicMap"), {
  ssr: false,
  loading: () => (
    <div className="cs-skeleton h-full w-full rounded-2xl border border-cs-border" aria-label="Loading map" />
  ),
});

export default function MapPanel(props: ComponentProps<typeof CivicMapType>) {
  return <CivicMap {...props} />;
}
