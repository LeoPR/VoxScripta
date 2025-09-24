// recorder.js — versão integrada com config.js (usa window.appConfig)
// Mantive a lógica existente (persistRecording, waveform, sessões) e adicionei logs de telemetria
// para o espectrograma (quando o worker retornar msg.timings).

let mediaRecorder;
let audioChunks = [];
let recordings = []; // workspace: { id, name, date, blob, url, persisted }
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

// util para obter config mesclada
function _getCfg() {
  if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
    return window.appConfig.getMergedProcessingOptions();
  }
  return window.processingOptions || {};
}

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
// API para sessions.js (exposição controlada)
// ------------------------------
window.getWorkspaceRecordings = function() {
  return recordings;
};
window.setWorkspaceRecordings = function(arr) {
  recordings = Array.isArray(arr) ? arr : [];
  try { renderRecordingsList(recordings); } catch(e){ /* ignore */ }
};
window.appendWorkspaceRecording = function(rec) {
  recordings.push(rec);
  try { renderRecordingsList(recordings); } catch(e){ /* ignore */ }
};

// ------------------------------
// Função playRecording
// ------------------------------
function playRecording(rec) {
  try {
    if (!rec) return;
    if (!rec.url && rec.blob) {
      rec.url = URL.createObjectURL(rec.blob);
    }
    if (rec.url) {
      audioPlayer.src = rec.url;
      audioPlayer.play().catch(err => {
        console.warn('playRecording: reprodução bloqueada ou falhou', err);
      });
      statusText.textContent = `Reproduzindo: ${rec.name || ''}`;
      if (rec.blob) showWaveform(rec.blob).catch(()=>{});
    }
  } catch (err) {
    console.error('Erro em playRecording:', err);
  }
}

// ------------------------------
// persistRecording - não bloqueante
// ------------------------------
async function persistRecording(blob, suggestedName) {
  const tempId = 'TEMP__' + Date.now() + '__' + Math.floor(Math.random() * 10000);
  const recDate = new Date().toISOString();
  const rec = {
    id: tempId,
    name: suggestedName || `Gravação ${recordings.length + 1}`,
    date: recDate,
    blob,
    url: URL.createObjectURL(blob),
    persisted: false
  };

  recordings.push(rec);
  currentIdx = recordings.length - 1;
  renderRecordingsList(recordings);

  if (typeof window.saveRecordingToDbObj === 'function') {
    try {
      console.debug('persistRecording: tentando salvar no DB...', rec.name);
      const savedId = await window.saveRecordingToDbObj({ name: rec.name, date: rec.date, blob: rec.blob });
      if (savedId !== undefined && savedId !== null) {
        for (let i = 0; i < recordings.length; i++) {
          if (recordings[i] && recordings[i].id === tempId) {
            recordings[i].id = savedId;
            recordings[i].persisted = true;
            console.debug('persistRecording: gravação persistida com id=', savedId);
            break;
          }
        }
        renderRecordingsList(recordings);
      } else {
        console.warn('persistRecording: saveRecordingToDbObj não retornou id');
      }
    } catch (err) {
      console.warn('persistRecording: falha ao salvar no DB (mantendo em memória):', err);
    }
  } else {
    console.debug('persistRecording: no DB API; gravação fica apenas em memória');
  }

  return rec;
}

// ------------------------------
// Render sessions list (delegado para sessions.js - função aqui apenas para compatibilidade)
// ------------------------------
function renderSessionsList() {
  // sessions.js faz o render real; mantemos stub para compatibilidade
  if (typeof window.renderSessionsList === 'function') {
    window.renderSessionsList();
  }
}

