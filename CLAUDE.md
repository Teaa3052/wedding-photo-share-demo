# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

- The app is feature-complete. Upload, gallery, admin and Drive logic are finished and tested. Do NOT change them unless explicitly asked.
- Current work is visual design only: `public/styles.css` and `public/index.html` (plus rendering-only tweaks in `public/app.js` when needed).
- Do only what is asked. Don't refactor or "fix" unrelated parts along the way.
- After each change, briefly list the files you modified. Don't run `git commit` unless asked.

## Commands

```bash
npm install
npm start                  # node server.js on PORT (default 3000)
npm run dev                # node --watch server.js
npm run google:authorize   # one-off: prints a Google refresh token for GOOGLE_REFRESH_TOKEN in .env
gcloud app deploy          # deploy (App Engine standard, see Deployment)
```

There is no test suite, linter, or build step.

Local pages: `/` (guest gallery + upload), `/admin` (delete uploads; currently non-functional, see "Admin" below), `/health`. The printable QR sheet is not a
page: `npm run qr:print` writes plain `print/qr-a4.pdf`, `qr-a5.pdf` and `qr-a6.pdf` (table card) from `scripts/make-qr-print.mjs`, using
`BASE_URL` and `WEDDING_NAMES` from `app.yaml`.
Config comes from `.env` (copy `.env.example`); it contains live Google credentials, so don't print or commit it.

On this Windows setup, `kill $PID` from Git Bash does not stop a backgrounded `node server.js`. Find it with
`netstat -ano` / `tasklist //FI "IMAGENAME eq node.exe"` and stop it with `taskkill //PID <pid> //F`.

## Architecture

Guest photo-sharing site: QR code → single page → upload photos → stored in a Google Drive folder → shared gallery.
No database; **Google Drive is the only storage**. The backend authenticates as the wedding couple's own Google
account using a long-lived OAuth refresh token (scope `drive.file`); guests never sign in to anything.

- [server.js](server.js) — the whole backend (ESM, Express 5, `googleapis`). [public/](public/) is served statically
  with no bundler: vanilla JS in `app.js`, one shared `styles.css`, and `index.html`/`admin.html`.
  Any GET that is not `/api/*` or `/oauth2callback` falls through to `index.html`.
- **Secrets** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `ADMIN_PASSWORD`): read from env,
  and at startup any that are missing are fetched from Google Secret Manager when `GOOGLE_CLOUD_PROJECT` is set. That
  is how production runs — `app.yaml` deliberately does not contain them.
- **Drive folder**: `DRIVE_FOLDER_ID` if set, otherwise looked up/created by name (`WEDDING_NAMES`) and made
  link-readable. A second sibling folder `"<names> (previews)"` holds generated preview JPEGs.
