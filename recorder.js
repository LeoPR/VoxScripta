// recorder.js — versão completa (sem implementação inline de waveform).
// As funções de waveform (showWaveform, drawLiveWaveform, stopLiveWaveform) são esperadas em waveform.js
// Mantive toda a lógica de gravação, persistência, export/import, espectrogram e handlers.
// IMPORTANTE: waveform.js deve ser carregado antes deste arquivo (index.html já foi atualizado).

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

// sessions cache explícito (evita variáveis implícitas)
let sessionsCache = [];

// util para obter config mesclada
function _getCfg() {
  if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
    return window.appConfig.getMergedProcessingOptions();
  }
  return window.processingOptions || {};
}

// util: formata data no estilo 24h (DD/MM/YYYY HH:mm:ss)
function formatDate24(dateLike) {
  try {
    const d = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
    if (isNaN(d.getTime())) return String(dateLike || '');
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (e) {
    return String(dateLike || '');
  }
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
      // delegar waveform para waveform.js se disponível
      try {
        if (rec.blob && typeof window.showWaveform === 'function') {
          window.showWaveform(rec.blob);
        } else if (rec.url && typeof window.showWaveform === 'function') {
          window.showWaveform(rec.url);
        }
      } catch (e) {
        console.warn('showWaveform delegation failed:', e);
      }
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
            recordings[i] = { ...recordings[i], id: savedId, persisted: true };
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
// Render sessions list (delegado para sessions.js - stub de compatibilidade)
// ------------------------------
function renderSessionsList() {
  if (typeof window.renderSessionsList === 'function') {
    window.renderSessionsList();
  } else {
    const container = document.getElementById('sessions-list');
    if (!container) return;
    container.innerHTML = '';
    sessionsCache.sort((a,b) => b.date - a.date);
    sessionsCache.forEach(s => {
      const item = document.createElement('div');
      item.className = 'session-item';
      const title = document.createElement('div');
      title.textContent = s.name || `Sessão ${formatDate24(s.date)}`;
      item.appendChild(title);
      item.onclick = () => selectSession(s.id);
      container.appendChild(item);
    });
    if (sessionsCache.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma sessão salva</div>';
    }
  }
}

// ------------------------------
// Render recordings list in workspace (padronizado visualmente com sessions)
// ------------------------------
function renderRecordingsList(list) {
  const container = document.getElementById('recordings-list');
  if (!container) return;
  container.innerHTML = '';
  const arr = list || [];
  arr.forEach((rec, idx) => {
    const item = document.createElement('div');
    item.className = 'recording-item' + (idx === currentIdx ? ' selected' : '');
    // title para hover-preview com data 24h
    item.title = `${rec.name || ''}\n${formatDate24(rec.date)}`;

    // Left: título (linha 1) + meta (linha 2 pequena)
    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.flexDirection = 'column';
    left.style.flex = '1 1 auto';
    left.style.minWidth = '0'; // permite truncamento do título

    // título com badges inline (linha 1)
    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.gap = '8px';
    titleRow.style.minWidth = '0';

    const title = document.createElement('div');
    title.className = 'recording-name';
    title.textContent = rec.name || `Gravação ${idx+1}`;
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.whiteSpace = 'nowrap';
    titleRow.appendChild(title);

    if (rec.persisted) {
      const badge = document.createElement('span');
      badge.style.fontSize = '12px';
      badge.style.color = 'green';
      badge.title = 'Gravação persistida no banco';
      badge.textContent = '✓';
      titleRow.appendChild(badge);
    } else if (typeof rec.id === 'string' && rec.id && rec.id.startsWith('TEMP__')) {
      const tempBadge = document.createElement('span');
      tempBadge.style.fontSize = '12px';
      tempBadge.style.color = '#999';
      tempBadge.title = 'Ainda não persistido';
      tempBadge.textContent = '•';
      titleRow.appendChild(tempBadge);
    }

    left.appendChild(titleRow);

    const meta = document.createElement('div');
    meta.className = 'recording-meta';
    meta.textContent = formatDate24(rec.date);
    left.appendChild(meta);

    item.appendChild(left);

    // Right: ações agrupadas (padronizado com sessions)
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '8px';
    right.style.alignItems = 'center';

    const play = document.createElement('button');
    play.className = 'play-btn';
    play.innerHTML = '▶';
    play.title = 'Reproduzir';
    play.setAttribute('aria-label', 'Reproduzir gravação');
    play.onclick = (ev) => {
      ev.stopPropagation();
      playRecording(rec);
    };
    right.appendChild(play);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'small';
    exportBtn.innerHTML = '⤓';
    exportBtn.title = 'Exportar gravação';
    exportBtn.setAttribute('aria-label', 'Exportar gravação');
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
    right.appendChild(exportBtn);

    const rename = document.createElement('button');
    rename.className = 'rename-btn';
    rename.innerHTML = '✏️';
    rename.title = 'Editar nome';
    rename.setAttribute('aria-label', 'Editar gravação');
    rename.onclick = (ev) => {
      ev.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.value = title.textContent || '';
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          const newVal = input.value;
          title.textContent = newVal;
          if (typeof saveChangesToSessionRecording === 'function') saveChangesToSessionRecording({ ...rec, name: newVal });
        }
      };
      input.onblur = () => {
        const newVal = input.value;
        title.textContent = newVal;
        if (typeof saveChangesToSessionRecording === 'function') saveChangesToSessionRecording({ ...rec, name: newVal });
      };
      title.innerHTML = '';
      title.appendChild(input);
      input.focus();
    };
    right.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.innerHTML = '🗑️';
    del.title = 'Apagar gravação';
    del.setAttribute('aria-label', 'Apagar gravação');
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (!confirm('Apagar gravação?')) return;
      if (window.selectedSessionId && typeof window.getSessionById === 'function') {
        (async () => {
          try {
            const sess = await window.getSessionById(window.selectedSessionId);
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
    right.appendChild(del);

    item.appendChild(right);

    item.onclick = () => selectRecordingInUI(idx, rec);
    container.appendChild(item);
  });
  if (arr.length === 0) {
    container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma gravação nesta sessão / workspace</div>';
  }
}

// ------------------------------
// selectRecordingInUI — seleciona, atualiza UI e dispara processamento/reprodução
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
    // waveform delegated to waveform.js
    if (typeof window.showWaveform === 'function') {
      try { window.showWaveform(rec.blob); } catch (_) {}
    }
    processAndPlayBlobDelegator(rec.blob).catch(()=>{});
  } else if (rec && rec.url) {
    if (typeof window.showWaveform === 'function') {
      try { window.showWaveform(rec.url); } catch (_) {}
    }
    fetch(rec.url).then(r => r.blob()).then(b => processAndPlayBlobDelegator(b)).catch(()=>{});
  }
}

// ------------------------------
// selecionar sessão (carrega gravações)
// ------------------------------
async function selectSession(id) {
  if (typeof window.selectSession === 'function') {
    return window.selectSession(id);
  }
}

// ------------------------------
// processAndPlayBlob wrapper: delega para audio.js via window.processAndPlayBlob
// ------------------------------
async function processAndPlayBlobDelegator(blob) {
  if (typeof window.processAndPlayBlob === 'function') {
    try {
      return await window.processAndPlayBlob(blob);
    } catch (err) {
      console.warn('processAndPlayBlob (window) falhou:', err);
      return null;
    }
  } else {
    // fallback local (encode + set player) — use the canonical encodeWAV from audio.js
    try {
      const aCtx = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await aCtx.decodeAudioData(arrayBuffer);
      const sampleRate = audioBuffer.sampleRate;
      const raw = audioBuffer.getChannelData(0);
      const { processed } = applyAGC(raw, (window.processingOptions && window.processingOptions.agc && window.processingOptions.agc.targetRMS) || 0.08, (window.processingOptions && window.processingOptions.agc && window.processingOptions.agc.maxGain) || 8, (window.processingOptions && window.processingOptions.agc && window.processingOptions.agc.limiterThreshold) || 0.99);
      // use encodeWAV provided by audio.js (loaded earlier)
      const wavBlob = window.encodeWAV(processed, sampleRate);
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

  const smoothing = (cfg.ui && cfg.ui.imageSmoothingEnabled !== undefined) ? cfg.ui.imageSmoothingEnabled : ((cfg.waveform && cfg.waveform.imageSmoothing) || false);
  ctx.imageSmoothingEnabled = !!smoothing;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, visualWidth, visualHeight);
  ctx.drawImage(off, 0, 0, srcWidth, srcHeight, 0, 0, visualWidth, visualHeight);
  spectrogramCanvas.style.display = 'block';
}

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
  statusText.textContent = `Selecionado: ${formatDate24(rec.date)}`;
  if (rec && rec.blob) {
    if (typeof window.showWaveform === 'function') window.showWaveform(rec.blob).catch(()=>{});
    processAndPlayBlobDelegator(rec.blob).catch(()=>{});
  } else if (rec && rec.url) {
    if (typeof window.showWaveform === 'function') window.showWaveform(rec.url).catch(()=>{});
    try {
      fetch(rec.url).then(r => r.blob()).then(b => processAndPlayBlobDelegator(b)).catch(()=>{});
    } catch (e) { /* ignore */ }
  }
  if (typeof window.renderHistory === 'function') window.renderHistory(recordings, currentIdx);
};

// navigation
try {
  prevBtn.addEventListener('click', () => {
    if (recordings.length === 0) return;
    const next = currentIdx <= 0 ? 0 : currentIdx - 1;
    window.onSelectRecording(next);
  });
} catch(_) {}
try {
  nextBtn.addEventListener('click', () => {
    if (recordings.length === 0) return;
    const next = currentIdx >= recordings.length - 1 ? recordings.length - 1 : (currentIdx === -1 ? recordings.length - 1 : currentIdx + 1);
    window.onSelectRecording(next);
  });
} catch(_) {}

// ------------------------------
// NOVO: Importar gravação (arquivo de áudio) via #import-recording-input
// ------------------------------
if (importRecordingInput && !importRecordingInput.__rec_import_bound) {
  importRecordingInput.addEventListener('change', async (ev) => {
    const file = ev.target && ev.target.files && ev.target.files[0] ? ev.target.files[0] : null;
    if (!file) return;
    try {
      statusText.textContent = 'Importando áudio...';
      const baseName = file.name ? file.name.replace(/\.[^/.]+$/, '') : '';
      const suggestedName = baseName || `Gravação ${recordings.length + 1}`;
      const rec = await persistRecording(file, suggestedName);
      let idx = recordings.findIndex(r => r && r.id === rec.id);
      if (idx < 0) idx = recordings.length - 1;
      selectRecordingInUI(idx, recordings[idx] || rec);
      statusText.textContent = 'Áudio importado.';
    } catch (err) {
      console.error('Erro ao importar gravação:', err);
      alert('Erro ao importar gravação. Veja o console para detalhes.');
      statusText.textContent = 'Erro ao importar.';
    } finally {
      try { importRecordingInput.value = ''; } catch(_) {}
    }
  });
  importRecordingInput.__rec_import_bound = true;
}

// ------------------------------
// Recording: handlers mínimos para Gravar/Parar
// ------------------------------
if (recordBtn && !recordBtn.__recorder_click_bound) {
  recordBtn.addEventListener('click', async () => {
    try {
      statusText.textContent = 'Iniciando...';
      recordBtn.disabled = true;
      stopBtn.disabled = false;

      liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      try { await audioCtx.resume(); } catch (_) {}
      sourceNode = audioCtx.createMediaStreamSource(liveStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      sourceNode.connect(analyser);

      // delegar desenho ao waveform.js se disponível
      try {
        if (typeof window.drawLiveWaveform === 'function') {
          window.drawLiveWaveform(analyser);
        }
      } catch (e) {
        console.warn('drawLiveWaveform delegation failed:', e);
      }

      mediaRecorder = new MediaRecorder(liveStream);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
      mediaRecorder.onstart = () => {
        statusText.textContent = 'Gravando...';
        recordBtn.disabled = false;
      };
      mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(audioChunks, { type: 'audio/webm' });
          const suggestedName = `Gravação ${recordings.length + 1}`;
          await persistRecording(blob, suggestedName);
        } catch (err) {
          console.error('Erro ao finalizar gravação:', err);
          statusText.textContent = 'Erro ao finalizar gravação.';
        } finally {
          // Limpeza
          recordBtn.disabled = false;
          stopBtn.disabled = true;
          if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx = null; }
          if (liveStream) {
            try { liveStream.getTracks().forEach(t => t.stop()); } catch(_) {}
            liveStream = null;
          }
          // parar desenho live (delegado)
          try { if (typeof window.stopLiveWaveform === 'function') window.stopLiveWaveform(); } catch(_) {}
          if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
        }
      };
      mediaRecorder.onerror = (ev) => {
        console.error('mediaRecorder.onerror', ev);
        statusText.textContent = 'Erro na gravação.';
      };

      mediaRecorder.start();
    } catch (err) {
      console.error('Erro ao iniciar gravação:', err);
      statusText.textContent = 'Erro ao iniciar gravação.';
      recordBtn.disabled = false;
      stopBtn.disabled = true;
      try { if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; } } catch(_){}
      try { if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx = null; } } catch(_){}
    }
  });
  recordBtn.__recorder_click_bound = true;
}

