const passwordInput = document.getElementById('password');
const loadBtn = document.getElementById('load');
const box = document.getElementById('adminFiles');
const message = document.getElementById('message');
let password = sessionStorage.getItem('adminPassword') || '';
passwordInput.value = password;
function esc(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
async function load(){
  password = passwordInput.value;
  sessionStorage.setItem('adminPassword', password);
  message.textContent='';
  const r=await fetch('/api/files');
  const data=await r.json();
  box.innerHTML='';
  if(!r.ok){message.textContent=data.error||'Greška';return;}
  for(const f of data.files){
    const row=document.createElement('div'); row.className='admin-file';
    row.innerHTML=`<div><strong>${esc(f.name)}</strong><small>${esc(f.mimeType)} • ${Math.round(f.size/1024/1024*10)/10} MB</small></div><button data-id="${esc(f.id)}">Obriši</button>`;
    row.querySelector('button').onclick=async()=>{
      if(!confirm('Obrisati ovu datoteku iz Google Drivea?'))return;
      const d=await fetch('/api/files/'+encodeURIComponent(f.id),{method:'DELETE',headers:{Authorization:'Bearer '+password}});
      const body=await d.json(); if(!d.ok){message.textContent=body.error||'Greška';return;} load();
    };
    box.appendChild(row);
  }
}
loadBtn.onclick=load;