- **Upload** (`POST /api/upload`): exactly one file per request (Busboy `files: 1`); the client loops through the
  selection sequentially and enforces `maxFilesPerBatch` itself. Server checks Drive quota (507 when full) and an
  in-memory rate limit of 600 uploads per 10 minutes per client IP. The limit is deliberately generous because all
  guests at the venue share one Wi-Fi IP; the IP comes from App Engine's `X-Appengine-User-Ip` header (falling back
  to `req.ip`) since `X-Forwarded-For` is client-controllable. Files above `COMPRESS_ABOVE_MB` (3, to save Drive space) are converted/resized to ≤4000px JPEG (HEIC goes through
  `heic-convert` first because sharp's build lacks a HEIC decoder); smaller files are stored untouched, and any
  compression failure falls back to storing the original.
- **Serving images**: three proxied endpoints, all with immutable cache headers — `/api/thumb/:id` (Drive's
  `thumbnailLink` at 500px, falling back to the preview), `/api/preview/:id` (1920px JPEG, generated on demand), and
  `/api/image/:id` (original stream, `?download=` sets `Content-Disposition`). `/api/files` lists 60 per page via
  Drive `pageToken`, and `app.js` polls it every 30s while the tab is visible.
- **Multi-instance design**: the app scales to many instances, so every in-memory cache (thumbs, previews, rate limit,
  storage-quota status) is per-instance. To avoid every instance redoing HEIC conversions, a generated preview is saved
  back to Drive and linked from the original via the private `appProperties.previewFileId`; `DELETE /api/files/:id`
  removes that preview too. A shared semaphore (3) caps concurrent HEIC/resize work across both uploads and previews to
  stay within instance memory.
- **Admin**: `DELETE /api/files/:id` requires `Authorization: Bearer <ADMIN_PASSWORD>`. Listing (`GET /api/files`) is
  public; the admin page just keeps the password in `sessionStorage`. Known issue: helmet's default CSP
  (`script-src 'self'`) blocks the inline `<script>` in `admin.html`, so its button does nothing. The couple does not
  use it (they delete photos directly in Drive, which leaves the preview JPEGs behind in the "(previews)" folder);
  fixing it means moving that script into an external file.
- **Guest page behavior**: `refresh()` (every 30 s) reloads only the newest page. Once a guest pressed "Učitaj još"
  (`extraPagesLoaded`) the older loaded pages are kept and merged instead of being dropped, and an open lightbox keeps
  pointing at the same photo when new uploads shift the indices. Upload feedback: `setStatus()` writes the status line
  under the hero button and, while the floating "+" button is visible (hero button out of view), mirrors it in the
  `#toast`; both upload buttons are disabled during an upload and when storage is full.

## Deployment

`app.yaml` targets **App Engine standard** (`nodejs22`, `F4` instance class for image-processing memory,
`max_concurrent_requests: 6`, `min_instances: 0` — meant to be raised to 1 shortly before the wedding). It holds the
non-secret env (`WEDDING_NAMES`, `WEDDING_DATE`, `BASE_URL`, `DRIVE_FOLDER_ID`, …). Upload limits are the same
everywhere (`server.js` defaults, the `config` fallback in `app.js`, `app.yaml`, `.env.example`, README):
`MAX_FILE_MB` 32 (App Engine's own request size limit, so a higher value could never be reached) and
`COMPRESS_ABOVE_MB` 3. `.env.example` is the env reference; `qrcode` is a devDependency (only the QR print script uses it).
While the Google OAuth app is in "Testing" mode, refresh tokens expire after 7 days. Secrets are read from Secret
Manager only when an instance starts, so after changing one (e.g. a new refresh token) redeploy.

## Design rules (guest page)

- Mobile-first: design for 360–430 px width; desktop is secondary. Guests open the page by scanning a QR code.
- The couple's names and the wedding date come from `WEDDING_NAMES` / `WEDDING_DATE`. Never hardcode them.
  Upload limits come from existing config (`MAX_FILE_MB`, `maxFilesPerBatch`); never hardcode those either.
- Two font families only: Crimson Pro (names, date, headings, thank-you line) and Nunito (all other text).
  No script fonts. The couple's names contain "&", so the heading font must have a plain, normal ampersand:
  don't go back to EB Garamond (its "&" is an ornate "Et" ligature the couple dislikes), and don't switch to
  Cormorant Garamond / Cormorant / Cormorant Infant (they render Croatian š/ž with a detached caron). Any new
  heading font must be checked with "Mladenka & Mladoženja" and "šžčćđ ŠŽČĆĐ" at a large size before adopting it.
  The printable QR sheets from `scripts/make-qr-print.mjs` use the same two fonts (`/admin` loads no web fonts).
- Colors: cream background, dark charcoal text; golden yellow only for the button, divider lines and hearts.
  All other color comes from the flowers and petals.
- Florals: only the two PNG bouquets (`public/bouquet-top-right.png`, `public/bouquet-bottom-left.png`) plus small
  CSS petals. Never draw or generate florals yourself (SVG, CSS or otherwise).
- `styles.css` is shared with `/admin`. Scope guest-page changes so they don't leak into that page.

## Conventions worth knowing

- All user-facing text (UI, server error messages, `lang="hr"`) is **Croatian**; keep new strings in Croatian. Plural
  forms go through `Intl.PluralRules('hr')`.
- "Improve the design" in this repo means the website's visual theme (`public/styles.css`, `index.html`).
