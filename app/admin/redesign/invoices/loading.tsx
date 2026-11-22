"use client";

import { usePathname } from "next/navigation";
import PageSkeleton from "../PageSkeleton";
import { isFramedPath } from "../RailFrame";

// A client's Invoices outline: the tab track, an empty header, the figures and All invoices (docs/rail-layout-plan.md):
// drawn at once on a move while the page is read, beside a rail that stays. This boundary also wraps the invoice as it
// prints (invoices/[id], no frame, no tabs), which gets no outline: only the framed path draws one.
export default function Loading() {
  const path = usePathname();
  return isFramedPath(path) ? <PageSkeleton tabs cards={[104, 320]} /> : null;
}
