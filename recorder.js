// recorder.js — versão ajustada para integração com db.js e audio.js separados.
// Correções:
// - adicionada selectRecordingInUI (evita ReferenceError ao clicar em item).
// - adicionada playRecording para o botão ▶ em cada gravação.
// - adicionada drawSpectrogramPixels e showProcessing para desenhar espectrograma.
// - registrei worker.onmessage (via window.ensureWorker) no init para receber mensagens do worker do audio.js.
// - usa window.* para chamadas externas (DB / processamento).

let mediaRecorder;
let audioChunks = [];
let recordings = []; // workspace: { id, name, date, blob, url }
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
const importRecordingInput = document.getElementById('import-recording-input');

let audioCtx, analyser, sourceNode, animationId, liveStream;

// --- processingOptions (mantive igual) ---
window.processingOptions = window.processingOptions || {
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
// Helpers local (base64/blobs)
// ------------------------------
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
function base64ToBlob(base64, type='application/octet-stream') {
  return fetch('data:' + type + ';base64,' + base64).then(r => r.blob());
}

// ------------------------------
// UI: Sessões + Gravações (painel esquerdo)
// ------------------------------
let sessionsCache = []; // carregado do DB (via window.getAllSessionsFromDb)
let selectedSessionId = null;
let currentSessionRecordings = []; // gravações da sessão selecionada carregadas (pode conter blobs)

// ------------------------------
// Função playRecording (corrige ReferenceError)
// - Toca a gravação imediatamente (usa blob/url existente), tenta play() e desenha waveform estática.
// ------------------------------
function playRecording(rec) {
  try {
    if (!rec) return;
    // garantir objectURL
    if (!rec.url && rec.blob) {
      rec.url = URL.createObjectURL(rec.blob);
    }
    if (rec.url) {
      audioPlayer.src = rec.url;
      // tentar tocar — pode ser bloqueado em alguns cenários mas este click é user gesture
      audioPlayer.play().catch(err => {
        console.warn('playRecording: reprodução bloqueada ou falhou', err);
      });
      statusText.textContent = `Reproduzindo: ${rec.name || ''}`;
      // desenhar waveform estática (feedback visual)
      if (rec.blob) showWaveform(rec.blob).catch(()=>{});
    }
  } catch (err) {
    console.error('Erro em playRecording:', err);
  }
}

// Render sessions list
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

    const expBtn = document.createElement('button');
    expBtn.className = 'small';
    expBtn.textContent = 'Exportar';
    expBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (typeof window.exportSessionById === 'function') {
        await window.exportSessionById(s.id);
      } else {
        await exportSessionById(s.id);
      }
    };
    right.appendChild(expBtn);

    const del = document.createElement('button');
    del.className = 'small';
    del.textContent = 'Apagar';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('Apagar sessão "' + (s.name || '') + '"?')) return;
      if (typeof window.deleteSessionFromDb === 'function') {
        await window.deleteSessionFromDb(s.id);
      } else {
        await deleteSessionFromDb(s.id);
      }
      await loadSessions().catch(err => console.warn('loadSessions erro após apagar:', err));
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

