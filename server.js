import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import Busboy from 'busboy';
import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { buffer as readStreamToBuffer } from 'node:stream/consumers';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SECRET_ENV_NAMES = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'ADMIN_PASSWORD'];

async function loadSecretsFromSecretManager() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!projectId) return;

  const missing = SECRET_ENV_NAMES.filter((name) => !process.env[name]);
  if (missing.length === 0) return;

  const client = new SecretManagerServiceClient();
  await Promise.all(
    missing.map(async (name) => {
      try {
        const [version] = await client.accessSecretVersion({
          name: `projects/${projectId}/secrets/${name}/versions/latest`
        });
        process.env[name] = version.payload.data.toString('utf8');
      } catch (error) {
        console.error(`Ne mogu dohvatiti tajnu ${name} iz Secret Managera:`, error.message);
      }
    })
  );
}

await loadSecretsFromSecretManager();

const app = express();
const PORT = Number(process.env.PORT || 3000);
// 32 MB is App Engine's own request size limit, so a larger value could never be reached anyway.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 32);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_FILES_PER_BATCH = Number(process.env.MAX_FILES_PER_BATCH || 5);

// Files larger than this get resized/recompressed before they're stored, so a
// guest's "High Efficiency"/HDR-quality phone photo doesn't get rejected just
// for being big, and doesn't eat 20-40MB of Drive quota per photo either.
// Anything smaller than this is stored exactly as the guest uploaded it.
const COMPRESS_ABOVE_MB = Number(process.env.COMPRESS_ABOVE_MB || 3);
const COMPRESS_ABOVE_BYTES = COMPRESS_ABOVE_MB * 1024 * 1024;
const UPLOAD_MAX_DIMENSION = 4000;

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const weddingNames = process.env.WEDDING_NAMES || 'Our Wedding';
const weddingDate = process.env.WEDDING_DATE || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';

let driveFolderIdCache = process.env.DRIVE_FOLDER_ID || '';
let driveClientCache = null;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    requiredEnv('GOOGLE_CLIENT_ID'),
    requiredEnv('GOOGLE_CLIENT_SECRET'),
    requiredEnv('GOOGLE_REDIRECT_URI')
  );
  oauth2Client.setCredentials({ refresh_token: requiredEnv('GOOGLE_REFRESH_TOKEN') });
  return oauth2Client;
}

function getDrive() {
  if (!driveClientCache) {
    driveClientCache = google.drive({ version: 'v3', auth: getOAuthClient() });
  }
  return driveClientCache;
}

