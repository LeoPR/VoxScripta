// overlay-analyzer.js
// Agora: múltiplos overlays (pontos, linha RMS, segmentação de silêncio).
// Usa analyzer.extractFeatures e meta do espectrograma (window._lastSpectrogramCanvasMeta).

(function(){
  'use strict';

  const btnPoints   = document.getElementById('show-points-btn');
  const btnRms      = document.getElementById('show-rms-btn');
  const btnSegment  = document.getElementById('segment-silence-btn');
  const overlay     = document.getElementById('spectrogram-overlay');

  if (!overlay) {
    console.warn('overlay-analyzer: canvas #spectrogram-overlay não encontrado.');
    return;
  }

  const state = {
    showPoints: false,
    showRms: false,
    showSegments: false
  };

  const featureCache = new Map(); // rec.id -> featuresResult

  function getAnalyzerCfg(){
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        const merged = window.appConfig.getMergedProcessingOptions();
        return (merged && merged.analyzer) ? merged.analyzer : {};
      }
    } catch(_) {}
    return {};
  }

  function getCurrentRecording(){
    try {
      const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
      const audioEl = document.getElementById('audio-player');
      const src = audioEl && audioEl.src ? audioEl.src : null;
      if (src) {
        for (const r of recs) if (r && r.url === src) return r;
      }
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
    if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function')
      throw new Error('analyzer.extractFeatures indisponível');
    const source = rec.blob || rec.url;
    const result = await window.analyzer.extractFeatures(source, {});
    rec.__featuresCache = result;
    featureCache.set(rec.id, result);
    return result;
  }

  function clearOverlay(){
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0,0,overlay.width, overlay.height);
  }

  // Suavização simples (média móvel centrada para frente)
  function smoothSeries(arr, windowSize){
    if (windowSize <= 1) return arr.slice();
    const half = Math.floor(windowSize / 2);
    const out = new Float32Array(arr.length);
    for (let i=0; i<arr.length; i++){
      let acc=0, count=0;
      for (let k=-half; k<=half; k++){
        const idx = i + k;
        if (idx >=0 && idx < arr.length){
          acc += arr[idx];
          count++;
        }
      }
      out[i] = acc / Math.max(1, count);
    }
    return out;
  }

  // Segmentação de silêncio / fala (retorna array de segmentos {startFrame,endFrame,type:'silence'|'speech'})
  function segmentSilence(rmsSeries, maxRms, cfg){
    const thr = maxRms * (cfg.silenceRmsRatio || 0.12);
    const minSil = cfg.minSilenceFrames || 5;
    const minSpeech = cfg.minSpeechFrames || 3;

    const labels = new Array(rmsSeries.length);
    for (let i=0;i<rmsSeries.length;i++){
      labels[i] = (rmsSeries[i] < thr) ? 'silence' : 'speech';
    }

    // fundir em segmentos e aplicar filtros de duração mínima
    const segments = [];
    let curType = labels[0];
    let start = 0;
    for (let i=1;i<labels.length;i++){
      if (labels[i] !== curType){
        segments.push({ startFrame: start, endFrame: i-1, type: curType });
        curType = labels[i];
        start = i;
      }
    }
    segments.push({ startFrame: start, endFrame: labels.length-1, type: curType });

    // Filtragem: se segmento não atingir minFrames, fundir com vizinho anterior ou próximo
    function minFramesFor(type){
      return type === 'silence' ? minSil : minSpeech;
    }
    let changed = true;
    while (changed){
      changed = false;
      for (let i=0;i<segments.length;i++){
        const seg = segments[i];
        const length = seg.endFrame - seg.startFrame + 1;
        if (length < minFramesFor(seg.type)){
          // tentar mesclar
            if (i > 0) {
              // mesclar com anterior
              segments[i-1].endFrame = seg.endFrame;
              segments.splice(i,1);
            } else if (i < segments.length -1){
              segments[i+1].startFrame = seg.startFrame;
              segments.splice(i,1);
            }
            changed = true;
            break;
        }
      }
    }
    return segments;
  }

  function drawAllOverlays(featuresResult){
    const specMeta = window._lastSpectrogramCanvasMeta;
    if (!specMeta) return;

    const meta = featuresResult.meta;
    const { frames, dims, nMels } = meta;
    if (!frames) return;

    const dispW = specMeta.displayWidth;
    const dispH = specMeta.displayHeight;
    const dpr = specMeta.dpr || window.devicePixelRatio || 1;

    // Redimensionar overlay para garantir alinhamento
    overlay.width = Math.round(dispW * dpr);
    overlay.height = Math.round(dispH * dpr);
    overlay.style.width = dispW + 'px';
    overlay.style.height = dispH + 'px';

    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,dispW,dispH);

    const flat = featuresResult.features;
    const melDims = nMels;
    const rmsIndex = nMels;
    const centroidIndex = nMels + 1;

    // Pré-calcular RMS e centróide em índice mel
    const rmsSeries = new Float32Array(frames);
    const centroidMelSeries = new Float32Array(frames);
    let maxRMS = 0;

    for (let f=0; f<frames; f++){
      const base = f * dims;
      const rms = flat[base + rmsIndex];
      rmsSeries[f] = rms;
      if (rms > maxRMS) maxRMS = rms;

      let melSum=0, weighted=0;
      for (let m=0; m<melDims; m++){
        const val = flat[base + m];
        if (val>0){
          melSum += val;
          weighted += val * m;
        }
      }
      centroidMelSeries[f] = (melSum>0) ? (weighted / melSum) : (melDims/2);
    }
    if (maxRMS <= 0) maxRMS = 1;

    // Desenhar segmentação primeiro (fundo) se ativada
    if (state.showSegments){
      const cfg = getAnalyzerCfg();
      const smoothRms = smoothSeries(rmsSeries, cfg.smoothingFrames || 3);
      const segments = segmentSilence(smoothRms, Math.max(...smoothRms), cfg);

      ctx.save();
      segments.forEach(seg => {
        if (seg.type === 'silence'){
          const x1 = (frames>1) ? (seg.startFrame * (dispW-1) / (frames-1)) : 0;
          const x2 = (frames>1) ? (seg.endFrame   * (dispW-1) / (frames-1)) : dispW;
          ctx.fillStyle = 'rgba(255,255,0,0.15)';
          ctx.fillRect(x1, 0, Math.max(1, x2 - x1 + 1), dispH);
        }
      });
      ctx.restore();
    }

    // Desenhar linha RMS se ativo
    if (state.showRms){
      const cfg = getAnalyzerCfg();
      const smoothRms = smoothSeries(rmsSeries, cfg.smoothingFrames || 3);
      const localMax = Math.max(...smoothRms) || 1;

      ctx.save();
      ctx.beginPath();
      for (let f=0; f<frames; f++){
        const x = (frames>1) ? (f * (dispW-1)/(frames-1)) : dispW/2;
        const norm = smoothRms[f] / localMax;
        const y = (1 - norm) * (dispH-1);
        if (f===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.strokeStyle = 'rgba(255,50,50,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    // Desenhar pontos + trilha centróide se ativo
    if (state.showPoints){
      ctx.save();
      // Trilho centróide
      ctx.beginPath();
      for (let f=0; f<frames; f++){
        const x = (frames>1) ? (f * (dispW-1)/(frames-1)) : dispW/2;
        const melIdx = centroidMelSeries[f];
        const y = (melDims>1) ? ((1 - melIdx/(melDims-1)) * (dispH-1)) : dispH/2;
        if (f===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.strokeStyle = 'rgba(0,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Pontos
      for (let f=0; f<frames; f++){
        const x = (frames>1) ? (f * (dispW-1)/(frames-1)) : dispW/2;
        const melIdx = centroidMelSeries[f];
        const y = (melDims>1) ? ((1 - melIdx/(melDims-1)) * (dispH-1)) : dispH/2;
        const norm = rmsSeries[f] / maxRMS;
        const r = 2 + norm * 3;
        ctx.beginPath();
        ctx.arc(x,y,r,0,Math.PI*2);
        ctx.fillStyle = `rgba(255,255,255,${0.55 + 0.35*norm})`;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  async function redraw(){
    if (!state.showPoints && !state.showRms && !state.showSegments){
      clearOverlay();
      return;
    }
    const rec = getCurrentRecording();
    if (!rec){
      clearOverlay();
      return;
    }
    try {
      const result = await ensureFeatures(rec);
      drawAllOverlays(result);
    } catch (err){
      console.error('redraw overlays erro:', err);
    }
  }

  function toggle(btnType){
    switch(btnType){
      case 'points':
        state.showPoints = !state.showPoints;
        if (btnPoints) btnPoints.classList.toggle('active', state.showPoints);
        break;
      case 'rms':
        state.showRms = !state.showRms;
        if (btnRms) btnRms.classList.toggle('active', state.showRms);
        break;
      case 'segment':
        state.showSegments = !state.showSegments;
        if (btnSegment) btnSegment.classList.toggle('active', state.showSegments);
        break;
    }
    redraw();
  }

  if (btnPoints && !btnPoints.__overlay_bound) {
    btnPoints.addEventListener('click', () => toggle('points'));
    btnPoints.__overlay_bound = true;
  }
  if (btnRms && !btnRms.__overlay_bound) {
    btnRms.addEventListener('click', () => toggle('rms'));
    btnRms.__overlay_bound = true;
  }
  if (btnSegment && !btnSegment.__overlay_bound) {
    btnSegment.addEventListener('click', () => toggle('segment'));
    btnSegment.__overlay_bound = true;
  }

  // Expor API menor
  window.analyzerOverlay = Object.assign(window.analyzerOverlay || {}, {
    redraw,
    setShowPoints(v){ state.showPoints = !!v; if (btnPoints) btnPoints.classList.toggle('active', state.showPoints); redraw(); },
    setShowRms(v){ state.showRms = !!v; if (btnRms) btnRms.classList.toggle('active', state.showRms); redraw(); },
    setShowSegments(v){ state.showSegments = !!v; if (btnSegment) btnSegment.classList.toggle('active', state.showSegments); redraw(); },
    segmentSilence // <- exporta segmentSilence aqui também
  });

  // Exporta segmentSilence globalmente para uso em outros módulos (ex: PCA incremental)
  window.segmentSilence = segmentSilence;

})();