// The native app (mobile/, Capacitor) loads this site from its server, so the
// site has no Capacitor package: the app injects window.Capacitor, and these
// are the calls its registerPlugin makes underneath. Browser-only; in a normal
// browser nativeApp() is null and everything else here does nothing.

type Cap = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (plugin: string) => boolean;
  Plugins?: Record<string, unknown>;
  nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown>;
  addListener?: (plugin: string, event: string, callback: (data: unknown) => void) => NativeListener | undefined;
};

export function nativeApp(): Cap | null {
  if (typeof window === "undefined") return null;
  const c = (window as { Capacitor?: Cap }).Capacitor;
  return c?.isNativePlatform?.() && c.nativePromise ? c : null;
}

export type NativePlatform = "ios" | "android";

export function nativePlatform(): NativePlatform | null {
  const p = nativeApp()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : null;
}

/** Whether the app on this phone has a native plugin (an older build may not have one the site now uses). */
export function nativeHas(plugin: string): boolean {
  const c = nativeApp();
  if (!c) return false;
  try {
    return c.isPluginAvailable ? c.isPluginAvailable(plugin) : !!c.Plugins && Object.prototype.hasOwnProperty.call(c.Plugins, plugin);
  } catch {
    return false;
  }
}

/** Calls a native plugin method; throws outside the app. */
export function callNative<T>(plugin: string, method: string, options?: object): Promise<T> {
  const c = nativeApp();
  if (!c?.nativePromise) return Promise.reject(new Error("Not in the Norcoach app"));
  return c.nativePromise(plugin, method, options) as Promise<T>;
}

/** What addListener hands back: its remove() takes the listener off again. */
export type NativeListener = { remove: () => Promise<void> };

/** Listens for a native plugin event (for the life of the page, or until the handle's remove()). */
export function onNative<T>(plugin: string, event: string, callback: (data: T) => void): NativeListener | undefined {
  return nativeApp()?.addListener?.(plugin, event, callback as (data: unknown) => void);
}
