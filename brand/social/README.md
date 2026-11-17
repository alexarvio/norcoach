# Norcoach social kit

Everything for Instagram posts, on the website's dark.

## Colours

| Use | Colour | RGB |
|---|---|---|
| Background (the dark) | `#1C1C1E` | 28, 28, 30 |
| Raised boxes on the dark | `#2C2C2E` | 44, 44, 46 |
| Thin lines on the dark | `#3A3A3C` | 58, 58, 60 |
| Main words | `#FFFFFF` | 255, 255, 255 |
| Second line, body words | `#C7C7CC` | 199, 199, 204 |
| Quiet words, the grey half of a headline | `#8E8E93` | 142, 142, 147 |
| The faded star | `#FFFFFF` at 5% opacity | |

For a light post (rare): background `#F5F5F5`, words `#141A24` (ink), and the ink logo.

## Font: Archivo

Free on Google Fonts: https://fonts.google.com/specimen/Archivo. Install it on your computer, and in Canva pick it from the font list (or upload it under Brand Kit if it isn't there).

| Use | Weight | Size and spacing |
|---|---|---|
| Headlines | SemiBold (600) | Big, letter spacing −3.5% (−0.035em), line height about 1.0 |
| Small label over a headline | SemiBold (600) | Small, ALL CAPS, letter spacing +16% (0.16em), grey `#8E8E93` |
| Body words | Medium (500) | Line height about 1.5, `#C7C7CC` |
| Big numbers | Light (300) | Only for a figure shown large |

Never Bold (700) or heavier. A headline can split in two like the website's: the first line white, the second grey (`Scale the quality` / `of your online coaching.`).

The NORCOACH word in the logo is a drawing, not a font: always use the logo files, never type it. In a sentence the name is written `Norcoach`, one word.

## Logos (`logos/`)

- `norcoach-logo-white`: star and word, for the dark. SVG (any size) and PNG (3000px wide, see-through background).
- `norcoach-logo-ink`: the same in ink, for light backgrounds.
- `norcoach-star-white` / `norcoach-star-ink`: the star alone.
- `norcoach-profile-picture.png`: the white star on the dark, 1080 × 1080, sized for Instagram's round crop.

Keep the logo as it is: the star as tall as the letters, side by side. Don't stretch it, recolour it or add effects.

## Templates (`templates/`)

The dark, the star huge and faint off the top right, the small white logo at the top left. Add the post's words on top.

- `instagram-post-4x5`: 1080 × 1350, the feed's usual post.
- `instagram-post-square`: 1080 × 1080.
- `instagram-story`: 1080 × 1920, the logo below the part Instagram covers with its own bar.

Each comes as a PNG, a PNG without the logo, and an SVG that can be opened in Figma or Canva.

## Remaking the kit

The dark comes from the website's own file (`website/site-bg.css`). If the website's colour changes, run `node brand/build-social.mjs` from the repo root and every file here is made again.