// ------------------------------
// Render recordings list in workspace
// ------------------------------
function renderRecordingsList(list) {
  const container = document.getElementById('recordings-list');
  container.innerHTML = '';
  const arr = list || [];
  arr.forEach((rec, idx) => {
    const item = document.createElement('div');
    item.className = 'recording-item' + (idx === currentIdx ? ' selected' : '');
    const nameWrap = document.createElement('div');
    nameWrap.style.display = 'flex';
    nameWrap.style.alignItems = 'center';
    nameWrap.style.gap = '8px';
    nameWrap.style.flex = '1';

    const name = document.createElement('div');
    name.className = 'recording-name';
    name.textContent = rec.name || `Gravação ${idx+1}`;
    nameWrap.appendChild(name);

    if (rec.persisted) {
      const badge = document.createElement('span');
      badge.style.fontSize = '12px';
      badge.style.color = 'green';
      badge.title = 'Gravação persistida no banco';
      badge.textContent = '✓';
      nameWrap.appendChild(badge);
    } else if (typeof rec.id === 'string' && rec.id && rec.id.startsWith('TEMP__')) {
      const tempBadge = document.createElement('span');
      tempBadge.style.fontSize = '12px';
      tempBadge.style.color = '#999';
      tempBadge.title = 'Ainda não persistido';
      tempBadge.textContent = '•';
      nameWrap.appendChild(tempBadge);
    }

    item.appendChild(nameWrap);

    const meta = document.createElement('div');
    meta.className = 'recording-meta';
    meta.textContent = new Date(rec.date).toLocaleString();
    item.appendChild(meta);

    const play = document.createElement('button');
    play.className = 'play-btn';
    play.textContent = '▶';
    play.onclick = (ev) => {
      ev.stopPropagation();
      playRecording(rec);
    };
    item.appendChild(play);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'small';
    exportBtn.textContent = 'Exportar';
    exportBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (rec && typeof rec.id === 'number' && typeof window.getRecordingById === 'function') {
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
          if (rec.blob) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(rec.blob);
            a.download = `${(rec.name || 'recording').replace(/\s+/g,'_')}-${rec.date||Date.now()}.webm`;
            a.click();
          }
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
          if (typeof saveChangesToSessionRecording === 'function') saveChangesToSessionRecording(rec);
        }
      };
      input.onblur = () => {
        rec.name = input.value;
        if (typeof saveChangesToSessionRecording === 'function') saveChangesToSessionRecording(rec);
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

// ------------------------------
// selecionar sessão (carrega gravações)
// ------------------------------
async function selectSession(id) {
  // delegado para sessions.js; exposto sempre via window.selectSession
  if (typeof window.selectSession === 'function') {
    return window.selectSession(id);
  }
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

// processAndPlayBlob wrapper: delega para audio.js via window quando disponível
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
  const cfg = _getCfg();
  const showIndicator = (cfg.ui && cfg.ui.showProcessingIndicator !== undefined) ? cfg.ui.showProcessingIndicator : true;
  if (!showIndicator) return;
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
  const cfg = _getCfg();
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

  // usar config para image smoothing (você preferiu false)
  const smoothing = (cfg.ui && cfg.ui.imageSmoothingEnabled !== undefined) ? cfg.ui.imageSmoothingEnabled : ((cfg.waveform && cfg.waveform.imageSmoothing) || false);
  ctx.imageSmoothingEnabled = !!smoothing;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, visualWidth, visualHeight);
  ctx.drawImage(off, 0, 0, srcWidth, srcHeight, 0, 0, visualWidth, visualHeight);
  spectrogramCanvas.style.display = 'block';
}

// ------------------------------
// selectRecordingInUI
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
  audioChunks = [];
  mediaRecorder.ondataavailable = e => { audioChunks.push(e.data); };

  mediaRecorder.onstart = () => {
    recordBtn.classList.remove('pending');
    recordBtn.classList.add('active');
    statusText.textContent = "Gravando...";
    recordBtn.disabled = false;
  };

  mediaRecorder.onstop = async () => {
    try {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const suggestedName = `Gravação ${recordings.length + 1}`;
      persistRecording(blob, suggestedName).catch(err => console.warn('persistRecording erro:', err));
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
  } catch (err) {
    console.error('Erro ao iniciar MediaRecorder:', err);
    recordBtn.classList.remove('pending');
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    statusText.textContent = "Erro ao iniciar gravação.";
  }
});

// stop handler
stopBtn.addEventListener('click', () => {
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
            await persistRecording(blob, `Gravação ${recordings.length+1}`);
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
  if (typeof window.loadSessions === 'function') {
    return window.loadSessions();
  }
  try {
    if (typeof window.getAllSessionsFromDb === 'function') {
      sessionsCache = await window.getAllSessionsFromDb();
    } else {
      sessionsCache = [];
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
        // evitar múltiplos registros
        if (worker.__registeredForRecorder) return;
        worker.__registeredForRecorder = true;
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
              // telemetria: mostrar timings se disponíveis
              if (msg.timings && window.appConfig && window.appConfig.telemetry && window.appConfig.telemetry.enabled) {
                if (window.appConfig.telemetry.sendToConsole) {
                  console.log('[spectrogram.metrics]', msg.timings);
                }
              }
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