// Render recordings list in workspace
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
      // chama a função definida acima
      playRecording(rec);
    };
    item.appendChild(play);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'small';
    exportBtn.textContent = 'Exportar';
    exportBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (rec && rec.id && typeof window.getRecordingById === 'function') {
        window.getRecordingById(rec.id).then(r => {
          if (r && r.blob) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(r.blob);
            a.download = `${(r.name || 'recording').replace(/\s+/g,'_')}-${r.date||Date.now()}.webm`;
            a.click();
          } else if (rec.blob) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(rec.blob);
            a.download = `${(rec.name || 'recording').replace(/\s+/g,'_')}-${rec.date||Date.now()}.webm`;
            a.click();
          } else {
            alert('Gravação não encontrada para exportar.');
          }
        }).catch(err => {
          console.error('exportRecording: erro ao obter rec do pool', err);
        });
      } else if (rec && rec.blob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(rec.blob);
        a.download = `${(rec.name || 'recording').replace(/\s+/g,'_')}-${rec.date||Date.now()}.webm`;
        a.click();
      } else {
        alert('Gravação não disponível para exportação.');
      }
    };
    item.appendChild(exportBtn);

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
      if (selectedSessionId && typeof window.getSessionById === 'function') {
        (async () => {
          try {
            const sess = await window.getSessionById(selectedSessionId);
            if (!sess) return;
            sess.recordings = (sess.recordings || []).filter(r => {
              if (typeof r === 'number' || typeof r === 'string') return r !== rec.id;
              if (r && r.id) return r.id !== rec.id;
              return true;
            });
            if (typeof window.updateSessionInDb === 'function') {
              await window.updateSessionInDb(sess);
            }
            recordings = recordings.filter(r => r.id !== rec.id);
            currentIdx = Math.min(Math.max(0, currentIdx - 1), recordings.length - 1);
            renderRecordingsList(recordings);
          } catch (err) {
            console.error('Erro ao remover gravação da sessão:', err);
          }
        })();
      } else {
        recordings = recordings.filter(r => r.id !== rec.id);
        currentIdx = Math.min(Math.max(0, currentIdx - 1), recordings.length - 1);
        renderRecordingsList(recordings);
      }
    };
    item.appendChild(del);

    item.onclick = () => selectRecordingInUI(idx, rec);
    container.appendChild(item);
  });
  if (arr.length === 0) {
    container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma gravação nesta sessão / workspace</div>';
  }
}

// selecionar sessão (carrega gravações) - usa window.getSessionById e window.getRecordingById quando disponíveis
async function selectSession(id) {
  selectedSessionId = id;
  let sess = null;
  try {
    if (typeof window.getSessionById === 'function') {
      sess = await window.getSessionById(id);
    } else {
      sess = await getSessionById(id); // fallback if exists locally
    }
  } catch (err) {
    console.warn('selectSession: erro ao obter sessão:', err);
    sess = null;
  }

  const recObjs = [];
  const refs = (sess && sess.recordings) ? sess.recordings : [];
  for (const r of refs) {
    if (!r) continue;
    // r might be id (number or string) or object with blob
    if (typeof r === 'number' || typeof r === 'string') {
      if (typeof window.getRecordingById === 'function') {
        try {
          const rec = await window.getRecordingById(r);
          if (rec) recObjs.push({ id: r, name: rec.name, date: rec.date, blob: rec.blob, url: URL.createObjectURL(rec.blob) });
        } catch (err) {
          console.warn('selectSession: getRecordingById falhou para id', r, err);
        }
      }
    } else if (r && r.blob) {
      // embedded old-schema object
      const idGuess = r.id || (Date.now() + Math.floor(Math.random() * 1000));
      recObjs.push({ id: idGuess, name: r.name, date: r.date, blob: r.blob, url: URL.createObjectURL(r.blob) });
    } else if (r && r.id) {
      // object with id
      if (typeof window.getRecordingById === 'function') {
        try {
          const rec = await window.getRecordingById(r.id);
          if (rec) recObjs.push({ id: r.id, name: rec.name, date: rec.date, blob: rec.blob, url: URL.createObjectURL(rec.blob) });
        } catch (err) {
          console.warn('selectSession: getRecordingById falhou para objeto id', r.id, err);
        }
      }
    }
  }

  currentSessionRecordings = recObjs.slice();
  recordings = currentSessionRecordings.map(r => ({ id: r.id, name: r.name, date: r.date, blob: r.blob, url: r.url }));
  currentIdx = recordings.length > 0 ? 0 : -1;
  if (currentIdx >= 0) {
    audioPlayer.src = recordings[0].url;
    audioPlayer.load();
  }
  await loadSessions().catch(err => console.warn('loadSessions erro em selectSession:', err));
  renderRecordingsList(recordings);
}

