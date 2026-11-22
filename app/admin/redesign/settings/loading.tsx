"use client";

import { usePathname } from "next/navigation";
import PageSkeleton from "../PageSkeleton";
import { isFramedPath } from "../RailFrame";

// Settings' outline: its header and the section showing (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
// This boundary also wraps the old per-section addresses (settings/[section], a redirect to the section on the one
// page), which get no outline: only the framed path draws one, so no frameless outline flashes before the redirect.
export default function Loading() {
  const path = usePathname();
  return isFramedPath(path) ? <PageSkeleton title="Settings" cards={[440]} /> : null;
}
