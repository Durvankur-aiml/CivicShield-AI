"use client";

import type { ReactNode } from "react";
import { LangProvider } from "@/lib/i18n";

/**
 * Client-side app providers, mounted once from the root layout.
 *
 * The App Router root layout is a server component, so interactive context
 * providers must live behind a client boundary — this is that boundary.
 * Before Phase 6 Step 2, LangProvider existed but was never mounted, which
 * left the language selector as a no-op; mounting it here activates the
 * existing en/hi/mr dictionary, the cs_lang localStorage persistence, and
 * every useLang() consumer without changing the i18n API.
 *
 * Future client-only providers belong here (one mount point, stable order).
 */
export function Providers({ children }: { children: ReactNode }) {
  return <LangProvider>{children}</LangProvider>;
}