async function ensureDriveFolder() {
  if (driveFolderIdCache) return driveFolderIdCache;

  const drive = getDrive();
  const escapedName = weddingNames.replace(/'/g, "\\'");
  const list = await drive.files.list({
    q: `name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 10
  });

  if (list.data.files?.length) {
    driveFolderIdCache = list.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: weddingNames,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id,name'
    });
    driveFolderIdCache = created.data.id;
  }

  await ensurePublicReader(drive, driveFolderIdCache);
  return driveFolderIdCache;
}

async function ensurePublicReader(drive, fileId) {
  const permissions = await drive.permissions.list({
    fileId,
    fields: 'permissions(id,type,role)',
    pageSize: 100
  });
  const alreadyPublic = (permissions.data.permissions || []).some(
    (permission) => permission.type === 'anyone' && permission.role === 'reader'
  );
  if (!alreadyPublic) {
    await drive.permissions.create({
      fileId,
      requestBody: {
        type: 'anyone',
        role: 'reader',
        allowFileDiscovery: false
      },
      fields: 'id,type,role'
    });
  }
}

function assertAdmin(req) {
  if (!adminPassword) throw Object.assign(new Error('ADMIN_PASSWORD is not configured.'), { status: 500 });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== adminPassword) throw Object.assign(new Error('Unauthorized.'), { status: 401 });
}

function isAllowedMime(mimeType) {
  return /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(mimeType);
}

const STORAGE_CACHE_MS = 60 * 1000;
const STORAGE_WARNING_RATIO = 0.9;
let storageStatusCache = null;

async function getStorageStatus() {
  if (storageStatusCache && Date.now() - storageStatusCache.fetchedAt < STORAGE_CACHE_MS) {
    return storageStatusCache.value;
  }

  const drive = getDrive();
  const about = await drive.about.get({ fields: 'storageQuota' });
  const quota = about.data.storageQuota || {};
  const limit = quota.limit ? Number(quota.limit) : null; // null = unlimited (Workspace) plan
  const usage = Number(quota.usage || 0);
  const remaining = limit === null ? Infinity : limit - usage;

  const value = {
    limit,
    usage,
    remaining,
    full: remaining < MAX_FILE_BYTES,
    nearFull: limit !== null && usage / limit >= STORAGE_WARNING_RATIO,
    usedPercent: limit ? Math.round((usage / limit) * 100) : null
  };

  storageStatusCache = { value, fetchedAt: Date.now() };
  return value;
}

function humanError(error) {
  const reason = error?.response?.data?.error?.errors?.[0]?.reason;
  if (reason === 'storageQuotaExceeded') return 'Google Drive nema više slobodnog prostora.';
  if (error?.code === 401) return 'Google autorizacija više nije valjana. Potrebno je ponovno autorizirati Google račun.';
  if (error?.code === 403) return 'Google Drive je odbio zahtjev. Provjeri dozvole i kvotu.';
  return error?.message || 'Dogodila se greška.';
}

app.get('/api/config', async (req, res) => {
  let storage = { full: false, nearFull: false, usedPercent: null };
  try {
    storage = await getStorageStatus();
  } catch (error) {
    console.error('Provjera prostora na Driveu nije uspjela:', error.message);
  }

  res.json({
    weddingNames,
    weddingDate,
    maxFileMb: MAX_FILE_MB,
    maxFilesPerBatch: MAX_FILES_PER_BATCH,
    storageFull: storage.full,
    storageNearFull: storage.nearFull,
    storageUsedPercent: storage.usedPercent
  });
});

app.get('/api/image/:id', async (req, res) => {
  try {
    const drive = getDrive();
    const fileId = req.params.id;

    const meta = await drive.files.get({ fileId, fields: 'mimeType' });
    const driveRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (req.query.download) {
      const safeName = String(req.query.download).replace(/[\r\n"]/g, '_').slice(0, 200);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }

    driveRes.data
      .on('error', (error) => {
        console.error(error);
        if (!res.headersSent) res.status(500);
        res.end();
      })
      .pipe(res);
  } catch (error) {
    console.error(error);
    res.status(error?.status || error?.code || 500).end();
  }
});

const PREVIEW_TRANSFORMABLE = /^image\/(jpeg|png|webp|avif|heic|heif)$/;
const HEIC_TYPES = /^image\/(heic|heif)$/;
const PREVIEW_CACHE_MAX = 150;
const previewCache = new Map();

function cachePreviewLocally(fileId, buffer) {
  if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value);
  previewCache.set(fileId, buffer);
}

// Caps how many photos THIS instance decodes/resizes at once. HEIC conversion
// and 1920px resizing are the heaviest work the app does — without a limit, a
// burst of uploads/views could try to do dozens at once and run the instance
// out of memory. Extra requests just wait briefly instead of piling on.
function createSemaphore(max) {
  let active = 0;
  const queue = [];
  function release() {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }
  }
  return {
    acquire() {
      return new Promise((resolve) => {
        if (active < max) { active++; resolve(release); }
        else queue.push(() => resolve(release));
      });
    }
  };
}
const previewSemaphore = createSemaphore(3);

let previewFolderIdCache = '';

async function ensurePreviewFolder() {
  if (previewFolderIdCache) return previewFolderIdCache;

  const drive = getDrive();
  const folderName = `${weddingNames} (previews)`;
  const escapedName = folderName.replace(/'/g, "\\'");
  const list = await drive.files.list({
    q: `name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: 10
  });

  if (list.data.files?.length) {
    previewFolderIdCache = list.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id'
    });
    previewFolderIdCache = created.data.id;
  }

  return previewFolderIdCache;
}

