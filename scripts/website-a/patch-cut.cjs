// The demo client's nutrition put right for a Cut (21 Nov, Alex: "the nutrition phase says we are on a cut, and the carbs
// are at 300"; kept the Cut, lowered the numbers): 2,000 kcal on training days, P 170 | C 175 | F 70 (34% | 35% | 31%),
// her logged averages and days to match. Drawn over the laptop's Nutrition tab and the phone's Nutrition screen as they
// are now (run patch-coach.cjs first, which redraws the laptop pictures from snaps-before). Run from the repo root with
// the website served on PORT (default 4321) and Chrome installed.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require(path.resolve("node_modules/sharp"));
const SITE = path.resolve("website");
const SNAPS = path.join(SITE, "img", "snaps");
const KEEP = path.join(__dirname, "snaps-before-cut");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = process.env.PORT || 4321;

const BLUE = "#334eac", AMBER = "#d99a2b", GREEN = "#2e8b79", TRACK = "#e2f2f3";
const SPLIT = [0.34, 0.35, 0.31];

// An arc on a circle, from a start share to an end share, clockwise from the top.
function arc(cx, cy, r, from, to) {
  const pt = (f) => [cx + r * Math.sin(f * 2 * Math.PI), cy - r * Math.cos(f * 2 * Math.PI)];
  const [x1, y1] = pt(from), [x2, y2] = pt(to);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const css = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Archivo,system-ui,sans-serif;font-weight:500;-webkit-font-smoothing:antialiased;overflow:hidden}
.scr{position:relative}
.c{position:absolute;background:#fff}
.t{position:absolute;white-space:nowrap;line-height:1}
svg.o{position:absolute;left:0;top:0}`;

// The laptop, 2000 × 1250.
function laptop() {
  const cx = 618.5, cy = 380.5, r = 85.5;
  let a = 0;
  const segs = [BLUE, AMBER, GREEN].map((col, i) => { const p = `<path d="${arc(cx, cy, r, a, a + SPLIT[i])}" stroke="${col}" stroke-width="19" fill="none"/>`; a += SPLIT[i]; return p; }).join("");
  const bar = (y, s) => { const x0 = 775, w = 1053; let x = x0; return [BLUE, AMBER, GREEN].map((col, i) => { const ww = w * s[i]; const el = `<rect x="${x.toFixed(1)}" y="${y - 4}" width="${ww.toFixed(1)}" height="8" fill="${col}"/>`; x += ww; return el; }).join("") + `<rect x="${x0}" y="${y - 4}" width="${w}" height="8" rx="4" fill="none"/>`; };
  const legend = (n, col, x) => `<span class="t" style="left:${x}px;top:521px;font-size:13.5px;font-weight:600;color:#3a4250"><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${col};margin-right:6px;vertical-align:0"></i>${n}%</span>`;
  return `<div class="scr" style="width:2000px;height:1250px;background:url(img/snaps/_base-coach-nutrition.jpg) 0 0 / 2000px 1250px">
  <i class="c" style="left:520px;top:282px;width:198px;height:198px;border-radius:50%"></i>
  <svg class="o" width="2000" height="1250">${segs}
    <clipPath id="b1"><rect x="775" y="1149" width="1053" height="8" rx="4"/></clipPath>
    <clipPath id="b2"><rect x="775" y="1210" width="1053" height="8" rx="4"/></clipPath>
  </svg>
  <b class="t" style="left:${cx - 80}px;width:160px;text-align:center;top:350px;font-size:40px;font-weight:600;letter-spacing:-.02em;color:#141a24">2,000</b>
  <span class="t" style="left:${cx - 60}px;width:120px;text-align:center;top:398px;font-size:13px;font-weight:600;letter-spacing:.14em;color:#8b93a1">KCAL</span>
  <i class="c" style="left:530px;top:516px;width:180px;height:26px"></i>
  ${legend(34, BLUE, 541)}${legend(35, AMBER, 596)}${legend(31, GREEN, 651)}
  <i class="c" style="left:1622px;top:332px;width:100px;height:30px"></i>
  <span class="t" style="left:1630px;top:339px;font-size:17.5px;font-weight:600;color:#141a24">175 <small style="font-size:14px;font-weight:500;color:#98A2B3">g</small></span>
  <i class="c" style="left:1748px;top:332px;width:90px;height:30px"></i>
  <span class="t" style="left:1756px;top:339px;font-size:17.5px;font-weight:600;color:#141a24">70 <small style="font-size:14px;font-weight:500;color:#98A2B3">g</small></span>
  <i class="c" style="left:662px;top:1010px;width:160px;height:38px"></i>
  <span class="t" style="left:670px;top:1018px;font-size:22.5px;font-weight:600;color:#141a24">1,985 <small style="font-size:16px;font-weight:500;color:#8b93a1">kcal</small></span>
  <i class="c" style="left:1290px;top:1010px;width:110px;height:38px"></i>
  <span class="t" style="left:1297px;top:1018px;font-size:22.5px;font-weight:600;color:#141a24">171 <small style="font-size:16px;font-weight:500;color:#8b93a1">g</small></span>
  <i class="c" style="left:1603px;top:1010px;width:100px;height:38px"></i>
  <span class="t" style="left:1610px;top:1018px;font-size:22.5px;font-weight:600;color:#141a24">68 <small style="font-size:16px;font-weight:500;color:#8b93a1">g</small></span>
  <i class="c" style="left:540px;top:1138px;width:90px;height:32px"></i>
  <b class="t" style="left:547px;top:1145px;font-size:17.5px;font-weight:600;color:#141a24">2,040</b>
  <i class="c" style="left:540px;top:1199px;width:90px;height:32px"></i>
  <b class="t" style="left:547px;top:1206px;font-size:17.5px;font-weight:600;color:#141a24">1,985</b>
  <i class="c" style="left:770px;top:1144px;width:1065px;height:18px"></i>
  <i class="c" style="left:770px;top:1205px;width:1065px;height:18px"></i>
  <svg class="o" width="2000" height="1250"><g clip-path="url(#b1)">${bar(1153, [0.34, 0.36, 0.30])}</g><g clip-path="url(#b2)">${bar(1214, [0.33, 0.35, 0.32])}</g></svg>
</div>`;
}

