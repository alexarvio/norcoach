import { joinStart } from "./start";

// A client makes their own account (18 Nov, Alex: docs/boards/client-signup-mockup.html), from Sign in's "New here?
// Create an account" or a coach's link (/join/<code>, which carries the code on). Signed in already: on to the join
// screens, or the app.
export const dynamic = "force-dynamic";

export default async function JoinPage() {
  return joinStart("");
}
