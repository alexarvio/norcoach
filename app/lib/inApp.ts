import "server-only";
import { cookies, headers } from "next/headers";
import { NATIVE_COOKIE } from "./quietLoad";
import type { InApp } from "../login/SignInScreens";

/** The phone app this page is in, from the app's own cookie (set before anything draws, lib/quietLoad.ts) and the phone's
 *  name, so the sign-in and sign-up screens are drawn as the app shows them from the first frame (18 Nov; 27 Nov, Alex:
 *  on Create your account the Apple button came in after the page and pushed the email and password down). */
export async function inApp(): Promise<InApp> {
  if ((await cookies()).get(NATIVE_COOKIE)?.value !== "1") return null;
  return /iPhone|iPad|iPod/.test((await headers()).get("user-agent") ?? "") ? "ios" : "android";
}