// The phone, 390 × 844 at 2× (drawn at 2× here: 780 × 1688).
function phone() {
  const cx = 189.75, cy = 820.5, rs = [139.75, 121.9, 103.9];
  const rings = rs.map((r, i) => `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${TRACK}" stroke-width="13" fill="none"/><path d="${arc(cx, cy, r, 0, SPLIT[i])}" stroke="${[BLUE, AMBER, GREEN][i]}" stroke-width="13" stroke-linecap="round" fill="none"/>`).join("");
  const macro = (top, n, col, pct) => `<i class="c" style="left:400px;top:${top}px;width:200px;height:52px;background:#F5F6F8"></i>
    <span class="t" style="left:407px;top:${top + 6}px;font-size:44px;font-weight:500;letter-spacing:-.02em;color:#262b33">${n}<small style="margin-left:6px;font-size:24px;color:#8b93a1">g</small></span>
    <i class="c" style="left:${pct.x - 6}px;top:${pct.y - 4}px;width:70px;height:26px;background:#F5F6F8"></i>
    <b class="t" style="left:${pct.x}px;top:${pct.y}px;font-size:18px;font-weight:600;letter-spacing:.12em;color:${col}">${pct.n}%</b>`;
  return `<div class="scr" style="width:780px;height:1688px;background:url(img/snaps/_base-phone-nutrition.jpg) 0 0 / 780px 1688px">
  <i class="c" style="left:${cx - 152}px;top:${cy - 152}px;width:304px;height:304px;border-radius:50%;background:#F5F6F8"></i>
  <svg class="o" width="780" height="1688">${rings}</svg>
  <b class="t" style="left:${cx - 90}px;width:180px;text-align:center;top:776px;font-size:58px;font-weight:500;letter-spacing:-.02em;color:#262b33">2,000</b>
  <span class="t" style="left:${cx - 60}px;width:120px;text-align:center;top:845px;font-size:17px;font-weight:600;letter-spacing:.16em;color:#5b6474">KCAL</span>
  ${macro(782, 175, AMBER, { x: 520, y: 838, n: 35 })}
  ${macro(899, 70, GREEN, { x: 478, y: 955, n: 31 })}
  <i class="c" style="left:540px;top:716px;width:70px;height:26px;background:#F5F6F8"></i>
  <b class="t" style="left:546px;top:720px;font-size:18px;font-weight:600;letter-spacing:.12em;color:${BLUE}">34%</b>
</div>`;
}

(async () => {
  fs.mkdirSync(KEEP, { recursive: true });
  const jobs = [
    { name: "coach-nutrition", file: "coach-nutrition.jpg", base: "_base-coach-nutrition.jpg", html: laptop, w: 2000, h: 1250, scale: 1 },
    { name: "phone-nutrition", file: "phone-nutrition.jpg", base: "_base-phone-nutrition.jpg", html: phone, w: 780, h: 1688, scale: 1 },
  ];
  for (const j of jobs) {
    const kept = path.join(KEEP, j.file);
    if (!fs.existsSync(kept)) fs.copyFileSync(path.join(SNAPS, j.file), kept);
    fs.copyFileSync(kept, path.join(SNAPS, j.base));
    const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;500;600&display=block"><style>${css}</style>${j.html()}`;
    fs.writeFileSync(path.join(SITE, `_${j.name}.html`), page);
    const png = path.join(__dirname, `${j.name}.png`);
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${j.w},${j.h}`, `--force-device-scale-factor=${j.scale}`, "--virtual-time-budget=6000", `--screenshot=${png}`, `http://localhost:${PORT}/_${j.name}.html`], { stdio: "ignore" });
    await sharp(png).resize(j.w, j.h, { fit: "cover", position: "top" }).jpeg({ quality: 90 }).toFile(path.join(SNAPS, j.file));
    fs.rmSync(path.join(SITE, `_${j.name}.html`), { force: true });
    fs.rmSync(path.join(SNAPS, j.base), { force: true });
    fs.rmSync(png, { force: true });
    console.log("drew", j.name);
  }
})();