// ------------------------------
// Waveform static rendering
// ------------------------------
async function showWaveform(source) {
  try {
    if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    let arrayBuffer;
    if (source instanceof Blob) {
      arrayBuffer = await source.arrayBuffer();
    } else if (typeof source === 'string') {
      const resp = await fetch(source);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      console.warn('showWaveform: fonte não suportada', source);
      return;
    }
    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await aCtx.decodeAudioData(arrayBuffer.slice(0));
    const samples = audioBuffer.getChannelData(0);
    drawWaveformFromSamples(samples);
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

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1976d2';
  ctx.beginPath();

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

// ------------------------------
// Live waveform drawing
// ------------------------------
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

// ------------------------------
// AGC + WAV encode helpers (mantidos localmente)
// ------------------------------
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
  return new Blob([buffer], { type: 'audio/wav' });
}

// processAndPlayBlob wrapper: delega para audio.js via window when available
async function processAndPlayBlobDelegator(blob) {
  if (typeof window.processAndPlayBlob === 'function') {
    try {
      return await window.processAndPlayBlob(blob);
    } catch (err) {
      console.warn('processAndPlayBlob (window) falhou:', err);
      return null;
    }
  } else {
    try {
      const aCtx = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await aCtx.decodeAudioData(arrayBuffer);
      const sampleRate = audioBuffer.sampleRate;
      const raw = audioBuffer.getChannelData(0);
      const { processed } = applyAGC(raw, window.processingOptions.agc.targetRMS, window.processingOptions.agc.maxGain, window.processingOptions.agc.limiterThreshold);
      const wavBlob = encodeWAV(processed, sampleRate);
      const url = URL.createObjectURL(wavBlob);
      audioPlayer.src = url;
      audioPlayer.load();
      aCtx.close().catch(()=>{});
      return { url, gain: 1 };
    } catch (err) {
      console.error('processAndPlayBlob fallback falhou:', err);
      return null;
    }
  }
}

// ------------------------------
// Spectrogram drawing + processing indicator
// ------------------------------
function showProcessing(show, percent = 0) {
  if (!processingIndicator || !processingProgress) return;
  if (show) {
    processingIndicator.style.display = 'flex';
    processingProgress.textContent = `Processando: ${percent}%`;
  } else {
    processingIndicator.style.display = 'none';
    processingProgress.textContent = 'Processando: 0%';
  }
}

function drawSpectrogramPixels(srcWidth, srcHeight, pixels) {
  if (!spectrogramCanvas) return;
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

// ------------------------------
// selectRecordingInUI (corrige ReferenceError anterior)
// ------------------------------
function selectRecordingInUI(idx, rec) {
  currentIdx = idx;
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  if (rec && rec.url) {
    audioPlayer.src = rec.url;
    audioPlayer.load();
  } else if (rec && rec.blob) {
    rec.url = URL.createObjectURL(rec.blob);
    audioPlayer.src = rec.url;
    audioPlayer.load();
  }
  renderRecordingsList(recordings);
  if (rec && rec.blob) {
    showWaveform(rec.blob).catch(()=>{});
    processAndPlayBlobDelegator(rec.blob).catch(()=>{});
  } else if (rec && rec.url) {
    showWaveform(rec.url).catch(()=>{});
    fetch(rec.url).then(r => r.blob()).then(b => processAndPlayBlobDelegator(b)).catch(()=>{});
  }
}

// ------------------------------
// Save session, export/import handlers (mantidos)
// ------------------------------
saveSessionBtn.addEventListener('click', async () => {
  if (!recordings || recordings.length === 0) {
    alert('Nenhuma gravação para salvar nesta sessão.');
    return;
  }
  const name = prompt('Nome da sessão:', `Sessão ${new Date().toLocaleString()}`);
  if (!name) return;
  const recRefs = recordings.map((r, idx) => {
    if (r && r.id) return r.id;
    return { id: Date.now() + idx, name: r.name || `Gravação ${idx+1}`, date: r.date || new Date().toISOString(), blob: r.blob };
  });
  const session = { name, date: Date.now(), recordings: recRefs };
  try {
    if (typeof window.saveSessionToDb === 'function') {
      await window.saveSessionToDb(session);
    } else {
      await saveSessionToDb(session);
    }
    await loadSessions().catch(err => console.warn('loadSessions erro após salvar sessão:', err));
    alert('Sessão salva.');
  } catch (err) {
    console.error('Erro ao salvar sessão:', err);
    alert('Erro ao salvar sessão: ' + (err && err.message ? err.message : err));
  }
});

async function exportSessionById(sessionId) {
  let sess = null;
  try {
    if (typeof window.getSessionById === 'function') sess = await window.getSessionById(sessionId);
    else sess = await getSessionById(sessionId);
  } catch (err) {
    console.warn('exportSessionById: erro ao obter sessão:', err);
    sess = null;
  }
  if (!sess) { alert('Sessão não encontrada.'); return; }
  const recs = [];
  for (const r of (sess.recordings || [])) {
    if (!r) continue;
    if (typeof r === 'number' || typeof r === 'string') {
      if (typeof window.getRecordingById === 'function') {
        try {
          const rr = await window.getRecordingById(r);
          if (rr && rr.blob) {
            const base64 = await blobToBase64(rr.blob);
            recs.push({ id: r, name: rr.name, date: rr.date, blobBase64: base64 });
          }
        } catch (err) {
          console.warn('exportSessionById: falha ao ler recording id', r, err);
        }
      }
    } else if (r.blob) {
      const base64 = await blobToBase64(r.blob);
      recs.push({ id: r.id, name: r.name, date: r.date, blobBase64: base64 });
    }
  }
  const out = { name: sess.name, date: sess.date, recordings: recs };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(sess.name||'session').replace(/\s+/g,'_')}-${sess.date}.json`;
  a.click();
}

exportSessionBtn.addEventListener('click', async () => {
  if (!selectedSessionId) { alert('Selecione uma sessão para exportar.'); return; }
  if (typeof window.exportSessionById === 'function') {
    await window.exportSessionById(selectedSessionId);
  } else {
    await exportSessionById(selectedSessionId);
  }
});

// import handlers (kept)
importSessionInput.addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const obj = JSON.parse(text);
    if (!obj || !obj.recordings) throw new Error('Formato inválido');
    const recIds = [];
    for (const r of obj.recordings) {
      const blob = await base64ToBlob(r.blobBase64);
      if (typeof window.saveRecordingToDbObj === 'function') {
        try {
          const rid = await window.saveRecordingToDbObj({ name: r.name || '', date: r.date || Date.now(), blob });
          recIds.push(rid);
        } catch (err) {
          console.warn('importSession: falha ao salvar gravação no pool, adicionando inline.', err);
          recIds.push({ id: Date.now()+Math.random(), name: r.name, date: r.date, blob });
        }
      } else {
        recIds.push({ id: Date.now()+Math.random(), name: r.name, date: r.date, blob });
      }
    }
    const session = { name: obj.name || `Import ${new Date().toLocaleString()}`, date: Date.now(), recordings: recIds };
    if (typeof window.saveSessionToDb === 'function') {
      await window.saveSessionToDb(session);
    } else {
      await saveSessionToDb(session);
    }
    await loadSessions().catch(err => console.warn('loadSessions erro após import:', err));
    alert('Sessão importada com sucesso.');
  } catch (err) {
    console.error(err);
    alert('Erro ao importar: ' + err.message);
  } finally {
    importSessionInput.value = '';
  }
});

importRecordingInput.addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  try {
    const blob = f;
    const name = f.name || `import-${Date.now()}`;
    const date = new Date().toISOString();
    let rid = null;
    if (typeof window.saveRecordingToDbObj === 'function') {
      try {
        rid = await window.saveRecordingToDbObj({ name, date, blob });
      } catch (err) {
        console.warn('importRecording: saveRecordingToDbObj falhou:', err);
      }
    }
    const rec = { id: rid, name, date, blob, url: URL.createObjectURL(blob) };
    recordings.push(rec);
    currentIdx = recordings.length - 1;
    renderRecordingsList(recordings);
    try { await showWaveform(blob); } catch(e){/*ignore*/ }
    try { await processAndPlayBlobDelegator(blob); } catch(e){/*ignore*/ }
    alert('Gravação importada e adicionada ao workspace.');
  } catch (err) {
    console.error('Erro ao importar gravação:', err);
    alert('Erro ao importar gravação: ' + err.message);
  } finally {
    importRecordingInput.value = '';
  }
});

// ------------------------------
// Recording flow (start / stop) with debugging logs
// ------------------------------
recordBtn.addEventListener('click', async () => {
  audioChunks = [];

  statusText.textContent = "Aguardando permissão...";
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  recordBtn.classList.add('pending');
  recordBtn.classList.remove('active');

  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusText.textContent = "Permissão de microfone negada.";
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.classList.remove('pending');
    console.error(err);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try { await audioCtx.resume(); } catch (e) { /* ignore */ }

  sourceNode = audioCtx.createMediaStreamSource(liveStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.3;
  sourceNode.connect(analyser);

  waveform.style.display = 'block';
  spectrogramCanvas.style.display = 'block';
  drawLiveWaveform();

  mediaRecorder = new MediaRecorder(liveStream);
  mediaRecorder.ondataavailable = e => {
    console.debug('ondataavailable: size=', e.data && e.data.size);
    audioChunks.push(e.data);
  };

  mediaRecorder.onstart = () => {
    console.debug('mediaRecorder.onstart');
    recordBtn.classList.remove('pending');
    recordBtn.classList.add('active');
    statusText.textContent = "Gravando...";
    recordBtn.disabled = false;
  };

  mediaRecorder.onstop = async () => {
    console.debug('mediaRecorder.onstop chamado');
    try {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const recObj = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        name: `Gravação ${recordings.length + 1}`,
        date: new Date().toISOString(),
        blob
      };
      recordings.push({ id: recObj.id, name: recObj.name, date: recObj.date, blob: recObj.blob, url });
      currentIdx = recordings.length - 1;
      renderRecordingsList(recordings);

      try { await showWaveform(blob); } catch(e) { console.debug('showWaveform falhou:', e); }
      try { await processAndPlayBlobDelegator(blob); } catch(e) { console.debug('processAndPlayBlobDelegator falhou:', e); }

      statusText.textContent = "Gravação salva (tempo local).";
    } catch (err) {
      console.error('Erro em onstop processing:', err);
      statusText.textContent = "Erro ao finalizar gravação.";
    } finally {
      recordBtn.disabled = false;
      stopBtn.disabled = true;
      recordBtn.classList.remove('active');
      if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx = null; }
      if (liveStream) { try { liveStream.getTracks().forEach(t => t.stop()); } catch(e){} liveStream = null; }
      if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
    }
  };

  mediaRecorder.onerror = (ev) => {
    console.error('mediaRecorder.onerror', ev);
    statusText.textContent = 'Erro na gravação';
  };

  try {
    mediaRecorder.start();
    console.debug('mediaRecorder.start -> state=', mediaRecorder.state);
  } catch (err) {
    console.error('Erro ao iniciar MediaRecorder:', err);
    recordBtn.classList.remove('pending');
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    statusText.textContent = "Erro ao iniciar gravação.";
  }
});

// stop handler with debug
stopBtn.addEventListener('click', () => {
  console.debug('stopBtn clicked; mediaRecorder present?', !!mediaRecorder, 'state=', mediaRecorder ? mediaRecorder.state : 'n/a');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      if (typeof mediaRecorder.requestData === 'function') {
        try { mediaRecorder.requestData(); } catch (e) { console.debug('requestData falhou:', e); }
      }
      mediaRecorder.stop();
      statusText.textContent = "Parando...";
    } catch (err) {
      console.error('Erro ao chamar stop():', err);
      try {
        const blob = new Blob(audioChunks, { type: 'audio/webm' });
        (async () => {
          try {
            recordings.push({ id: Date.now()+Math.random(), name: `Gravação ${recordings.length+1}`, date: new Date().toISOString(), blob, url: URL.createObjectURL(blob) });
            currentIdx = recordings.length - 1;
            renderRecordingsList(recordings);
            await showWaveform(blob);
            await processAndPlayBlobDelegator(blob);
            statusText.textContent = "Gravação salva (tempo local).";
          } catch (e) {
            console.error('Fallback finalize falhou:', e);
            statusText.textContent = "Erro ao finalizar gravação.";
          } finally {
            recordBtn.disabled = false;
            stopBtn.disabled = true;
            recordBtn.classList.remove('active');
            if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx = null; }
            if (liveStream) { try { liveStream.getTracks().forEach(t => t.stop()); } catch(e){} liveStream = null; }
            if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
          }
        })();
      } catch (e) {
        console.error('Erro no fallback stop:', e);
      }
    }
  }
});

// ------------------------------
// Interface com histórico (quando selecionar gravação fora de sessões)
// ------------------------------
window.onSelectRecording = function(idx) {
  if (idx < 0 || idx >= recordings.length) return;
  currentIdx = idx;
  const rec = recordings[idx];
  if (rec && rec.url) {
    audioPlayer.src = rec.url;
    audioPlayer.style.display = 'block';
    audioPlayer.load();
  } else if (rec && rec.blob) {
    rec.url = URL.createObjectURL(rec.blob);
    audioPlayer.src = rec.url;
    audioPlayer.load();
  }
  statusText.textContent = `Selecionado: ${new Date(rec.date).toLocaleString()}`;
  if (rec && rec.blob) {
    showWaveform(rec.blob).catch(()=>{});
    processAndPlayBlobDelegator(rec.blob).catch(()=>{});
  } else if (rec && rec.url) {
    showWaveform(rec.url).catch(()=>{});
    try {
      fetch(rec.url).then(r => r.blob()).then(b => processAndPlayBlobDelegator(b)).catch(()=>{});
    } catch (e) { /* ignore */ }
  }
  if (typeof window.renderHistory === 'function') window.renderHistory(recordings, currentIdx);
};

// navigation
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

// ------------------------------
// loadSessions (uses window.getAllSessionsFromDb if available)
// ------------------------------
async function loadSessions() {
  try {
    if (typeof window.getAllSessionsFromDb === 'function') {
      sessionsCache = await window.getAllSessionsFromDb();
    } else {
      if (typeof getAllSessionsFromDb === 'function') sessionsCache = await getAllSessionsFromDb();
      else sessionsCache = [];
    }
    renderSessionsList();
  } catch (err) {
    console.warn('loadSessions: erro ao carregar sessões:', err);
    sessionsCache = [];
    renderSessionsList();
  }
}

// ------------------------------
// Init: register worker.onmessage handler (if available) and load sessions (non-blocking)
// ------------------------------
(function init() {
  try {
    // open DB non-blocking
    if (typeof window.openDb === 'function') {
      window.openDb().catch(err => console.warn('openDb falhou no init (não bloqueante):', err));
    }
    // register worker.onmessage if audio.js exposes ensureWorker
    if (typeof window.ensureWorker === 'function') {
      window.ensureWorker().then(worker => {
        if (!worker) return;
        worker.onmessage = (ev) => {
          const msg = ev.data;
          if (!msg) return;
          if (msg.type === 'progress') {
            const p = Math.round((msg.value || 0) * 100);
            showProcessing(true, p);
          } else if (msg.type === 'done') {
            try {
              const pixels = new Uint8ClampedArray(msg.pixels);
              drawSpectrogramPixels(msg.width, msg.height, pixels);
              showProcessing(false, 100);
            } catch (err) {
              console.warn('Erro ao processar mensagem do worker:', err);
            }
          } else if (msg.type === 'error') {
            console.warn('Worker error:', msg.message);
            showProcessing(false, 0);
          }
        };
      }).catch(err => {
        console.warn('ensureWorker falhou no init:', err);
      });
    }
    // call loadSessions but don't await (prevents blocking)
    loadSessions().catch(err => console.warn('loadSessions no init falhou (não bloqueante):', err));
  } catch (err) {
    console.warn('Erro ao inicializar recorder (não fatal):', err);
  }
})();