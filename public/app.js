const namesEl = document.getElementById('weddingNames');
const dateEl = document.getElementById('weddingDate');
const fileInput = document.getElementById('fileInput');
const chooseButton = document.getElementById('chooseButton');
const statusEl = document.getElementById('uploadStatus');
const gallery = document.getElementById('gallery');
const empty = document.getElementById('empty');
const memoriesCountEl = document.getElementById('memoriesCount');
const thanksEl = document.getElementById('thanks');
const loadMoreButton = document.getElementById('loadMoreButton');
const viewer = document.getElementById('viewer');
const viewerContent = document.getElementById('viewerContent');
const closeViewer = document.getElementById('closeViewer');
const viewerPrev = document.getElementById('viewerPrev');
const viewerNext = document.getElementById('viewerNext');
const fabButton = document.getElementById('fabButton');
const toastEl = document.getElementById('toast');

let config = { maxFileMb: 32, maxFilesPerBatch: 5 };
let loadedFiles = [];
let nextPageToken = null;
let extraPagesLoaded = false;
let viewerIndex = -1;

let toastTimer;
function showToast(text, isError, persist){
  toastEl.textContent = text;
  toastEl.classList.toggle('error', isError);
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  if(!persist) toastTimer = setTimeout(()=>toastEl.classList.remove('visible'), isError ? 7000 : 4000);
}
// The status line sits under the hero button. When the guest uploads through the floating "+" button (hero button
// scrolled out of view) the same message is mirrored in a toast, so progress and errors stay visible.
function setStatus(text, isError=false, persist=false){
  statusEl.textContent=text; statusEl.style.color=isError?'#9b4035':'';
  if(fabButton.classList.contains('visible')) showToast(text,isError,persist);
}

function formatCroatianDate(raw){
  if(!raw) return '';
  const parts = String(raw).split('.').map(p=>p.trim()).filter(Boolean);
  if(parts.length < 3) return raw;
  const [d,m,y] = parts;
  const day = parseInt(d,10), month = parseInt(m,10);
  if(Number.isNaN(day) || Number.isNaN(month)) return raw;
  return `${day}. ${month}. ${y}.`;
}

const hrPluralRules = new Intl.PluralRules('hr');
function memoriesLabel(n){
  const noun = hrPluralRules.select(n) === 'few' ? 'uspomene' : 'uspomena';
  return `${n} ${noun}`;
}
function photosLabel(n){
  const noun = hrPluralRules.select(n) === 'few' ? 'fotografije' : 'fotografija';
  return `${n} ${noun}`;
}

async function loadConfig(){
  const r=await fetch('/api/config');
  if(!r.ok) throw new Error('Konfiguracija se nije učitala.');
  config=await r.json();
  namesEl.textContent=config.weddingNames || 'Naše vjenčanje';
  dateEl.textContent=formatCroatianDate(config.weddingDate);
  document.title=`${config.weddingNames||'Naše vjenčanje'} • fotografije`;

  if(config.storageFull){
    chooseButton.disabled=true;
    fabButton.disabled=true;
    setStatus('Prostor za fotografije je pun. Nove fotografije trenutno nije moguće dodati.',true);
  } else if(config.storageNearFull){
    setStatus('Prostor za fotografije je gotovo pun — uskoro se možda neće moći dodavati nove fotke.');
  }
}

function render(files){
  gallery.innerHTML='';
  const n = files.length;
  memoriesCountEl.textContent = n ? memoriesLabel(n) : '';
  empty.classList.toggle('hidden', files.length>0);
  thanksEl.classList.toggle('hidden', files.length===0);
  files.forEach((file, index)=>{
    const item=document.createElement('article'); item.className='gallery-item';
    const src = file.thumbUrl || file.previewUrl;
    item.innerHTML=`<img loading="lazy" src="${src}" alt="${escapeHtml(file.name)}">`;
    const img = item.querySelector('img');
    const markLoaded=()=>img.classList.add('loaded');
    if(img.complete) markLoaded();
    else img.addEventListener('load', markLoaded, {once:true});
    item.addEventListener('click',()=>openViewerAt(index));
    gallery.appendChild(item);
  });
  loadMoreButton.classList.toggle('hidden', !nextPageToken);
}
function escapeHtml(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}

