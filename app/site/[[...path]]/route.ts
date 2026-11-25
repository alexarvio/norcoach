import fs from "fs";
import path from "path";
import { timingSafeEqual } from "crypto";

// The website (website/, the coaches' site) on norcoachapp.com, behind a username and password while it isn't public
// yet (18 Nov, Alex: "connect it to the url already, just we set a username and password to access it"). proxy.ts sends
// the bare domain's pages here (/site/<path>); this route asks for SITE_USER and SITE_PASSWORD (the browser's own login
// box) and serves the file. Without both set on the server the bare domain goes to the app as before, and nothing is
// served here. Never indexed while it is gated.
const ROOT = path.join(process.cwd(), "website");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function allowed(request: Request): boolean {
  const user = process.env.SITE_USER?.trim();
  const pass = process.env.SITE_PASSWORD?.trim();
  if (!user || !pass) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const at = decoded.indexOf(":");
  if (at < 0) return false;
  // Both compared whole, so a wrong one never answers faster than another.
  const okUser = same(decoded.slice(0, at), user);
  const okPass = same(decoded.slice(at + 1), pass);
  return okUser && okPass;
}

// Public (25 Nov, Alex: "lets make it public"): with SITE_PUBLIC=1 every page is served to anyone and may be indexed;
// without it, the password as before.
const isPublic = () => process.env.SITE_PUBLIC?.trim() === "1";

export async function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const open = isPublic();
  if (!open && (!process.env.SITE_USER?.trim() || !process.env.SITE_PASSWORD?.trim())) return new Response("Not found", { status: 404 });
  if (!open && !allowed(request)) {
    return new Response("Sign in to see the Norcoach website.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Norcoach", charset="UTF-8"', "X-Robots-Tag": "noindex", "Cache-Control": "no-store" },
    });
  }
  const parts = ((await params).path ?? []).filter(Boolean);
  if (parts.some((p) => p === ".." || p.startsWith("."))) return new Response("Not found", { status: 404 });
  let file = path.join(ROOT, ...parts);
  if (!file.startsWith(ROOT)) return new Response("Not found", { status: 404 });
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch {
    // A page asked for without .html (/apply) is its .html file.
    if (!path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("Not found", { status: 404 });
  const bytes = fs.readFileSync(file);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      ...(open ? {} : { "X-Robots-Tag": "noindex" }),
      "Cache-Control": open ? "public, no-cache" : "private, no-cache",
    },
  });
}
