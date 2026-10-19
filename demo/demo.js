// Static demo: stands in for server.js inside the browser, so the unchanged app.js runs without a backend or Google
// Drive. Every fetch to /api/* is answered here; uploads become object URLs that live only in this visitor's tab.
// Loaded before app.js by scripts/build-demo.mjs; the real app never includes this file.
(() => {
  const PAGE_SIZE = 60;
  const UPLOAD_DELAY_MS = 450;

  // Free-licence photos from unsplash.com, served from Unsplash's own CDN (photo id -> page on unsplash.com in README).
  const SAMPLE_PHOTOS = [
    '1785744563469-9c1223bf2ebb',
    '1583939003579-730e3918a45a',
    '1527529482837-4698179dc6ce',
    '1784202388427-5c92c7a165a6',
    '1595407753234-0882f1e77954',
    '1519225421980-715cb0215aed',
    '1648154164366-d067faecdc51',
    '1606490194859-07c18c9f0968',
    '1758810409996-583f3bad7d51',
    '1502635385003-ee1e6a1a742d',
    '1583939411023-14783179e581',
    '1511285560929-80b456fea0bc'
  ];
  const unsplash = (id, width) => `https://images.unsplash.com/photo-${id}?auto=format&fit=max&q=75&w=${width}`;

  const config = {
    weddingNames: 'Mladenka & Mladoženja',
    weddingDate: '20.06.2026',
    maxFileMb: 32,
    maxFilesPerBatch: 5,
    storageFull: false,
    storageNearFull: false
  };

  let uploadCount = 0;
  const uploaded = []; // newest first, like the Drive listing
  const samples = SAMPLE_PHOTOS.map((id, i) => ({
    id: `sample-${i + 1}`,
    name: `vjencanje-${String(i + 1).padStart(2, '0')}.jpg`,
    mimeType: 'image/jpeg',
    thumbUrl: unsplash(id, 500),
    viewUrl: unsplash(id, 1920),
    previewUrl: unsplash(id, 2400),
    openUrl: unsplash(id, 2400)
  }));

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function listFiles(url) {
    const all = uploaded.concat(samples);
    const start = Number(url.searchParams.get('pageToken')) || 0;
    const files = all.slice(start, start + PAGE_SIZE);
    const next = start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null;
    return json({ files, nextPageToken: next });
  }

  async function upload(init) {
    const file = init?.body instanceof FormData ? init.body.get('file') : null;
    if (!(file instanceof File)) return json({ error: 'Nije pronađena datoteka.' }, 400);
    if (!file.type.startsWith('image/')) {
      return json({ error: 'Dopuštene su samo fotografije (JPG, PNG, WebP, GIF, HEIC/HEIF ili AVIF).' }, 400);
    }
    await wait(UPLOAD_DELAY_MS);
    const objectUrl = URL.createObjectURL(file);
    uploadCount += 1;
    const entry = {
      id: `upload-${uploadCount}`,
      name: file.name,
      mimeType: file.type,
      thumbUrl: objectUrl,
      viewUrl: objectUrl,
      previewUrl: objectUrl,
      openUrl: objectUrl
    };
    uploaded.unshift(entry);
    return json({ ok: true, file: entry }, 201);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init?.method || 'GET').toUpperCase();
    if (url.pathname === '/api/config') return json(config);
    if (url.pathname === '/api/files' && method === 'GET') return listFiles(url);
    if (url.pathname === '/api/upload' && method === 'POST') return upload(init);
    return json({ error: 'Nije dostupno u demo verziji.' }, 404);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const status = document.getElementById('uploadStatus');
    if (status && !status.textContent) {
      status.textContent = 'Demo verzija: fotke koje dodaš vidiš samo ti i nestaju kad zatvoriš stranicu.';
    }
  });
})();
