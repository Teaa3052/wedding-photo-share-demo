# Wedding Photo Share — photos only

Minimal wedding photo-sharing app:

QR code -> website -> upload photos -> files go to Google Drive -> shared gallery.

**Live demo:** https://teaa3052.github.io/wedding-photo-share-demo/ (best viewed on a phone)

## Demo version

The live demo is a static build of the same guest page with no server or Google Drive behind it.
`demo/demo.js` is loaded before `public/app.js` and answers its `/api/*` requests in the browser: the gallery shows
sample photos, and "Dodaj fotografije" adds the chosen photos only to the visitor's own tab (nothing is uploaded or
stored). `app.js`, `styles.css` and `index.html` are the unchanged production files.

```bash
npm run demo:build   # writes demo-dist/
```

`.github/workflows/demo-pages.yml` builds and publishes `demo-dist/` to GitHub Pages on every push to `main`.

Sample photos are free-licence images from [Unsplash](https://unsplash.com/license), loaded from Unsplash's CDN:
[1](https://unsplash.com/photos/wedding-guests-toast-the-kissing-couple-with-raised-drinks-Tao4DFuqmsQ),
[2](https://unsplash.com/photos/man-in-blue-suit-kissing-woman-in-white-wedding-dress-dvF6s1H1x68),
[3](https://unsplash.com/photos/people-raising-wine-glass-in-selective-focus-photography-ULHxWq8reao),
[4](https://unsplash.com/photos/men-and-women-dancing-joyfully-at-an-outdoor-event-1Cz07Xm3lvY),
[5](https://unsplash.com/photos/bride-and-groom-standing-beside-brown-wooden-wall-JFAPl7brL6U),
[6](https://unsplash.com/photos/clear-wine-glass-lot-on-table-O38Id_cyV4M),
[7](https://unsplash.com/photos/a-bride-and-groom-dancing-at-their-wedding-reception-q5FNF6EEE30),
[8](https://unsplash.com/photos/man-and-woman-kissing-on-green-grass-field-during-sunset-5d4XBj7GYeo),
[9](https://unsplash.com/photos/couple-dancing-joyfully-at-a-lively-outdoor-party-DBkpJvEkuew),
[10](https://unsplash.com/photos/clear-long-stem-wine-glasses-on-table-hw_sKmjb0ns),
[11](https://unsplash.com/photos/people-in-white-dress-dancing-on-green-grass-field-during-daytime-riHGdvluDk8),
[12](https://unsplash.com/photos/photo-of-a-man-and-woman-newly-wedding-holding-a-balloons-mW8IZdX7n8E).

## What it does

- Uploads photos one at a time.
- Accepts JPG, PNG, WebP, GIF, HEIC/HEIF and AVIF.
- Default max photo size: 32 MB (App Engine's own request limit). Photos above 3 MB (`COMPRESS_ABOVE_MB`) are re-encoded to JPEG (max 4000 px) to save Drive space; smaller ones are stored untouched.
- Stores originals in a Google Drive folder owned by your Google account.
- Creates the Drive folder automatically if `DRIVE_FOLDER_ID` is blank.
- Makes the wedding folder link-viewable so guests do not need Google accounts.
- Shows a responsive photo gallery.
- Includes an admin page at `/admin` for deleting photos (password from `ADMIN_PASSWORD`). Deleting a photo there also removes its generated preview. The printable QR sheet is generated separately (`npm run qr:print`).
- Does not require a database.

## 1. Install Node.js

Use Node.js 22 or newer. Then open this project folder in VS Code and run:

```bash
npm install
```

## 2. Create the Google Cloud project

In Google Cloud Console:

1. Create a new project.
2. Enable **Google Drive API**.
3. Open **Google Auth Platform**.
4. Configure the app branding/consent screen.
5. Use an **External** audience for a normal Google account.
6. Add your own Google account as a test user while developing.
7. Under Data Access / scopes, add:
   `https://www.googleapis.com/auth/drive.file`
8. Create an OAuth client of type **Web application**.
9. Add this authorized redirect URI:
   `http://localhost:3000/oauth2callback`
10. Copy the Client ID and Client Secret.

## 3. Configure `.env`

Copy `.env.example` to `.env` and set:

```text
PORT=3000
BASE_URL=http://localhost:3000
WEDDING_NAMES=
WEDDING_DATE=
MAX_FILE_MB=32
COMPRESS_ABOVE_MB=3
MAX_FILES_PER_BATCH=5
ADMIN_PASSWORD=choose-a-strong-password
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
GOOGLE_REFRESH_TOKEN=
DRIVE_FOLDER_ID=
```

Leave `DRIVE_FOLDER_ID` blank for automatic folder creation.

Do not upload `.env` to GitHub or to App Engine (it is listed in `.gcloudignore`).

## 4. Authorize the wedding Google account

Run:

```bash
npm run google:authorize
```

Open the printed Google URL, choose the Google account that should own the wedding photos, and approve access.

The terminal will print a **refresh token**. Copy it into `.env` as `GOOGLE_REFRESH_TOKEN` for local runs. The deployed site reads it from Secret Manager instead (see step 8).

Do not share the refresh token with anyone.

## 5. Test locally

Run:

```bash
npm start
```

Open:

`http://localhost:3000`

Test with a few photos. The first gallery request/upload may create the wedding folder in Google Drive.

## 6. Important OAuth publishing note

While an OAuth app is in **Testing**, Google currently expires refresh tokens after 7 days. For a wedding that is more than 7 days away, do not rely on an old testing token; move the OAuth app to **In production** when you are ready, or re-authorize the account close to the event. Google says personal-use apps under 100 users do not have to complete OAuth verification, although an unverified-app warning can still appear during authorization.

Tokens issued while the app was in **Testing** keep expiring after 7 days even after the switch. So after moving to **In production**, run `npm run google:authorize` once more, store the new token as a new version of the `GOOGLE_REFRESH_TOKEN` secret (step 8) and redeploy.

Guests never authorize Google. Only the wedding Google account does.

## 7. Deploy to App Engine

The site runs on **App Engine standard** (`app.yaml`: runtime `nodejs22`, instance class `F4`). Install the Google Cloud CLI on Windows from Google's official installer, open a new terminal and run:

```bash
gcloud init
```

Choose the Google Cloud account and the project created above. Then enable the APIs and create the App Engine app (once per project):

```bash
gcloud services enable appengine.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
gcloud app create --region=europe-west1
```

From this project folder, deploy:

```bash
gcloud app deploy
```

The site is then available at `https://PROJECT-ID.REGION.r.appspot.com`. Put exactly that address into `BASE_URL` (and `GOOGLE_REDIRECT_URI`) in `app.yaml`; the QR sheets use it.

## 8. Configuration: app.yaml and Secret Manager

Do not upload `.env`.

Non-secret settings live in `app.yaml` under `env_variables`: `WEDDING_NAMES`, `WEDDING_DATE`, `BASE_URL`, `MAX_FILE_MB`, `COMPRESS_ABOVE_MB`, `GOOGLE_REDIRECT_URI` and `DRIVE_FOLDER_ID`. (`GOOGLE_REDIRECT_URI` must be set because the code requires it, but it is not used at runtime: the refresh token is enough.)

The four secrets are **not** in `app.yaml`. Create them in Secret Manager under exactly these names: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` and `ADMIN_PASSWORD`. Then let the App Engine service account read each of them:

```bash
gcloud secrets add-iam-policy-binding GOOGLE_REFRESH_TOKEN --member="serviceAccount:PROJECT-ID@appspot.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

At startup the server reads every secret that is missing from the environment from Secret Manager (the `latest` version). Instances read them **only when they start**, so after adding a new secret version (for example a new refresh token) run `gcloud app deploy` again.

You do not need to set `PORT`; App Engine supplies it.

## 9. Keep the app warm for the wedding

App Engine can scale to zero (`min_instances: 0` in `app.yaml`). To avoid the first-request cold start around the wedding, set `min_instances: 1` under `automatic_scaling` in `app.yaml` a day or two before and run `gcloud app deploy`. After the wedding set it back to `0` and deploy again.

Minimum instances can incur idle charges.
## 10. QR code

Once `BASE_URL` in `app.yaml` is the final public address, run:

```bash
npm run qr:print
```

This writes `print/qr-a4.pdf`, `print/qr-a5.pdf` and `print/qr-a6.pdf` (A6 is the table card; all ready to print, the
QR is vector) plus the standalone `print/qr-a4.html` / `qr-a5.html` / `qr-a6.html` they are rendered from. Names and address come from `app.yaml`; override them
with `--url=` and `--names=` if needed. Rendering the PDF needs Chrome or Edge (set `CHROME_PATH` if it is
not found automatically).

## Privacy

The wedding Drive folder is configured as link-viewable so guests can see the gallery without signing into Google. Anyone who obtains the public links can view the shared files.

## Storage

Google Drive is the main storage limit. A free Google account has 15 GB shared across Drive, Gmail and Google Photos. If needed later, increase Google storage.
