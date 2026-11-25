// Draws an iPhone status bar (9:41, the island, signal, wifi, battery) over the top of each phone picture, 780 wide
// (390 at 2x), and writes them as the website's jpgs. node statusbar.cjs <snapsDir> <outDir> name:colour ...
const path = require("path");
const sharp = require("C:/Users/alexa/Downloads/ironline_new/ironline/node_modules/sharp");
const [dir, out, ...pairs] = process.argv.slice(2);

const bar = (c) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="780" height="100" viewBox="0 0 390 50">
  <text x="68" y="33" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="17" fill="${c}">9:41</text>
  <rect x="133" y="11" width="124" height="36" rx="18" fill="#000"/>
  <g transform="translate(287 21)" fill="${c}">
    <rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/>
  </g>
  <g transform="translate(311 21)"><path fill="none" stroke="${c}" stroke-width="1.9" stroke-linecap="round" d="M1.2 4.2a10 10 0 0 1 13.6 0M3.8 7a6.2 6.2 0 0 1 8.4 0"/><circle cx="8" cy="10" r="1.5" fill="${c}"/></g>
  <g transform="translate(333 20)"><rect x=".7" y=".7" width="22.6" height="11.6" rx="3.6" fill="none" stroke="${c}" stroke-opacity=".45" stroke-width="1.2"/><rect x="2.4" y="2.4" width="19.2" height="8.2" rx="2.2" fill="${c}"/><path d="M25 4.4v4.2c.9-.3 1.5-1.2 1.5-2.1s-.6-1.8-1.5-2.1z" fill="${c}" fill-opacity=".5"/></g>
</svg>`);

(async () => {
  for (const p of pairs) {
    const [name, c, as] = p.split(":");
    const file = path.join(out, `${as || name}.jpg`);
    const info = await sharp(path.join(dir, `${name}.png`)).resize(780, 1688).composite([{ input: bar(c === "w" ? "#fff" : "#141a24"), top: 0, left: 0 }]).jpeg({ quality: 84, mozjpeg: true }).toFile(file);
    console.log(file, info.size);
  }
})();
