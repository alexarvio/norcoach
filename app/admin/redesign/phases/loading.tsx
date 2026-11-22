import PageSkeleton from "../PageSkeleton";

// The Phases screen's outline: its header and the timeline (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton title="Phases" cards={[460]} />;
}