function renderViewer(){
  const file = loadedFiles[viewerIndex];
  if(!file) return;
  const fullSrc = file.viewUrl || file.previewUrl;
  viewerContent.innerHTML = `<div class="viewer-frame">
      <img class="viewer-blur" src="${file.thumbUrl || fullSrc}" alt="">
      <img class="viewer-full" src="${fullSrc}" alt="${escapeHtml(file.name)}">
    </div>
    <a class="download" href="${file.previewUrl}" download="${escapeHtml(file.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>Preuzmi original</a>`;
  const fullImg = viewerContent.querySelector('.viewer-full');
  const markLoaded=()=>fullImg.classList.add('loaded');
  if(fullImg.complete) markLoaded();
  else fullImg.addEventListener('load',markLoaded,{once:true});
  setupShareDownload(viewerContent.querySelector('.download'), file);
  updateViewerNav();
}

// iOS: every browser there is WebKit and a normal download always lands in the Files app, never in Photos. The share
// sheet ("Spremi sliku") is the only way into Photos, but Safari allows navigator.share() only right inside the tap,
// so the original is fetched as soon as the photo opens and the tap just shares the ready File. Android and desktop
// keep the plain download (Android shows the Download folder in its gallery anyway).
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
const canShareFiles = isIOS && typeof navigator.share==='function' && typeof navigator.canShare==='function';
const shareFiles = new Map(); // url -> { controller, file }; only the photo currently open, so memory stays flat
const MIME_EXT = { 'image/jpeg':'jpg', 'image/png':'png', 'image/heic':'heic', 'image/heif':'heif', 'image/webp':'webp', 'image/gif':'gif' };

function releaseShareFiles(keepUrl){
  for(const [url, entry] of shareFiles){
    if(url===keepUrl) continue;
    entry.controller.abort();
    shareFiles.delete(url);
  }
}
function prepareShareFile(url, name){
  if(shareFiles.has(url)) return shareFiles.get(url);
  const entry = { controller: new AbortController(), file: null };
  entry.ready = fetch(url, { signal: entry.controller.signal })
    .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
    .then(blob=>{
      const type = blob.type || 'image/jpeg';
      const ext = MIME_EXT[type] || type.split('/')[1] || 'jpg';
      const base = String(name).replace(/\.[^.]+$/, '') || 'fotografija';
      entry.file = new File([blob], `${base}.${ext}`, { type });
    })
    .catch(()=>{ shareFiles.delete(url); });
  shareFiles.set(url, entry);
  return entry;
}
function setupShareDownload(link, file){
  if(!canShareFiles || !link) return;
  const url = link.getAttribute('href');
  releaseShareFiles(url);
  const entry = prepareShareFile(url, file.name);
  if(!entry.file){
    link.classList.add('preparing');
    link.setAttribute('aria-busy','true');
    entry.ready.finally(()=>{ link.classList.remove('preparing'); link.removeAttribute('aria-busy'); });
  }
  link.addEventListener('click', (e)=>{
    const entry = shareFiles.get(url);
    // Still preparing: ignore the tap rather than saving a second copy to Files.
    if(entry && !entry.file){ e.preventDefault(); return; }
    const ready = entry?.file;
    // Preparing failed or not shareable: let the normal download happen.
    if(!ready || !navigator.canShare({ files:[ready] })) return;
    e.preventDefault();
    // Files only: with title/text added iOS sometimes shares the text instead of the image.
    navigator.share({ files:[ready] }).catch(err=>{
      if(err?.name==='AbortError') return;
      window.location.href = url;
    });
  });
}
viewer.addEventListener('close', ()=>releaseShareFiles(null));
function updateViewerNav(){
  viewerPrev.classList.toggle('hidden', viewerIndex<=0);
  viewerNext.classList.toggle('hidden', viewerIndex>=loadedFiles.length-1);
}
function openViewerAt(index){
  const file = loadedFiles[index];
  if(!file) return;
  viewerIndex = index;
  renderViewer();
  if(typeof viewer.showModal==='function') viewer.showModal();
  else window.open(file.openUrl,'_blank','noopener');
}
function showPrev(){ if(viewerIndex>0){ viewerIndex--; renderViewer(); } }
function showNext(){ if(viewerIndex<loadedFiles.length-1){ viewerIndex++; renderViewer(); } }
closeViewer.addEventListener('click',()=>viewer.close());
viewer.addEventListener('click',e=>{if(e.target===viewer) viewer.close();});
viewerPrev.addEventListener('click', showPrev);
viewerNext.addEventListener('click', showNext);
document.addEventListener('keydown', (e)=>{
  if(!viewer.open) return;
  if(e.key==='ArrowLeft') showPrev();
  else if(e.key==='ArrowRight') showNext();
});

