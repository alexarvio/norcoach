// The laptop pictures' demo client, put right (18 Nov, Alex: "the client is in a lean bulk while the weight goes down…
// Fix that"): Emma's nutrition phase is a Cut, the Home tile shows the targets the Nutrition tab does (2,600 kcal,
// P 170 | C 175 | F 70 since 21 Nov, a Cut's numbers), and her next call is on the right weekday (30/10/2026 is a Friday). Drawn over the earlier
// pictures, kept in snaps-before. Run from the repo root; needs the website server on :4322 and Chrome.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require(path.resolve("node_modules/sharp"));
const SITE = path.resolve("website");
const SNAPS = path.join(SITE, "img", "snaps");
const KEEP = path.join(__dirname, "snaps-before");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const css = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:2000px;height:1250px;overflow:hidden}
body{font-family:Archivo,system-ui,sans-serif;font-weight:500;color:#141a24;-webkit-font-smoothing:antialiased}
.scr{position:relative;width:2000px;height:1250px}
.cover{position:absolute}
.t{position:absolute;white-space:nowrap;line-height:1}
.bar{display:inline-block;width:1px;height:13px;margin:0 6px;background:#c3c9d2;vertical-align:-1px}
`;
const pages = {
  "coach-home": (bg) => `
  <div class="scr" style="background:url(img/snaps/_base-coach-home.jpg) 0 0 / 2000px 1250px">
    <i class="cover" style="left:1405px;top:228px;width:480px;height:34px;background:#fff"></i>
    <b class="t" style="left:1411px;top:237px;font-size:18.75px;font-weight:600;letter-spacing:-.01em">Cut</b>
    <i class="cover" style="left:1405px;top:308px;width:480px;height:42px;background:#fff"></i>
    <span class="t" style="left:1411px;top:318px;font-size:15px;color:#8b93a1"><b style="font-size:22.5px;font-weight:600;color:#141a24;letter-spacing:-.01em;margin-right:8px">2,000 kcal</b>P 170<i class="bar"></i>C 175<i class="bar"></i>F 70</span>
    <i class="cover" style="left:1186px;top:1066px;width:320px;height:36px;background:#fff"></i>
    <b class="t" style="left:1193px;top:1074px;font-size:22.5px;font-weight:600;letter-spacing:-.01em">Fri 30/10</b>
  </div>`,
  "coach-nutrition": (bg) => `
  <div class="scr" style="background:url(img/snaps/_base-coach-nutrition.jpg) 0 0 / 2000px 1250px">
    <i class="cover" style="left:326px;top:116px;width:450px;height:46px;background:${bg}"></i>
    <div class="t" style="left:334px;top:121px;height:38px;display:flex;align-items:center">
      <b style="font-size:31.25px;font-weight:600;letter-spacing:-.015em">Cut</b>
      <svg viewBox="0 0 24 24" width="18" height="18" style="margin:4px 14px 0 14px"><path fill="none" stroke="#8b93a1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      <span style="display:inline-flex;align-items:center;height:30px;padding:0 13px;border-radius:15px;background:#dcebdf;color:#2f7a3f;font-size:13.75px;font-weight:600;letter-spacing:.12em">LIVE</span>
      <svg viewBox="0 0 24 24" width="17" height="17" style="margin:0 6px 0 18px"><path fill="none" stroke="#2f7a3f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      <span style="font-size:16.25px;color:#8b93a1">All changes saved</span>
    </div>
  </div>`,
};

(async () => {
  fs.mkdirSync(KEEP, { recursive: true });
  for (const k of Object.keys(pages)) {
    const kept = path.join(KEEP, `${k}.jpg`);
    if (!fs.existsSync(kept)) fs.copyFileSync(path.join(SNAPS, `${k}.jpg`), kept);
    fs.copyFileSync(kept, path.join(SNAPS, `_base-${k}.jpg`));
    const px = await sharp(kept).extract({ left: 800, top: 136, width: 4, height: 4 }).raw().toBuffer();
    const bg = `rgb(${px[0]},${px[1]},${px[2]})`;
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;500;600&display=block"><style>${css}</style>${pages[k](bg)}`;
    fs.writeFileSync(path.join(SITE, `_${k}.html`), html);
    const png = path.join(__dirname, `${k}.png`);
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=2000,1250", "--force-device-scale-factor=1", "--virtual-time-budget=6000", `--screenshot=${png}`, `http://localhost:${process.env.PORT || 4321}/_${k}.html`], { stdio: "ignore" });
    await sharp(png).resize(2000, 1250, { fit: "cover", position: "top" }).jpeg({ quality: 90 }).toFile(path.join(SNAPS, `${k}.jpg`));
    fs.rmSync(path.join(SITE, `_${k}.html`), { force: true });
    fs.rmSync(path.join(SNAPS, `_base-${k}.jpg`), { force: true });
    console.log(k, bg);
  }
  // Crops to look at.
  await sharp(path.join(SNAPS, "coach-home.jpg")).extract({ left: 860, top: 180, width: 1050, height: 190 }).toFile(path.join(__dirname, "crop-home-tiles.png"));
  await sharp(path.join(SNAPS, "coach-home.jpg")).extract({ left: 1170, top: 1000, width: 740, height: 210 }).toFile(path.join(__dirname, "crop-home-meet.png"));
  await sharp(path.join(SNAPS, "coach-nutrition.jpg")).extract({ left: 300, top: 80, width: 900, height: 120 }).toFile(path.join(__dirname, "crop-nutrition.png"));
})();
