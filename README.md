# Taco Profile

A single-page profile site: five video themes with music, a typewriter intro,
a skills panel, a custom cursor and a few effects. Plain HTML, CSS and
JavaScript, with no build step and no dependencies, so it runs as-is on
GitHub Pages.

```
index.html          markup
style.css           all styling (the only stylesheet)
script.js           behaviour; edit CONFIG at the top to change text and themes
assets/             images, audio, fonts and videos
tools/encode-videos.sh   makes web-ready 4K + 1080p videos from your originals
.nojekyll           tells GitHub Pages to serve files as-is
```

## Run it locally

Open `index.html` directly, or serve the folder (better for video seeking):

```bash
python3 -m http.server 8000      # then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this folder to a repository.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, pick
   `main` and `/ (root)`.
3. Visit `https://<user>.github.io/<repo>/`.

All paths in the site are relative, so it works under `/<repo>/`.
GitHub Pages is case-sensitive: `assets/Angel_wish.ttf` is not `angel_wish.ttf`.

## 4K video

Each theme looks for its video in this order and plays the first one that works:

| Order | File                         | Used when                              |
| ----- | ---------------------------- | -------------------------------------- |
| 1     | `<name>_2160p.mp4`           | the device qualifies for 4K            |
| 2     | `<name>_1080p.mp4`           | 4K missing, unsupported or too slow    |
| 3     | `<name>.mp4` (`.mov` for rain) | your original file, as a last resort |

`<name>` is `background`, `hacker_background`, `rain_background`,
`anime_background` and `car_background` (see `CONFIG.themes` in `script.js`).

### Making the files

Put your originals in an `originals/` folder (named as above), then:

```bash
tools/encode-videos.sh              # originals/ → assets/
MAX_MB=40 FPS_CAP=30 tools/encode-videos.sh originals assets
```

Needs [ffmpeg](https://ffmpeg.org/download.html). The script:

- encodes H.264 High with `-movflags +faststart` so playback starts at once and
  seeking works over HTTP range requests (GitHub Pages supports them);
- caps each file at `MAX_MB` (default 45), lowering the bitrate for long clips;
- caps frame rate at 30 (`FPS_CAP=60` to keep 60), never upscales, and removes
  the audio track (the page mutes the video anyway).

### GitHub limits to know

- A single file over **100 MB is rejected** on push; over 50 MB gives a warning.
- A Pages site should stay under **1 GB** and roughly **100 GB/month** of traffic.
  Only the active theme's video is downloaded, never all five at once.
- **Git LFS does not work with Pages deployed from a branch** (visitors would get
  the pointer file, not the video). Keep videos as normal files under 100 MB,
  or host them elsewhere and change the paths in `script.js`.

### How "Auto" decides

On load the page picks 4K only when all of these hold: the screen is at least
2560 px on its long edge, it isn't a phone, Save-Data / 2G / 3G isn't on, and
the browser reports it can decode 4K smoothly (`mediaCapabilities`). Otherwise
it uses 1080p, since a smaller screen gains nothing from 4K.

While playing, it watches for dropped frames and buffering. If 4K struggles it
switches to 1080p for the session and shows a message. The quality button in the
dock cycles **Auto → 4K → 1080p** and always shows the resolution actually
playing, so you can confirm 4K is on. Your choice is remembered.

Browsers built without H.264 (some Linux Chromium builds) can't play the MP4s;
the page shows a message and the rest still works.

## Customising

- **Text, theme files, music, visitor start count:** `CONFIG` at the top of `script.js`.
- **Colours:** the `body.<theme>-theme` rules at the top of `style.css`.
  `--cursor-hue` tints the cursor image per theme.
- **Cursor:** `assets/custom_cursor.png` (the normal cursor stays if it's missing).

## Notes

- The visitor counter is stored in each visitor's own browser, so it is not a
  real site-wide count. A real one needs a backend or a counter service.
- Keyboard: `1`–`5` switch themes, `M` mutes.
- With "reduce motion" enabled, the typewriter, tilt, glitch, snow, matrix and
  cursor trail are turned off.
