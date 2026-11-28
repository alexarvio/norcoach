import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clerkOn } from "../../../lib/clerk";
import { NativeStart } from "./NativeStart";

// In the app's secure sign-in sheet, after /auth/native/start: Clerk takes the person to Google (or Apple, from the
// Android app), the start's secret number riding along in the return address (read here on the server, as the page
// itself can't).
export const dynamic = "force-dynamic";

export default async function NativeGoPage() {
  if (!clerkOn()) redirect("/login");
  const jar = await cookies();
  const nonce = jar.get("norcoach_native_nonce")?.value ?? "";
  // A start from before the provider was kept (an iPhone sheet open across the deploy) was Google.
  const provider = jar.get("norcoach_native_provider")?.value ?? "google";
  if (!/^[A-Za-z0-9_-]{32}$/.test(nonce) || (provider !== "google" && provider !== "apple")) redirect("norcoach://auth?error=no_state");
  return <NativeStart nonce={nonce} provider={provider} />;
}
