// overlay-analyzer.js
// Passo A: sobrepor pontos (features por frame) sobre o espectrograma.
// Requer analyzer.extractFeatures (analyzer.js) e recorder.js (para obter gravação corrente).
// Toggle via botão #show-points-btn

(function(){
  'use strict';

  const btn = document.getElementById('show-points-btn');
  const overlay = document.getElementById('spectrogram-overlay');

  if (!overlay) {
    console.warn('overlay-analyzer: canvas #spectrogram-overlay não encontrado.');
    return;
  }

  // Estado de toggle
  let overlayVisible = false;

  // Cache por gravação (id -> resultado do extractFeatures)
  const featureCache = new Map();

  function getCurrentRecording(){
    try {
      const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
      const audioEl = document.getElementById('audio-player');
      const src = audioEl && audioEl.src ? audioEl.src : null;
      if (src) {
        for (const r of recs) {
          if (r && r.url === src) return r;
        }
      }
      // fallback: item .selected
      const sel = document.querySelector('#recordings-list .recording-item.selected .recording-name');
      if (sel) {
        const name = sel.textContent.trim();
        const found = recs.find(r => r && r.name === name);
        if (found) return found;
      }
      return null;
    } catch(e){
      console.warn('getCurrentRecording erro:', e);
      return null;
    }
  }

  async function ensureFeatures(rec){
    if (!rec) return null;
    if (rec.__featuresCache) return rec.__featuresCache;
    if (featureCache.has(rec.id)) {
      rec.__featuresCache = featureCache.get(rec.id);
      return rec.__featuresCache;
    }
    if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function') {
      throw new Error('analyzer.extractFeatures indisponível');
    }
    const source = rec.blob || rec.url;
    const result = await window.analyzer.extractFeatures(source, {}); // defaults
    rec.__featuresCache = result;
    featureCache.set(rec.id, result);
    return result;
  }

  function clearOverlay(){
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0,0,overlay.width, overlay.height);
  }

  function drawPoints(featuresResult, options={}){
    if (!featuresResult || !featuresResult.meta || !featuresResult.features) return;
    const meta = featuresResult.meta;
    const { frames, dims, nMels } = meta;
    if (!frames || frames < 1) return;

    const specMeta = window._lastSpectrogramCanvasMeta;
    if (!specMeta) {
      console.warn('overlay-analyzer: meta do espectrograma não encontrada (desenhe espectrograma antes).');
      return;
    }

    const dispW = specMeta.displayWidth;
    const dispH = specMeta.displayHeight;
    const dpr = specMeta.dpr || window.devicePixelRatio || 1;

    // Garantir dimensionamento físico do overlay
    // (recorder.js já faz isso, mas reforçamos caso tenha ocorrido resize)
    overlay.width = Math.round(dispW * dpr);
    overlay.height = Math.round(dispH * dpr);
    overlay.style.width = dispW + 'px';
    overlay.style.height = dispH + 'px';

    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,dispW,dispH);

    const melCount = nMels;
    const melDims = nMels; // primeiros nMels
    const rmsIndex = nMels; // após mel energies
    const centroidIndex = nMels + 1;
    // const zcrIndex = nMels + 2; // não usado por enquanto

    const flat = featuresResult.features;

    // Calcular RMS máximo para normalizar tamanho dos pontos
    let maxRMS = 0;
    for (let f=0; f<frames; f++){
      const base = f * dims;
      const rms = flat[base + rmsIndex];
      if (rms > maxRMS) maxRMS = rms;
    }
    if (maxRMS <= 0) maxRMS = 1;

    // Traçar path do centróide (suaviza visual)
    ctx.beginPath();
    let first = true;

    for (let f=0; f<frames; f++){
      const base = f * dims;

      // Recalcular centróide em índice de mel (preferimos centróide em bins de mel, não em Hz)
      // Já temos 'centroidIndex' em Hz — mas podemos montar centróide de índice para trajetória entre 0..(nMels-1).
      // Para caminho usando intensidades mel:
      let melSum = 0, weighted = 0;
      for (let m=0; m<melDims; m++){
        const val = flat[base + m];
        if (val > 0){
          melSum += val;
          weighted += val * m;
        }
      }
      let centroidMelIdx = (melSum > 0) ? (weighted / melSum) : (melDims/2);

      // Coordenadas
      const x = (frames > 1) ? (f * (dispW - 1) / (frames - 1)) : dispW/2;
      const y = (melDims > 1) ? ((1 - centroidMelIdx / (melDims - 1)) * (dispH - 1)) : dispH/2;

      if (first){
        ctx.moveTo(x,y);
        first = false;
      } else {
        ctx.lineTo(x,y);
      }
    }
    ctx.strokeStyle = 'rgba(0,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Desenhar pontos
    for (let f=0; f<frames; f++){
      const base = f * dims;
      // RMS para tamanho
      const rms = flat[base + rmsIndex];
      // centróide novamente (poderíamos reusar mas mantemos consistência)
      let melSum = 0, weighted = 0;
      for (let m=0; m<melDims; m++){
        const val = flat[base + m];
        if (val > 0){
          melSum += val;
          weighted += val * m;
        }
      }
      let centroidMelIdx = (melSum > 0) ? (weighted / melSum) : (melDims/2);
      const x = (frames > 1) ? (f * (dispW - 1) / (frames - 1)) : dispW/2;
      const y = (melDims > 1) ? ((1 - centroidMelIdx / (melDims - 1)) * (dispH - 1)) : dispH/2;

      const norm = Math.min(1, rms / maxRMS);
      const r = 2 + norm * 3; // raio 2..5
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI*2);
      ctx.fillStyle = `rgba(255,255,255,${0.55 + 0.35*norm})`;
      ctx.fill();
    }
  }

  async function togglePoints(){
    try {
      const rec = getCurrentRecording();
      if (!rec) {
        alert('Selecione/grave uma gravação antes.');
        return;
      }
      if (!overlayVisible){
        const result = await ensureFeatures(rec);
        drawPoints(result);
        overlayVisible = true;
        btn.classList.add('active');
      } else {
        clearOverlay();
        overlayVisible = false;
        btn.classList.remove('active');
      }
    } catch (err) {
      console.error('togglePoints erro:', err);
      alert('Erro ao gerar pontos. Veja console.');
    }
  }

  if (btn && !btn.__overlay_bound) {
    btn.addEventListener('click', togglePoints);
    btn.__overlay_bound = true;
  }

  // API pública opcional
  window.analyzerOverlay = {
    clear: () => { clearOverlay(); overlayVisible = false; if (btn) btn.classList.remove('active'); },
    showForCurrent: async () => {
      const rec = getCurrentRecording();
      if (!rec) return;
      const result = await ensureFeatures(rec);
      drawPoints(result);
      overlayVisible = true;
      if (btn) btn.classList.add('active');
    }
  };

})();