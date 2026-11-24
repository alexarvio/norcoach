"use client";

import { usePathname } from "next/navigation";
import PageSkeleton, { VIEW_SKELETON } from "../PageSkeleton";
import { clientScreenOf } from "../paths";

// A client's tab's outline (docs/rail-layout-plan.md), drawn at once on a move while the page is read, beside a rail
// that stays: every tab is this one page now (tabs/page.tsx), so the outline is the tab the address names.
export default function Loading() {
  const tab = clientScreenOf(usePathname())?.tab ?? "home";
  return <PageSkeleton {...VIEW_SKELETON[tab]} />;
}
