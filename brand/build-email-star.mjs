// The big faint star behind the code email's dark head (25 Nov, Alex: "could we also have the logo like that there in
// the dark", the rail's, a touch stronger at 11% as mail is seen small, a third past the right edge). Baked into one PNG, its own offset in it, so a mail
// app only has to place it at the head's top right (`background-position: right top`); a mail app that shows no
// background images leaves the plain dark. Drawn at 2x, shown at 113 × 184.
//   node brand/build-email-star.mjs  →  public/brand/email-star.png
import fs from "node:fs";
import sharp from "sharp";

const S = 2; // 2x for sharp screens
const star = 170, top = 14, shown = Math.round(star * (2 / 3)); // a third past the right edge
const svg = fs.readFileSync("public/brand/mark.svg", "utf8").replace('fill="#141a24"', 'fill="#ffffff" fill-opacity="0.11"');
const box = /viewBox="([^"]+)"/.exec(svg)[1].split(" ").map(Number);
const h = Math.round(star * (box[3] / box[2]));
const drawn = await sharp(Buffer.from(svg.replace(/<svg /, `<svg width="${star * S}" height="${h * S}" `))).extract({ left: 0, top: 0, width: shown * S, height: h * S }).png().toBuffer();
await sharp({ create: { width: shown * S, height: (top + h) * S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: drawn, left: 0, top: top * S }])
  .png()
  .toFile("public/brand/email-star.png");
console.log("public/brand/email-star.png", shown, "x", top + h, "(1x)");