if (stopBtn && !stopBtn.__recorder_click_bound) {
  stopBtn.addEventListener('click', () => {
    if (!mediaRecorder) return;
    try {
      statusText.textContent = 'Parando...';
      if (typeof mediaRecorder.requestData === 'function') {
        try { mediaRecorder.requestData(); } catch(_) {}
      }
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch (err) {
      console.error('Erro ao chamar stop():', err);
      statusText.textContent = 'Erro ao parar.';
    }
  });
  stopBtn.__recorder_click_bound = true;
}

// ------------------------------
// Fallback local para carregar sessões (evita colisão com sessions.js)
// ------------------------------
async function loadSessionsSafe() {
  try {
    if (typeof window.getAllSessionsFromDb === 'function') {
      sessionsCache = await window.getAllSessionsFromDb();
    } else {
      sessionsCache = [];
    }
    renderSessionsList();
  } catch (err) {
    console.warn('loadSessionsSafe: erro ao carregar sessões:', err);
    sessionsCache = [];
    renderSessionsList();
  }
}

// ------------------------------
// Init: register worker.onmessage handler (if available) and load sessions (non-blocking)
// ------------------------------
(function init() {
  try {
    if (typeof window.openDb === 'function') {
      window.openDb().catch(err => console.warn('openDb falhou no init (não bloqueante):', err));
    }
    if (typeof window.ensureWorker === 'function') {
      window.ensureWorker().then(worker => {
        if (!worker) return;
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
    if (typeof window.loadSessions === 'function') {
      window.loadSessions().catch(err => console.warn('loadSessions (sessions.js) no init falhou (não bloqueante):', err));
    } else {
      loadSessionsSafe().catch(err => console.warn('loadSessionsSafe no init falhou (não bloqueante):', err));
    }
  } catch (err) {
    console.warn('Erro ao inicializar recorder (não fatal):', err);
  }
})();