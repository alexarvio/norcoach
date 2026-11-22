// Small copies of the stock card pictures (22 Nov, Alex: "when I toggle to default pictures, they also took maybe a
// second to load"): each public/img/{lifestyle,training,nutrition}-*.jpg as public/img/thumb/<name>.webp, 240 wide
// (a 60px tile at 4×), cropped 3:4 as the tiles show it, for Settings · Branding's tiles; the originals stay for the
// cards and the large viewer. Run again when a stock picture is added: node scripts/stock-thumbs.mjs
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = path.join(process.cwd(), "public", "img");
const out = path.join(dir, "thumb");
fs.mkdirSync(out, { recursive: true });
const files = fs.readdirSync(dir).filter((f) => /^(lifestyle|training|nutrition)-.+\.jpg$/.test(f));
for (const f of files) {
  const to = path.join(out, f.replace(/\.jpg$/, ".webp"));
  await sharp(path.join(dir, f)).resize(240, 320, { fit: "cover", position: "attention" }).webp({ quality: 72 }).toFile(to);
  console.log(f, "→", path.relative(process.cwd(), to), `${Math.round(fs.statSync(to).size / 1024)} KB`);
}
