import PageSkeleton from "../PageSkeleton";

// A client's Lifestyle outline: the tab track, an empty header, the metrics and the check-ins (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton tabs head="track" cards={[200, 360]} />;
}