// The app can run as several instances at once under load. Each instance's
// previewCache above is local to itself, so without this, every instance
// would redo the same HEIC conversion/resize the first time it sees a photo.
// Saving the result back to Drive (linked via a private appProperty on the
// original file) means only the very first instance to touch a photo does
// the heavy work — every other instance, and every later request, just
// downloads the already-made JPEG.
async function saveSharedPreview(fileId, buffer) {
  const drive = getDrive();
  const folderId = await ensurePreviewFolder();
  const created = await drive.files.create({
    requestBody: { name: `${fileId}.jpg`, parents: [folderId] },
    media: { mimeType: 'image/jpeg', body: Readable.from(buffer) },
    fields: 'id'
  });
  await drive.files.update({
    fileId,
    requestBody: { appProperties: { previewFileId: created.data.id } }
  });
}

async function fetchPreview(fileId) {
  const cached = previewCache.get(fileId);
  if (cached) return cached;

  const drive = getDrive();
  const meta = await drive.files.get({ fileId, fields: 'mimeType, appProperties' });
  const mimeType = meta.data.mimeType || '';

  const sharedPreviewId = meta.data.appProperties?.previewFileId;
  if (sharedPreviewId) {
    try {
      const driveRes = await drive.files.get({ fileId: sharedPreviewId, alt: 'media' }, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(driveRes.data);
      cachePreviewLocally(fileId, buffer);
      return buffer;
    } catch (error) {
      console.error('Dijeljeni preview nije dostupan, generiram ponovno:', error.message);
    }
  }

  const release = await previewSemaphore.acquire();
  let buffer;
  try {
    let sourceBuffer;
    if (HEIC_TYPES.test(mimeType)) {
      // sharp's HEIC decoder is disabled in the default build (HEVC licensing), so
      // HEIC/HEIF from iPhones is converted to JPEG separately before resizing.
      const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
      const heicBuffer = Buffer.from(driveRes.data);
      sourceBuffer = Buffer.from(await heicConvert({ buffer: heicBuffer, format: 'JPEG', quality: 0.9 }));
    } else {
      const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
      sourceBuffer = Buffer.from(driveRes.data);
    }

    // failOn: 'none' — phones and messaging apps produce slightly malformed JPEGs
    // that browsers show fine but libvips rejects by default ("Invalid SOS parameters").
    buffer = await sharp(sourceBuffer, { failOn: 'none' })
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } finally {
    release();
  }

  cachePreviewLocally(fileId, buffer);
  saveSharedPreview(fileId, buffer).catch((error) => console.error('Spremanje dijeljenog previewa nije uspjelo:', error.message));
  return buffer;
}

function warmCache(fileId, mimeType) {
  fetchThumbnail(fileId).catch((error) => console.error('Priprema sličice nije uspjela:', error.message));
  if (PREVIEW_TRANSFORMABLE.test(mimeType || '')) {
    fetchPreview(fileId).catch((error) => console.error('Priprema previewa nije uspjela:', error.message));
  }
}

app.get('/api/preview/:id', async (req, res) => {
  try {
    const buffer = await fetchPreview(req.params.id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).end();
  }
});

const THUMB_CACHE_MAX = 400;
const thumbCache = new Map();

async function fetchThumbnail(fileId) {
  const cached = thumbCache.get(fileId);
  if (cached) return cached;

  const drive = getDrive();
  const meta = await drive.files.get({ fileId, fields: 'thumbnailLink' });
  if (!meta.data.thumbnailLink) return null;

  const thumbUrl = meta.data.thumbnailLink.replace(/=s\d+$/, '=s500');
  const thumbRes = await fetch(thumbUrl);
  if (!thumbRes.ok || !thumbRes.body) throw new Error('Dohvat sličice nije uspio.');

  const entry = {
    buffer: Buffer.from(await thumbRes.arrayBuffer()),
    contentType: thumbRes.headers.get('content-type') || 'image/jpeg'
  };

  if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
  thumbCache.set(fileId, entry);
  return entry;
}

app.get('/api/thumb/:id', async (req, res) => {
  try {
    const entry = await fetchThumbnail(req.params.id);
    if (entry) {
      res.setHeader('Content-Type', entry.contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(entry.buffer);
    }

    // Drive didn't generate a thumbnail (can happen for some HEIC files) — fall
    // back to our own resized preview instead of the raw, possibly unviewable file.
    const buffer = await fetchPreview(req.params.id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).end();
  }
});

const FILES_PAGE_SIZE = 60;

app.get('/api/files', async (req, res) => {
  try {
    const folderId = await ensureDriveFolder();
    const drive = getDrive();
    const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined;
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      orderBy: 'createdTime desc',
      pageSize: FILES_PAGE_SIZE,
      pageToken,
      fields: 'nextPageToken, files(id,name,mimeType,size,createdTime,webViewLink,resourceKey,thumbnailLink)',
      spaces: 'drive'
    });

    const files = (response.data.files || []).map((file) => {
      const previewUrl = `/api/image/${encodeURIComponent(file.id)}?download=${encodeURIComponent(file.name)}`;
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: Number(file.size || 0),
        createdTime: file.createdTime,
        thumbUrl: `/api/thumb/${encodeURIComponent(file.id)}`,
        viewUrl: PREVIEW_TRANSFORMABLE.test(file.mimeType || '') ? `/api/preview/${encodeURIComponent(file.id)}` : previewUrl,
        previewUrl,
        openUrl: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`
      };
    });

    res.json({ files, nextPageToken: response.data.nextPageToken || null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: humanError(error) });
  }
});

const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
// All guests on the venue's Wi-Fi share one public IP, so this has to be generous: it is only there to stop a
// runaway script, not to slow down real guests (each photo is one upload request).
const UPLOAD_MAX_PER_WINDOW = 600;
const uploadAttempts = new Map();

// App Engine sets X-Appengine-User-Ip itself, while X-Forwarded-For starts with whatever the client sent,
// so `trust proxy: true` alone would let anyone dodge the limit by sending a fake X-Forwarded-For.
function clientIp(req) {
  return req.get('x-appengine-user-ip') || req.ip;
}

function checkUploadRateLimit(ip) {
  const now = Date.now();
  const entry = uploadAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    uploadAttempts.set(ip, { count: 1, resetAt: now + UPLOAD_WINDOW_MS });
    return true;
  }
  if (entry.count >= UPLOAD_MAX_PER_WINDOW) return false;
  entry.count += 1;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of uploadAttempts) {
    if (now > entry.resetAt) uploadAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

app.post('/api/upload', async (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'Upload mora biti multipart/form-data.' });
  }

  if (!checkUploadRateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Previše uploada u kratkom vremenu. Pričekaj par minuta pa pokušaj ponovno.' });
  }

  try {
    const storage = await getStorageStatus();
    if (storage.full) {
      return res.status(507).json({ error: 'Nema više prostora za nove fotografije. Javi se mladencima.' });
    }
  } catch (error) {
    console.error('Provjera prostora na Driveu nije uspjela:', error.message);
  }

  const bb = Busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fileSize: MAX_FILE_BYTES,
      fields: 3,
      fieldSize: 2000
    }
  });

  let uploadPromise = null;
  let fileSeen = false;
  let uploadError = null;

  bb.on('file', (name, file, info) => {
    fileSeen = true;
    const { filename, mimeType } = info;

    if (name !== 'file') {
      file.resume();
      uploadError = Object.assign(new Error('Neispravno polje za datoteku.'), { status: 400 });
      return;
    }

    if (!isAllowedMime(mimeType)) {
      file.resume();
      uploadError = Object.assign(new Error('Dopuštene su samo fotografije (JPG, PNG, WebP, GIF, HEIC/HEIF ili AVIF).'), { status: 400 });
      return;
    }

    uploadPromise = (async () => {
      const folderId = await ensureDriveFolder();
      const drive = getDrive();
      const originalBuffer = await readStreamToBuffer(file);
      if (file.truncated) {
        throw Object.assign(new Error(`Datoteka je veća od ${MAX_FILE_MB} MB.`), { status: 400 });
      }

      let uploadBuffer = originalBuffer;
      let uploadMimeType = mimeType;
      let convertedToJpeg = false;

      if (originalBuffer.length > COMPRESS_ABOVE_BYTES) {
        const release = await previewSemaphore.acquire();
        try {
          const sourceForSharp = HEIC_TYPES.test(mimeType)
            ? Buffer.from(await heicConvert({ buffer: originalBuffer, format: 'JPEG', quality: 0.92 }))
            : originalBuffer;

          uploadBuffer = await sharp(sourceForSharp, { failOn: 'none' })
            .rotate()
            .resize({ width: UPLOAD_MAX_DIMENSION, height: UPLOAD_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 90 })
            .toBuffer();
          uploadMimeType = 'image/jpeg';
          convertedToJpeg = true;
        } catch (error) {
          // If compression fails for any reason, fall back to storing the
          // original untouched rather than losing the guest's photo.
          console.error('Kompresija slike nije uspjela, spremam original:', error.message);
          uploadBuffer = originalBuffer;
          uploadMimeType = mimeType;
          convertedToJpeg = false;
        } finally {
          release();
        }
      }

      let finalName = path.basename(filename || 'upload').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 180) || 'upload';
      if (convertedToJpeg) finalName = finalName.replace(/\.[^.]*$/, '') + '.jpg';

      const created = await drive.files.create({
        requestBody: {
          name: finalName,
          parents: [folderId]
        },
        media: {
          mimeType: uploadMimeType,
          body: Readable.from(uploadBuffer)
        },
        fields: 'id,name,mimeType,size,createdTime,webViewLink'
      });

      return created.data;
    })().catch((error) => {
      uploadError = error;
      file.resume();
      return null;
    });
  });

  bb.on('filesLimit', () => {
    uploadError = Object.assign(new Error('Možeš poslati samo jednu datoteku po uploadu.'), { status: 400 });
  });

  bb.on('error', (error) => {
    uploadError = error;
  });

  bb.on('finish', async () => {
    try {
      if (uploadError) throw uploadError;
      if (!fileSeen) throw Object.assign(new Error('Nije pronađena datoteka.'), { status: 400 });
      const file = uploadPromise ? await uploadPromise : null;
      if (!file) throw uploadError || new Error('Upload nije uspio.');

      warmCache(file.id, file.mimeType);

      res.status(201).json({
        ok: true,
        file: {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          size: Number(file.size || 0),
          createdTime: file.createdTime,
          previewUrl: `/api/image/${encodeURIComponent(file.id)}`,
          openUrl: file.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`
        }
      });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(error?.status || 500).json({ error: humanError(error) });
    }
  });

  req.pipe(bb);
  return undefined;
});

app.delete('/api/files/:id', async (req, res) => {
  try {
    assertAdmin(req);
    const drive = getDrive();

    let sharedPreviewId = null;
    try {
      const meta = await drive.files.get({ fileId: req.params.id, fields: 'appProperties' });
      sharedPreviewId = meta.data.appProperties?.previewFileId || null;
    } catch (error) {
      console.error('Provjera dijeljenog previewa prije brisanja nije uspjela:', error.message);
    }

    await drive.files.delete({ fileId: req.params.id });
    if (sharedPreviewId) drive.files.delete({ fileId: sharedPreviewId }).catch(() => {});

    thumbCache.delete(req.params.id);
    previewCache.delete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(error?.status || 500).json({ error: humanError(error) });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/oauth2callback') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Wedding Photo Share running on port ${PORT}`);
});
