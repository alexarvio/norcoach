import PageSkeleton from "../PageSkeleton";

// Business's outline: its header, the figures and Money by month (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton title="Business" cards={[104, 300]} />;
}
