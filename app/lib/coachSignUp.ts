// A coach who signs up is in at once (17 Nov, Alex: "I don't see why I have to accept them… create an account, get an
// email confirmation, and start using the account immediately"). The owner's approval step is gone: the account is made
// as approveCoach always left it, with their own copy of the presets, the welcome steps on their first screen and, while
// coaches pay Norcoach (billing.ts), the subscribe screen before them, and the name and business they gave on their
// profile. One that signed up while approval was still asked (`pending`) is let in the same way the next time they come.

import { approveCoach } from "./auth";
import { getData } from "./db";
import { applySignUpDetails } from "./queries";

/** Lets a signed-up coach in. False when there was nobody waiting under that id. */
export function letCoachIn(coachId: number): boolean {
  const pending = getData().users.find((u) => u.id === coachId && u.role === "coach")?.pending;
  if (!pending || !approveCoach(coachId)) return false;
  applySignUpDetails(coachId, pending.name, pending.business);
  return true;
}
