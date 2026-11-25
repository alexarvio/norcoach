// Takes the website's laptop pictures from the demo copy (localhost:3010) with headless Chrome over the DevTools
// protocol: signed in as the demo coach by a session cookie minted with the demo's AUTH_SECRET.
// node shoot.cjs <outDir> <userId> name=path[|js] ...
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const WebSocket = require("C:/Users/alexa/Downloads/ironline_new/ironline/node_modules/next/dist/compiled/ws");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:3010";
const [outDir, userId, ...shots] = process.argv.slice(2);
const env = fs.readFileSync("C:/Users/alexa/Downloads/ironline_new/ironline-demo/.env.local", "utf8");
const secret = env.match(/^AUTH_SECRET=(.*)$/m)[1].trim();
const payload = `${userId}.${Date.now() + 86400000}`;
const token = `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;

const profile = fs.mkdtempSync(path.join(require("os").tmpdir(), "shoot-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let list;
  for (let i = 0; i < 40 && !list; i++) {
    await wait(250);
    try { list = await (await fetch("http://127.0.0.1:9333/json")).json(); } catch {}
  }
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.once("open", r));
  let n = 0;
  const pending = new Map();
  ws.on("message", (m) => {
    const d = JSON.parse(m);
    // A "Leave site?" on the way out (a save in flight) is answered yes: nothing here is kept.
    if (d.method === "Page.javascriptDialogOpening") ws.send(JSON.stringify({ id: 900000 + ++n, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send("Network.enable");
  await send("Page.enable");
  await send("Network.setCookie", { name: "ironline_session", value: token, domain: "localhost", path: "/" });
  await send("Emulation.setDeviceMetricsOverride", { width: Number(process.env.VW || 1600), height: Number(process.env.VH || 1000), deviceScaleFactor: Number(process.env.DPR || 1.25), mobile: !!process.env.MOBILE });
  // A first page, so the admin's opening plays here and never in a picture.
  // (no warm-up page: each picture its own browser, straight to its page)
  await wait(100);
  for (const shot of shots) {
    const eq = shot.indexOf("=");
    const name = shot.slice(0, eq);
    const rest = shot.slice(eq + 1);
    const bar = rest.indexOf("|");
    const url = bar < 0 ? rest : rest.slice(0, bar);
    const js = bar < 0 ? "" : rest.slice(bar + 1);
    console.log("nav", JSON.stringify((await send("Page.navigate", { url: BASE + url }))));
    await wait(1500);
    if ((await evaluate("location.pathname")) !== url.split("?")[0]) await evaluate(`location.href = ${JSON.stringify(BASE + url)}; 1`);
    await wait(12000);
    // The old sign-in's App access pill is not on the live admin (Clerk); the help/tour never in a picture.
    await evaluate(`[...document.querySelectorAll('button,a')].filter(b => /app access/i.test(b.textContent)).forEach(b => b.remove()); document.querySelectorAll('nextjs-portal').forEach(e => e.remove()); 1`);
    if (js) { await evaluate(js); await wait(2500); }
    await evaluate("window.scrollTo(0,0); document.activeElement && document.activeElement.blur(); 1");
    await wait(800);
    const shotRes = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(shotRes.result.data, "base64"));
    console.log("shot", name, await evaluate("location.pathname"));
  }
  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
