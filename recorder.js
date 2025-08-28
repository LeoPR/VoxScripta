// recorder.js — integra persistência por sessão (IndexedDB), painel lateral com renome/apagar/export/import.
// Versão atualizada: adiciona showWaveform() para desenhar waveform estática ao selecionar gravação.

let mediaRecorder;
let audioChunks = [];
let recordings = []; // array em memória para "Sessão atual" (antes de salvar)
let currentIdx = -1;

const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const statusText = document.getElementById('status');
const audioPlayer = document.getElementById('audio-player');
const waveform = document.getElementById('waveform');
const spectrogramCanvas = document.getElementById('spectrogram');

const processingIndicator = document.getElementById('processing-indicator');
const processingProgress = document.getElementById('processing-progress');

const saveSessionBtn = document.getElementById('save-session-btn');
const exportSessionBtn = document.getElementById('export-session-btn');
const importSessionInput = document.getElementById('import-session-input');

let audioCtx, analyser, sourceNode, animationId, liveStream;
let spectrogramWorker = null;

// --- processingOptions (mantive igual) ---
window.processingOptions = {
  agc: {
    targetRMS: 0.08,
    maxGain: 8,
    limiterThreshold: 0.99
  },
  spectrogram: {
    fftSize: 2048,
    hopSize: 512,
    nMels: 64,
    windowType: 'hann',
    colormap: 'viridis'
  }
};

// ------------------------------
// INDEXEDDB (útil mínimo)
// ------------------------------
const DB_NAME = 'vox_db';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function saveSessionToDb(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const putReq = store.add(session);
    putReq.onsuccess = () => resolve(putReq.result);
    putReq.onerror = () => reject(putReq.error);
  });
}

async function getAllSessionsFromDb() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSessionById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readonly');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteSessionFromDb(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

async function updateSessionInDb(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.put(session);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// ------------------------------
// UI: Sessões + Gravações (painel esquerdo)
// ------------------------------
let sessionsCache = []; // carregado do DB
let selectedSessionId = null;
let currentSessionRecordings = []; // gravações da sessão selecionada carregadas da DB

function renderSessionsList() {
  const container = document.getElementById('sessions-list');
  container.innerHTML = '';
  sessionsCache.sort((a,b) => b.date - a.date);
  sessionsCache.forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === selectedSessionId ? ' selected' : '');
    const title = document.createElement('div');
    title.textContent = s.name || `Sessão ${new Date(s.date).toLocaleString()}`;
    item.appendChild(title);
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';
    const del = document.createElement('button');
    del.className = 'small';
    del.textContent = 'Apagar';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('Apagar sessão "' + (s.name || '') + '"?')) return;
      await deleteSessionFromDb(s.id);
      await loadSessions();
    };
    right.appendChild(del);
    item.appendChild(right);
    item.onclick = () => selectSession(s.id);
    container.appendChild(item);
  });
  if (sessionsCache.length === 0) {
    container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma sessão salva</div>';
  }
}

function renderRecordingsList(list) {
  const container = document.getElementById('recordings-list');
  container.innerHTML = '';
  const arr = list || [];
  arr.forEach((rec, idx) => {
    const item = document.createElement('div');
    item.className = 'recording-item' + (idx === currentIdx ? ' selected' : '');
    const name = document.createElement('div');
    name.className = 'recording-name';
    name.textContent = rec.name || `Gravação ${idx+1}`;
    item.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'recording-meta';
    meta.textContent = new Date(rec.date).toLocaleString();
    item.appendChild(meta);

    const play = document.createElement('button');
    play.className = 'play-btn';
    play.textContent = '▶';
    play.onclick = (ev) => {
      ev.stopPropagation();
      selectRecordingInUI(idx, rec);
    };
    item.appendChild(play);

    const rename = document.createElement('button');
    rename.className = 'rename-btn';
    rename.textContent = '✏️';
    rename.onclick = (ev) => {
      ev.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = rec.name || '';
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          rec.name = input.value;
          saveChangesToSessionRecording(rec);
        }
      };
      input.onblur = () => {
        rec.name = input.value;
        saveChangesToSessionRecording(rec);
      };
      name.innerHTML = '';
      name.appendChild(input);
      input.focus();
    };
    item.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.textContent = '🗑️';
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (!confirm('Apagar gravação?')) return;
      deleteRecordingFromSession(rec.id);
    };
    item.appendChild(del);

    item.onclick = () => selectRecordingInUI(idx, rec);
    container.appendChild(item);
  });
  if (arr.length === 0) {
    container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma gravação nesta sessão</div>';
  }
}