let touchStartX=0, touchStartY=0, touchActive=false;
viewer.addEventListener('touchstart', (e)=>{
  if(e.touches.length!==1) return;
  touchActive=true;
  touchStartX=e.touches[0].clientX;
  touchStartY=e.touches[0].clientY;
}, {passive:true});
viewer.addEventListener('touchend', (e)=>{
  if(!touchActive) return;
  touchActive=false;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  const absX=Math.abs(dx), absY=Math.abs(dy);
  if(absX>60 && absX>absY){ dx<0 ? showNext() : showPrev(); }
  else if(dy>80 && absY>absX){ viewer.close(); }
}, {passive:true});

async function fetchFilesPage(pageToken){
  const url = pageToken ? `/api/files?pageToken=${encodeURIComponent(pageToken)}` : '/api/files';
  const r=await fetch(url);
  const d=await r.json();
  if(!r.ok) throw new Error(d.error||'Greška pri učitavanju galerije.');
  return d;
}

async function refresh(){
  try{
    const d = await fetchFilesPage();
    const newest = d.files || [];
    const openId = viewer.open ? loadedFiles[viewerIndex]?.id : null;
    if(extraPagesLoaded){
      // The guest already pressed "Učitaj još": refresh only the newest page and keep the older pages they
      // loaded, instead of throwing them away on every 30-second poll.
      const newestIds = new Set(newest.map(f=>f.id));
      loadedFiles = newest.concat(loadedFiles.filter(f=>!newestIds.has(f.id)));
    }else{
      loadedFiles = newest;
      nextPageToken = d.nextPageToken || null;
    }
    // New uploads shift every index; keep the open lightbox pointing at the photo the guest is looking at.
    if(openId){
      const i = loadedFiles.findIndex(f=>f.id===openId);
      if(i>=0){ viewerIndex=i; updateViewerNav(); }
    }
    render(loadedFiles);
  }catch(e){
    memoriesCountEl.textContent=e.message;
  }
}

async function loadMore(){
  if(!nextPageToken) return;
  loadMoreButton.disabled=true;
  loadMoreButton.textContent='Učitavam...';
  try{
    const d = await fetchFilesPage(nextPageToken);
    const seen = new Set(loadedFiles.map(f=>f.id));
    loadedFiles = loadedFiles.concat((d.files || []).filter(f=>!seen.has(f.id)));
    nextPageToken = d.nextPageToken || null;
    extraPagesLoaded = true;
    render(loadedFiles);
  }catch(e){
    setStatus(e.message,true);
  }finally{
    loadMoreButton.disabled=false;
    loadMoreButton.textContent='Učitaj još fotografija';
  }
}

async function uploadOne(file, index, total){
  if(file.size > Number(config.maxFileMb)*1024*1024){
    throw new Error(`${file.name} je veći od ${config.maxFileMb} MB.`);
  }
  setStatus(`Učitavam ${index}/${total} • ${file.name}`,false,true);
  const fd=new FormData();
  fd.append('file',file,file.name);
  const r=await fetch('/api/upload',{method:'POST',body:fd});
  const d=await r.json();
  if(!r.ok) throw new Error(d.error || `Upload ${file.name} nije uspio.`);
}

chooseButton.addEventListener('click',()=>fileInput.click());
loadMoreButton.addEventListener('click',loadMore);
fabButton.addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',async()=>{
  const files=Array.from(fileInput.files || []);
  if(!files.length) return;
  const maxFiles=Number(config.maxFilesPerBatch)||5;
  if(files.length>maxFiles){
    setStatus(`Odabrano je previše fotografija odjednom. Odaberi najviše ${maxFiles} fotki po uploadu.`,true);
    fileInput.value='';
    return;
  }
  chooseButton.disabled=true;
  fabButton.disabled=true;
  try{
    for(let i=0;i<files.length;i++) await uploadOne(files[i],i+1,files.length);
    setStatus(`Gotovo — ${photosLabel(files.length)}. ♥`);
    await refresh();
  }catch(e){
    setStatus(e.message || 'Upload nije uspio.',true);
    await refresh();
    await loadConfig();
  }finally{
    chooseButton.disabled=!!config.storageFull;
    fabButton.disabled=!!config.storageFull;
    fileInput.value='';
  }
});

if('IntersectionObserver' in window){
  const heroButtonObserver = new IntersectionObserver((entries)=>{
    fabButton.classList.toggle('visible', !entries[0].isIntersecting);
  }, {threshold:0});
  heroButtonObserver.observe(chooseButton);
}

setInterval(()=>{ if(document.visibilityState==='visible') refresh(); }, 30000);

(async()=>{
  try{ await loadConfig(); await refresh(); }
  catch(e){ setStatus(e.message,true); }
})();
