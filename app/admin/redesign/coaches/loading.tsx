import PageSkeleton from "../PageSkeleton";

// Coaches' outline: its header and the accounts (docs/rail-layout-plan.md): drawn at once on a move while the page is read, beside a rail that stays.
export default function Loading() {
  return <PageSkeleton title="Coaches" cards={[280]} />;
}