// seleciona uma sessão (carrega gravações)
async function selectSession(id) {
  selectedSessionId = id;
  const sess = await getSessionById(id);
  currentSessionRecordings = (sess && sess.recordings) ? sess.recordings.slice() : [];
  // atualiza o player/recordings em memória a partir da sessão selecionada
  recordings = currentSessionRecordings.map(r => ({ id: r.id, name: r.name, date: r.date, blob: r.blob, url: URL.createObjectURL(r.blob) }));
  currentIdx = recordings.length > 0 ? 0 : -1;
  if (currentIdx >= 0) {
    audioPlayer.src = recordings[0].url;
    audioPlayer.load();
  }
  await loadSessions();
  renderRecordingsList(recordings);
}

// ------------------------------
// NEW: showWaveform + static waveform drawing
// ------------------------------
async function showWaveform(source) {
  // source: Blob or URL string
  try {
    // stop live waveform animation if running
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    let arrayBuffer;
    if (source instanceof Blob) {
      arrayBuffer = await source.arrayBuffer();
    } else if (typeof source === 'string') {
      // fetch the URL (object URLs are fine)
      const resp = await fetch(source);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      console.warn('showWaveform: fonte não suportada', source);
      return;
    }
    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    // decodeAudioData may be promise-based or callback-based; modern browsers return a Promise
    const audioBuffer = await aCtx.decodeAudioData(arrayBuffer.slice(0));
    const samples = audioBuffer.getChannelData(0);
    drawWaveformFromSamples(samples);
    // close temporary AudioContext
    aCtx.close().catch(()=>{});
  } catch (err) {
    console.error('Erro em showWaveform:', err);
  }
}

