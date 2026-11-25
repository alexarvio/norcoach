// The Play Store's graphics (25 Nov, Alex: open testing on Google Play): the 512 icon, the 1024 × 500 feature graphic
// and four phone screenshots at 1080 × 1920 (Play takes no side more than twice the other; the website's phone
// pictures are 780 × 1688), all from what the repo already has. Run from the repo root: node mobile/store/android/build-play-assets.cjs
const fs = require("fs");
const path = require("path");
const sharp = require(path.resolve("node_modules/sharp"));

const OUT = path.resolve("mobile/store/android");
const DARK = "#1c1c1e";
const word = fs.readFileSync("brand/norcoach-wordmark.svg", "utf8").replace('fill="currentColor"', 'fill="#ffffff"');
const star = fs.readFileSync("brand/star.svg", "utf8");

// A phone picture with the screen's rounded corners, w wide.
async function phone(name, w) {
  const h = Math.round((w * 1688) / 780);
  const r = Math.round(w * 0.12);
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`);
  return sharp(`website/img/snaps/${name}.jpg`).resize(w, h).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

(async () => {
  // The icon: the app's own (the ink star on paper), 512.
  await sharp("mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png").resize(512, 512).png().toFile(path.join(OUT, "icon-512.png"));

  // The feature graphic: the dark with the faint star cropped off its right, NORCOACH on the left, two phones.
  const faint = await sharp(Buffer.from(star.replace(/<svg /, '<svg fill="#ffffff" fill-opacity="0.06" '))).resize(620, 620).extract({ left: 0, top: 200, width: 384, height: 420 }).png().toBuffer();
  const wordPng = await sharp(Buffer.from(word)).resize(420).png().toBuffer();
  const p1 = await phone("phone-home", 190);
  const p2 = await phone("phone-training", 190);
  await sharp({ create: { width: 1024, height: 500, channels: 4, background: DARK } })
    .composite([
      { input: faint, left: 640, top: 0 },
      { input: wordPng, left: 72, top: 220 },
      { input: p1, left: 600, top: 60 },
      { input: p2, left: 810, top: 60 },
    ])
    .flatten({ background: DARK })
    .png()
    .toFile(path.join(OUT, "feature-graphic-1024x500.png"));

  // The screenshots: each phone picture on the dark, 1080 × 1920.
  for (const [i, name] of ["phone-home", "phone-training", "phone-nutrition", "phone-lifestyle"].entries()) {
    const p = await phone(name, 800);
    await sharp({ create: { width: 1080, height: 1920, channels: 4, background: DARK } })
      .composite([{ input: p, left: 140, top: Math.round((1920 - (800 * 1688) / 780) / 2) }])
      .flatten({ background: DARK })
      .png()
      .toFile(path.join(OUT, `screenshot-${i + 1}-${name.replace("phone-", "")}.png`));
  }
  console.log(fs.readdirSync(OUT).join("\n"));
})();