function drawWaveformFromSamples(samples) {
  const dpr = window.devicePixelRatio || 1;
  const container = waveform.parentElement || document.body;
  const w = Math.min(940, container.clientWidth || 940);
  const h = parseInt(getComputedStyle(waveform).height, 10) || 180;

  waveform.width = Math.round(w * dpr);
  waveform.height = Math.round(h * dpr);
  waveform.style.width = w + 'px';
  waveform.style.height = h + 'px';

  const ctx = waveform.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1976d2';
  ctx.beginPath();

  // we draw min/max vertical lines per pixel column for a compact representation
  const step = Math.max(1, Math.floor(samples.length / w));
  for (let i = 0; i < w; i++) {
    const start = i * step;
    let min = 1.0, max = -1.0;
    for (let j = 0; j < step && (start + j) < samples.length; j++) {
      const v = samples[start + j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - (min + 1) / 2) * h;
    const y2 = (1 - (max + 1) / 2) * h;
    ctx.moveTo(i + 0.5, y1);
    ctx.lineTo(i + 0.5, y2);
  }
  ctx.stroke();
}

// seleciona gravação (no UI)
function selectRecordingInUI(idx, rec) {
  currentIdx = idx;
  // stop live waveform animation if running (we will draw static waveform)
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  if (rec && rec.url) {
    audioPlayer.src = rec.url;
    audioPlayer.load();
  } else if (rec && rec.blob) {
    const url = URL.createObjectURL(rec.blob);
    rec.url = url;
    audioPlayer.src = url;
    audioPlayer.load();
  }
  renderRecordingsList(recordings);
  // também processa (reprocess) para exibir espectrograma
  if (rec && rec.blob) {
    // show static waveform from the blob (decodes and draws)
    showWaveform(rec.blob).catch(()=>{});
    // process and show spectrogram (this will also set audioPlayer.src to processed wav blob)
    processAndPlayBlob(rec.blob).catch(()=>{});
  } else if (rec && rec.url) {
    // fallback: try to fetch via URL
    showWaveform(rec.url).catch(()=>{});
    // process by fetching the URL and passing its blob
    fetch(rec.url).then(r => r.blob()).then(b => processAndPlayBlob(b)).catch(()=>{});
  }
}

// salva gravação atual (após alteração de nome) de volta à sessão e atualiza DB
async function saveChangesToSessionRecording(updatedRec) {
  // atualiza currentSessionRecordings
  for (let i = 0; i < currentSessionRecordings.length; i++) {
    if (currentSessionRecordings[i].id === updatedRec.id) {
      currentSessionRecordings[i].name = updatedRec.name;
      break;
    }
  }
  // atualiza DB
  const sess = await getSessionById(selectedSessionId);
  if (!sess) return;
  sess.recordings = currentSessionRecordings;
  await updateSessionInDb(sess);
  // atualiza UI
  recordings = currentSessionRecordings.map(r => ({ id: r.id, name: r.name, date: r.date, blob: r.blob, url: URL.createObjectURL(r.blob) }));
  renderRecordingsList(recordings);
  await loadSessions();
}

// deleta gravação da sessão (e do DB)
async function deleteRecordingFromSession(recId) {
  const sess = await getSessionById(selectedSessionId);
  if (!sess) return;
  sess.recordings = (sess.recordings || []).filter(r => r.id !== recId);
  await updateSessionInDb(sess);
  await selectSession(selectedSessionId);
}

// carrega sessions e atualiza UI
async function loadSessions() {
  sessionsCache = await getAllSessionsFromDb();
  renderSessionsList();
}

// botão "Salvar sessão" — salva gravações correntes como nova sessão
saveSessionBtn.addEventListener('click', async () => {
  if (!recordings || recordings.length === 0) {
    alert('Nenhuma gravação para salvar nesta sessão.');
    return;
  }
  const name = prompt('Nome da sessão:', `Sessão ${new Date().toLocaleString()}`);
  if (!name) return;
  // preparar objetos que serão salvos no DB (copiar blobs)
  const recsForDb = recordings.map((r, idx) => ({
    id: Date.now() + idx,
    name: r.name || `Gravação ${idx+1}`,
    date: r.date || new Date().toISOString(),
    blob: r.blob || r.blob // blob existente
  }));
  const session = {
    name,
    date: Date.now(),
    recordings: recsForDb
  };
  await saveSessionToDb(session);
  await loadSessions();
  alert('Sessão salva.');
});

// botão export (exporta sessão selecionada)
exportSessionBtn.addEventListener('click', async () => {
  if (!selectedSessionId) { alert('Selecione uma sessão para exportar.'); return; }
  const sess = await getSessionById(selectedSessionId);
  if (!sess) { alert('Sessão não encontrada.'); return; }
  // converter blobs para base64
  const recs = await Promise.all((sess.recordings || []).map(async (r) => {
    const b = r.blob;
    const base64 = await blobToBase64(b);
    return { id: r.id, name: r.name, date: r.date, blobBase64: base64 };
  }));
  const out = { name: sess.name, date: sess.date, recordings: recs };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(sess.name||'session').replace(/\s+/g,'_')}-${sess.date}.json`;
  a.click();
});

// importar sessão (arquivo JSON com base64)
importSessionInput.addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const obj = JSON.parse(text);
    if (!obj || !obj.recordings) throw new Error('Formato inválido');
    // converter base64 de cada gravação para blob
    const recs = await Promise.all(obj.recordings.map(async (r) => {
      const blob = await base64ToBlob(r.blobBase64);
      return { id: r.id || (Date.now()+Math.random()), name: r.name || '', date: r.date || Date.now(), blob };
    }));
    const session = { name: obj.name || `Import ${new Date().toLocaleString()}`, date: Date.now(), recordings: recs };
    await saveSessionToDb(session);
    await loadSessions();
    alert('Sessão importada com sucesso.');
  } catch (err) {
    console.error(err);
    alert('Erro ao importar: ' + err.message);
  } finally {
    importSessionInput.value = '';
  }
});

// helpers base64/blobs
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = fr.result;
      const comma = dataUrl.indexOf(',');
      resolve(dataUrl.slice(comma + 1));
    };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
function base64ToBlob(base64) {
  return fetch('data:application/octet-stream;base64,' + base64).then(r => r.blob());
}

// ------------------------------
// Spectrogram worker + rendering (mantenho a versão robusta já usada)
// ------------------------------
const _vendorFFT = `(function(){class FFT{constructor(n){if(!Number.isInteger(Math.log2(n)))throw new Error('FFT size must be power of 2');this.n=n;this._buildReverseTable();this._buildTwiddles();}_buildReverseTable(){const n=this.n;const bits=Math.log2(n);this.rev=new Uint32Array(n);for(let i=0;i<n;i++){let x=i;let y=0;for(let j=0;j<bits;j++){y=(y<<1)|(x&1);x>>=1;}this.rev[i]=y;}}_buildTwiddles(){const n=this.n;this.cos=new Float32Array(n/2);this.sin=new Float32Array(n/2);for(let i=0;i<n/2;i++){const angle=-2*Math.PI*i/n;this.cos[i]=Math.cos(angle);this.sin[i]=Math.sin(angle);}}transform(real,imag){const n=this.n;const rev=this.rev;for(let i=0;i<n;i++){const j=rev[i];if(j>i){const tr=real[i];real[i]=real[j];real[j]=tr;const ti=imag[i];imag[i]=imag[j];imag[j]=ti;}}for(let size=2;size<=n;size<<=1){const half=size>>>1;const step=this.n/size;for(let i=0;i<n;i+=size){let k=0;for(let j=i;j<i+half;j++){const cos=this.cos[k];const sin=this.sin[k];const l=j+half;const tre=cos*real[l]-sin*imag[l];const tim=cos*imag[l]+sin*real[l];real[l]=real[j]-tre;imag[l]=imag[j]-tim;real[j]+=tre;imag[j]+=tim;k+=step;}}}}}if(typeof self!=='undefined')self.FFT=FFT;if(typeof window!=='undefined')window.FFT=FFT;})();`;

const _workerCode = `(function(){
  function hannWindow(size){const w=new Float32Array(size);if(size===1){w[0]=1.0;return w;}for(let i=0;i<size;i++){w[i]=0.5*(1-Math.cos((2*Math.PI*i)/(size-1)));}return w;}
  function hzToMel(f){return 2595*Math.log10(1+f/700);}
  function melToHz(m){return 700*(Math.pow(10,m/2595)-1);}
  function createMelFilterbank(nMels,fftSize,sampleRate,fmin,fmax){
    fmax=fmax||sampleRate/2;if(fmin<0)fmin=0;
    const melMin=hzToMel(fmin);const melMax=hzToMel(fmax);
    const meltabs=new Float32Array(nMels+2);
    for(let i=0;i<meltabs.length;i++){meltabs[i]=melToHz(melMin+(i/(nMels+1))*(melMax-melMin));}
    const binFreqs=new Float32Array(fftSize/2+1);
    for(let i=0;i<binFreqs.length;i++)binFreqs[i]=i*(sampleRate/fftSize);
    const fb=[];for(let m=0;m<nMels;m++){const lower=meltabs[m];const center=meltabs[m+1];const upper=meltabs[m+2];const filter=new Float32Array(binFreqs.length);const leftDen=(center-lower)||1e-9;const rightDen=(upper-center)||1e-9;for(let k=0;k<binFreqs.length;k++){const f=binFreqs[k];if(f>=lower&&f<=center){filter[k]=(f-lower)/leftDen;}else if(f>=center&&f<=upper){filter[k]=(upper-f)/rightDen;}else{filter[k]=0;}}fb.push(filter);}return fb;
  }
  function applyMelFilterbank(magSpectrum,melFilters){const nMels=melFilters.length;const out=new Float32Array(nMels);for(let m=0;m<nMels;m++){let sum=0;const filter=melFilters[m];for(let k=0;k<filter.length;k++){const f=filter[k];if(f){const v=magSpectrum[k];if(isFinite(v))sum+=v*f;}}out[m]=sum;}return out;}
  function toDb(array,ref=1.0){const out=new Float32Array(array.length);const amin=1e-10;for(let i=0;i<array.length;i++){const val=Math.max(array[i],amin);out[i]=20*Math.log10(val/ref);}return out;}
  function colorMap(v){if(!isFinite(v))v=0;if(v<0)v=0;if(v>1)v=1;const stops=[[68,1,84],[59,82,139],[33,144,140],[94,201,98],[253,231,37]];const t=v*(stops.length-1);const i=Math.floor(t);const frac=t-i;const a=stops[Math.max(0,Math.min(stops.length-1,i))];const b=stops[Math.max(0,Math.min(stops.length-1,i+1))];const r=Math.round(a[0]+(b[0]-a[0])*frac);const g=Math.round(a[1]+(b[1]-a[1])*frac);const bl=Math.round(a[2]+(b[2]-a[2])*frac);return[r,g,bl,255];}
  const fftCache=new Map();
  self.addEventListener('message',function(e){
    const data=e.data;
    if(!data||data.cmd!=='process')return;
    const samples=new Float32Array(data.audioBuffer);
    const sampleRate=data.sampleRate;
    const opts=data.options||{};
    const fftSize=opts.fftSize||2048;
    const hopSize=opts.hopSize||512;
    const nMels=Math.max(1,opts.nMels||64);
    const fmin=Math.max(0,opts.fmin||0);
    const fmax=opts.fmax||(sampleRate/2);
    const logScale=(opts.logScale!==undefined)?opts.logScale:true;
    const dynamicRange=opts.dynamicRange||80;
    const windowFunc=hannWindow(fftSize);
    const melFilters=createMelFilterbank(nMels,fftSize,sampleRate,fmin,fmax);
    let frames=Math.max(0,Math.floor((samples.length-fftSize)/hopSize)+1);
    if(frames<=0)frames=1;
    const width=Math.max(1,frames);
    const height=nMels;
    const imgW=Math.min(1200,Math.max(200,width));
    const imgH=Math.min(512,Math.max(100,height));
    const pixels=new Uint8ClampedArray(imgW*imgH*4);
    let fftInstance=null;
    if(typeof self.FFT==='function'){
      fftInstance=fftCache.get(fftSize);
      if(!fftInstance){fftInstance=new self.FFT(fftSize);fftCache.set(fftSize,fftInstance);}
    }
    const re=new Float32Array(fftSize);
    const im=new Float32Array(fftSize);
    const melSpec=new Float32Array(frames*nMels);
    const progressStep=Math.max(1,Math.floor(frames/20));
    for(let f=0;f<frames;f++){
      const offset=f*hopSize;
      for(let i=0;i<fftSize;i++){re[i]=(samples[offset+i]||0)*windowFunc[i];im[i]=0;}
      if(fftInstance){fftInstance.transform(re,im);}else{
        try{
          const outRe=new Float32Array(fftSize);
          const outIm=new Float32Array(fftSize);
          for(let k=0;k<fftSize;k++){let sumRe=0,sumIm=0;for(let n=0;n<fftSize;n++){const angle=-2*Math.PI*k*n/fftSize;const cos=Math.cos(angle),sin=Math.sin(angle);sumRe+=re[n]*cos-im[n]*sin;sumIm+=re[n]*sin+im[n]*cos;}outRe[k]=sumRe;outIm[k]=sumIm;}
          re.set(outRe);im.set(outIm);
        }catch(err){
          for(let m=0;m<nMels;m++)melSpec[f*nMels+m]=0;
          continue;
        }
      }
      const half=Math.floor(fftSize/2)+1;
      const mag=new Float32Array(half);
      for(let k=0;k<half;k++){const rr=re[k],ii=im[k];const mVal=Math.sqrt((isFinite(rr)?rr*rr:0)+(isFinite(ii)?ii*ii:0));mag[k]=isFinite(mVal)?mVal:0;}
      const melFrame=applyMelFilterbank(mag,melFilters);
      for(let m=0;m<nMels;m++)melSpec[f*nMels+m]=isFinite(melFrame[m])?melFrame[m]:0;
      if((f%progressStep)===0){self.postMessage({type:'progress',value:f/frames});}
    }
    self.postMessage({type:'progress',value:0.95});
    let melDb;
    if(logScale){
      let maxVal=0;
      for(let i=0;i<melSpec.length;i++)if(melSpec[i]>maxVal)maxVal=melSpec[i];
      const ref=maxVal>0?maxVal:1.0;
      melDb=toDb(melSpec,ref);
    }else{melDb=new Float32Array(melSpec);}
    let minVal=Infinity,maxVal=-Infinity;
    for(let i=0;i<melDb.length;i++){const v=melDb[i];if(!isFinite(v))continue;if(v<minVal)minVal=v;if(v>maxVal)maxVal=v;}
    if(!isFinite(minVal)||!isFinite(maxVal)){for(let i=0;i<melDb.length;i++)melDb[i]=0;minVal=0;maxVal=1;}
    if(logScale){
      const top=maxVal;const bottom=Math.max(maxVal-dynamicRange,minVal);const denom=(top-bottom)||1e-6;
      for(let i=0;i<melDb.length;i++){let nv=(melDb[i]-bottom)/denom;if(!isFinite(nv))nv=0;if(nv<0)nv=0;if(nv>1)nv=1;melDb[i]=nv;}
    }else{
      const denom=(maxVal-minVal)||1e-6;
      for(let i=0;i<melDb.length;i++){let nv=(melDb[i]-minVal)/denom;if(!isFinite(nv))nv=0;if(nv<0)nv=0;if(nv>1)nv=1;melDb[i]=nv;}
    }
    for(let x=0;x<imgW;x++){
      const frameIdx=Math.min(frames-1,Math.max(0,Math.floor(x*(frames/imgW))));
      const base=frameIdx*nMels;
      for(let y=0;y<imgH;y++){
        const melIdx=Math.floor((1-y/imgH)*(nMels-1));
        const idx=base+melIdx;
        const v=(idx>=0&&idx<melDb.length)?melDb[idx]:0;
        const c=colorMap(v);
        const p=(y*imgW+x)*4;
        pixels[p]=c[0];pixels[p+1]=c[1];pixels[p+2]=c[2];pixels[p+3]=255;
      }
      if((x%Math.max(1,Math.floor(imgW/30)))===0){self.postMessage({type:'progress',value:0.95+0.05*(x/imgW)});}
    }
    self.postMessage({type:'done',width:imgW,height:imgH,pixels:pixels.buffer},[pixels.buffer]);
  });
})();`;

// Setup handler from worker
function setupWorkerHandlers(worker) {
  if (!worker) return;
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'progress') {
      const p = Math.round((msg.value || 0) * 100);
      showProcessing(true, p);
    } else if (msg.type === 'done') {
      const pixels = new Uint8ClampedArray(msg.pixels);
      drawSpectrogramPixels(msg.width, msg.height, pixels);
      showProcessing(false, 100);
    } else if (msg.type === 'error') {
      console.warn('Worker error:', msg.message);
      showProcessing(false, 0);
    }
  };
}

// Try external worker, else fallback inline
async function ensureWorker() {
  if (spectrogramWorker) return spectrogramWorker;
  try {
    spectrogramWorker = new Worker('spectrogram.worker.js');
    setupWorkerHandlers(spectrogramWorker);
    console.log('spectrogram: external worker loaded (spectrogram.worker.js).');
    return spectrogramWorker;
  } catch (err) {
    console.warn('spectrogram: external worker load failed, using inline fallback.', err);
    const full = _vendorFFT + "\n" + _workerCode;
    const blob = new Blob([full], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    spectrogramWorker = new Worker(blobUrl);
    setupWorkerHandlers(spectrogramWorker);
    console.log('spectrogram: inline worker created (fallback).');
    return spectrogramWorker;
  }
}

// UI helpers (mantive)
function showProcessing(show, percent = 0) {
  if (show) {
    processingIndicator.style.display = 'flex';
    processingProgress.textContent = `Processando: ${percent}%`;
  } else {
    processingIndicator.style.display = 'none';
    processingProgress.textContent = 'Processando: 0%';
  }
}

// render spectrogram usando offscreen -> drawImage (mantive a lógica anterior)
function drawSpectrogramPixels(srcWidth, srcHeight, pixels) {
  const dpr = window.devicePixelRatio || 1;
  const container = spectrogramCanvas.parentElement || document.body;
  const containerStyleWidth = container.clientWidth || 940;
  const visualMaxWidth = Math.min(940, containerStyleWidth);
  const visualWidth = visualMaxWidth;
  const aspect = srcHeight / srcWidth;
  const visualHeight = Math.max(80, Math.round(visualWidth * aspect));
  const off = document.createElement('canvas');
  off.width = srcWidth;
  off.height = srcHeight;
  const offCtx = off.getContext('2d');
  offCtx.putImageData(new ImageData(pixels, srcWidth, srcHeight), 0, 0);
  spectrogramCanvas.width = Math.round(visualWidth * dpr);
  spectrogramCanvas.height = Math.round(visualHeight * dpr);
  spectrogramCanvas.style.width = visualWidth + 'px';
  spectrogramCanvas.style.height = visualHeight + 'px';
  const ctx = spectrogramCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, visualWidth, visualHeight);
  ctx.drawImage(off, 0, 0, srcWidth, srcHeight, 0, 0, visualWidth, visualHeight);
  spectrogramCanvas.style.display = 'block';
}

// waveform live (mantive similar)
function drawLiveWaveform() {
  if (!analyser) return;
  const bufferLength = analyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);
  const dpr = window.devicePixelRatio || 1;
  const container = waveform.parentElement || document.body;
  const w = Math.min(940, container.clientWidth || 940);
  const h = parseInt(getComputedStyle(waveform).height, 10) || 180;
  waveform.width = Math.round(w * dpr);
  waveform.height = Math.round(h * dpr);
  waveform.style.width = w + 'px';
  waveform.style.height = h + 'px';
  const ctx = waveform.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  function draw() {
    analyser.getByteTimeDomainData(dataArray);
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    for (let i = 0; i < w; i++) {
      const idx = Math.floor(i * bufferLength / w);
      const v = dataArray[idx] / 128.0;
      const y = (v * 0.5) * h;
      const drawY = h / 2 + (y - h / 4);
      if (i === 0) ctx.moveTo(i, drawY);
      else ctx.lineTo(i, drawY);
    }
    ctx.strokeStyle = "#1976d2";
    ctx.lineWidth = 2;
    ctx.stroke();
    animationId = requestAnimationFrame(draw);
  }
  draw();
}

// AGC, WAV encoder e processAndPlayBlob (mantive a lógica anterior e integro com persistência)
function applyAGC(signal, targetRMS = 0.08, maxGain = 8, limiterThreshold = 0.99) {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    sum += v * v;
  }
  const rms = Math.sqrt(sum / Math.max(1, signal.length));
  const eps = 1e-8;
  let gain = targetRMS / (rms + eps);
  if (!isFinite(gain) || gain <= 0) gain = 1;
  if (gain > maxGain) gain = maxGain;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    let v = signal[i] * gain;
    const thr = limiterThreshold;
    if (v > thr) {
      v = thr + (1 - Math.exp(-(v - thr)));
    } else if (v < -thr) {
      v = -thr - (1 - Math.exp(-(-v - thr)));
    }
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    out[i] = v;
  }
  return { processed: out, gain };
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}
function floatTo16BitPCM(float32Array) {
  const l = float32Array.length;
  const buffer = new ArrayBuffer(l * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < l; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s, true);
  }
  return new Uint8Array(buffer);
}
function encodeWAV(samples, sampleRate) {
  const pcmBytes = floatTo16BitPCM(samples);
  const buffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, pcmBytes.length, true);
  const wavBytes = new Uint8Array(buffer, 44);
  wavBytes.set(pcmBytes);
  return new Blob([view, pcmBytes.buffer], { type: 'audio/wav' });
}

async function processAndPlayBlob(blob) {
  await ensureWorker();
  showProcessing(true, 0);
  try {
    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await aCtx.decodeAudioData(arrayBuffer);
    const sampleRate = audioBuffer.sampleRate;
    const raw = audioBuffer.getChannelData(0);

    const agcOpts = window.processingOptions.agc || {};
    const { processed, gain } = applyAGC(raw, agcOpts.targetRMS, agcOpts.maxGain, agcOpts.limiterThreshold);

    const wavBlob = encodeWAV(processed, sampleRate);
    const url = URL.createObjectURL(wavBlob);
    audioPlayer.src = url;
    audioPlayer.load();

    spectrogramWorker.postMessage({
      cmd: 'process',
      audioBuffer: processed.buffer,
      sampleRate: sampleRate,
      options: window.processingOptions.spectrogram
    }, [processed.buffer]);

    return { url, gain };
  } catch (err) {
    console.error('Erro no processamento do blob:', err);
    showProcessing(false, 0);
    return null;
  }
}

// interface com histórico — quando selecionar gravação fora de sessões (mantive compatibilidade)
window.onSelectRecording = function(idx) {
  if (idx < 0 || idx >= recordings.length) return;
  currentIdx = idx;
  const rec = recordings[idx];
  audioPlayer.src = rec.url;
  audioPlayer.style.display = 'block';
  audioPlayer.load();
  statusText.textContent = `Selecionado: ${new Date(rec.date).toLocaleString()}`;
  processAndPlayBlob(rec.blob);
  if (typeof window.renderHistory === 'function') window.renderHistory(recordings, currentIdx);
};

// navegação
prevBtn.addEventListener('click', () => {
  if (recordings.length === 0) return;
  const next = currentIdx <= 0 ? 0 : currentIdx - 1;
  window.onSelectRecording(next);
});
nextBtn.addEventListener('click', () => {
  if (recordings.length === 0) return;
  const next = currentIdx >= recordings.length - 1 ? recordings.length - 1 : (currentIdx === -1 ? recordings.length - 1 : currentIdx + 1);
  window.onSelectRecording(next);
});

// gravação
recordBtn.addEventListener('click', async () => {
  audioChunks = [];
  statusText.textContent = "Gravando...";
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  recordBtn.classList.add('active');

  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusText.textContent = "Permissão de microfone negada.";
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.classList.remove('active');
    console.error(err);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(liveStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  sourceNode.connect(analyser);

  waveform.style.display = 'block';
  spectrogramCanvas.style.display = 'block';
  drawLiveWaveform();

  mediaRecorder = new MediaRecorder(liveStream);
  mediaRecorder.ondataavailable = e => {
    audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const recObj = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      name: `Gravação ${recordings.length + 1}`,
      date: new Date().toISOString(),
      blob
    };
    // adiciona à lista em memória (sessão corrente não salva até o usuário salvar)
    recordings.push({ id: recObj.id, name: recObj.name, date: recObj.date, blob: recObj.blob, url });
    currentIdx = recordings.length - 1;
    renderRecordingsList(recordings);

    // processa e mostra espectrograma
    await processAndPlayBlob(blob);

    statusText.textContent = "Gravação salva (tempo local).";
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.classList.remove('active');

    if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx = null; }
    if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
    cancelAnimationFrame(animationId);
  };

  mediaRecorder.start();
});

// parar
stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    statusText.textContent = "Parando...";
  }
});

// player ao tocar
audioPlayer.addEventListener('play', () => {
  if (audioPlayer.src) {
    // nada extra necessário
  }
});

// inicialização UI: carrega sessões existentes
(async function init() {
  try {
    await loadSessions();
  } catch (err) {
    console.warn('Erro ao carregar sessões:', err);
  }
})();