// spectrogram-cluster-overlay.js
// Etapa B: overlay interativo que aplica PCA+KMeans sobre frames do espectrograma ao clicar.
// Atualizações:
// - garante carregar features (analyzer.extractFeatures) se rec.__featuresCache ausente
// - fallback para timestamps (usa duração do audio quando timestamps faltam)
// - corrige tamanho do canvas para devicePixelRatio e usa ctx.scale(dpr,dpr)
// - mensagens de erro/alerta mais claras
// - mínima invasão, mantive API e controles existentes.

(function(){
  'use strict';

  const DEFAULTS = {
    spectrogramSelector: '#spectrogram',
    overlaySelector: '#spectrogram-overlay',
    audioSelector: '#audio-player',
    windowBefore: 2.0,
    windowAfter: 2.0,
    mode: 'bar',
    barHeight: 14,
    alpha: 0.45,
    clusterPalette: null
  };

  function defaultPalette() {
    return [
      '#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00',
      '#ffff33','#a65628','#f781bf','#999999',
      '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
      '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'
    ];
  }

  function normalizeFeatureVector(vec, nMels, sampleRate){
    for (let m = 0; m < nMels; m++) {
      vec[m] = Math.log1p(Number.isFinite(vec[m]) ? vec[m] : 0);
    }
    if (!sampleRate) sampleRate = 16000;
    const centroidIdx = nMels + 1;
    if (centroidIdx < vec.length) {
      vec[centroidIdx] = Number.isFinite(vec[centroidIdx]) ? (vec[centroidIdx] / (sampleRate/2)) : 0;
    }
    const zIdx = nMels + 2;
    if (zIdx < vec.length) {
      if (!Number.isFinite(vec[zIdx])) vec[zIdx] = 0;
    }
    return vec;
  }

  // garante que extraiamos features se necessário
  async function ensureFeaturesForRecord(rec) {
    if (!rec) throw new Error('recording inválida');
    if (rec.__featuresCache) return rec.__featuresCache;
    if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function') {
      throw new Error('analyzer.extractFeatures não disponível; execute "Analyze" primeiro.');
    }
    const src = rec.blob || rec.url;
    if (!src) throw new Error('Fonte da gravação não encontrada (rec.blob / rec.url).');
    const res = await window.analyzer.extractFeatures(src, {});
    rec.__featuresCache = res;
    return res;
  }

  function findRecordingForAudio(audioEl) {
    try {
      const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
      const src = audioEl && audioEl.src ? audioEl.src : null;
      if (src && recs && recs.length) {
        for (const r of recs) {
          if (!r) continue;
          if (r.url && String(r.url) === String(src)) return r;
        }
      }
      const dur = audioEl && audioEl.duration ? audioEl.duration : null;
      if (dur && recs && recs.length) {
        for (const r of recs) {
          if (!r || !r.__featuresCache) continue;
          const fr = r.__featuresCache;
          const ts = fr.timestamps;
          if (!ts || !ts.length) continue;
          const last = ts[ts.length - 1];
          if (Math.abs(last - dur) < 0.6) return r;
        }
      }
      if (recs && recs.length) {
        for (const r of recs) if (r && r.__featuresCache) return r;
      }
    } catch (e) {
      console.warn('spectroClusterOverlay: findRecordingForAudio erro', e);
    }
    return null;
  }

  // util para sincronizar tamanho do overlay com DPR
  function syncCanvasSizeToCSS(canvas, referenceCanvas) {
    const rect = referenceCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    const ctx = canvas.getContext('2d');
    // reset and scale so drawing coordinates use CSS pixels
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
  }

  function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== '#') return `rgba(120,120,120,${alpha})`;
    const v = hex.substring(1);
    const r = parseInt(v.substring(0,2),16);
    const g = parseInt(v.substring(2,4),16);
    const b = parseInt(v.substring(4,6),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function makeManager(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const palette = Array.isArray(cfg.clusterPalette) && cfg.clusterPalette.length ? cfg.clusterPalette : defaultPalette();

    const specCanvas = document.querySelector(cfg.spectrogramSelector);
    let overlay = document.querySelector(cfg.overlaySelector);
    const audio = document.querySelector(cfg.audioSelector);

    if (!specCanvas) {
      console.warn('spectroClusterOverlay: canvas de espectrograma não encontrado:', cfg.spectrogramSelector);
      return null;
    }

    if (!overlay) {
      // cria overlay se não existir
      overlay = document.createElement('canvas');
      overlay.id = (cfg.overlaySelector && cfg.overlaySelector.replace('#','')) || 'spectrogram-overlay';
      overlay.className = 'spectrogram-overlay overlay-canvas';
      overlay.style.position = 'absolute';
      overlay.style.left = 0;
      overlay.style.top = 0;
      overlay.style.pointerEvents = 'auto';
      const parent = specCanvas.parentNode;
      if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.appendChild(overlay);
    } else {
      const parent = specCanvas.parentNode;
      if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      overlay.style.position = 'absolute';
      overlay.style.left = 0;
      overlay.style.top = 0;
      overlay.style.pointerEvents = 'auto';
    }

    // sincroniza tamanhos imediatamente
    syncCanvasSizeToCSS(overlay, specCanvas);

    // cria controles mínimos
    const wrapper = specCanvas.parentNode;
    let controlBar = wrapper.querySelector('.sc-overlay-controls');
    if (!controlBar) {
      controlBar = document.createElement('div');
      controlBar.className = 'sc-overlay-controls';
      controlBar.style.position = 'absolute';
      controlBar.style.right = '6px';
      controlBar.style.top = '6px';
      controlBar.style.zIndex = 1300;
      controlBar.style.display = 'flex';
      controlBar.style.gap = '6px';
      wrapper.appendChild(controlBar);
    }

    function btn(label, title) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = label;
      if (title) b.title = title;
      return b;
    }

    const toggleBtn = btn('Clusters', 'Ligar/Desligar overlay de clusters');
    toggleBtn.style.background = '#fff';
    toggleBtn.style.padding = '4px 8px';
    controlBar.appendChild(toggleBtn);

    const fullBtn = btn('Clusterizar faixa', 'Classifica toda a faixa com o treino atual');
    fullBtn.style.background = '#fff';
    fullBtn.style.padding = '4px 8px';
    controlBar.appendChild(fullBtn);

    const exportBtn = btn('Exportar CSV', 'Exportar CSV do trecho/análise atual');
    exportBtn.style.background = '#fff';
    exportBtn.style.padding = '4px 8px';
    controlBar.appendChild(exportBtn);

    let legend = wrapper.querySelector('.sc-overlay-legend');
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'sc-overlay-legend';
      legend.style.position = 'absolute';
      legend.style.left = '6px';
      legend.style.top = '6px';
      legend.style.zIndex = 1300;
      legend.style.background = 'rgba(255,255,255,0.9)';
      legend.style.borderRadius = '6px';
      legend.style.padding = '6px';
      legend.style.fontSize = '12px';
      legend.style.display = 'none';
      wrapper.appendChild(legend);
    }

    let enabled = false;
    let lastAssignments = null;
    let lastFramesMeta = null;

    function clearOverlay() {
      const ctx = overlay.getContext('2d');
      // clear in CSS pixel coords
      const w = overlay.clientWidth || parseFloat(overlay.style.width) || 0;
      const h = overlay.clientHeight || parseFloat(overlay.style.height) || 0;
      ctx.clearRect(0,0,w,h);
      lastAssignments = null;
      lastFramesMeta = null;
      legend.style.display = 'none';
    }

    function renderLegend(kmodel) {
      if (!legend) return;
      if (!kmodel || !kmodel.k) { legend.style.display = 'none'; return; }
      legend.innerHTML = `<div style="font-weight:600;margin-bottom:6px;">Clusters</div>`;
      const ul = document.createElement('div');
      ul.style.display = 'flex';
      ul.style.gap = '8px';
      ul.style.flexWrap = 'wrap';
      for (let i=0;i<kmodel.k;i++){
        const c = document.createElement('div');
        c.style.display = 'flex';
        c.style.alignItems = 'center';
        c.style.gap = '6px';
        const sw = document.createElement('span');
        sw.style.width = '12px';
        sw.style.height = '12px';
        sw.style.display = 'inline-block';
        sw.style.background = (kmodel.colors && kmodel.colors[i]) ? kmodel.colors[i] : (palette[i % palette.length] || '#888');
        sw.style.borderRadius = '3px';
        const lab = document.createElement('span');
        lab.textContent = `C${i} (${(kmodel.sizes && kmodel.sizes[i])?kmodel.sizes[i]:0})`;
        lab.style.fontSize = '12px';
        c.appendChild(sw);
        c.appendChild(lab);
        ul.appendChild(c);
      }
      legend.appendChild(ul);
      legend.style.display = 'block';
    }

    function drawAssignments(assignments, framesMeta, kmodel) {
      if (!assignments || !framesMeta) return;
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0,0,overlay.clientWidth, overlay.clientHeight);
      const w = overlay.clientWidth;
      const h = overlay.clientHeight;
      // get viewport if available
      let viewport = null;
      if (window.getSpectrogramViewport && typeof window.getSpectrogramViewport === 'function') {
        try { viewport = window.getSpectrogramViewport(); } catch(e){ viewport = null; }
      }
      if (!viewport) {
        const dur = audio && audio.duration ? audio.duration : (framesMeta.length ? framesMeta[framesMeta.length-1].time : 1);
        viewport = { t0: 0, t1: dur, duration: dur };
      }

      for (let i=0;i<framesMeta.length;i++){
        const t = framesMeta[i].time;
        const x = Math.round((t - viewport.t0) / Math.max(1e-6, (viewport.t1 - viewport.t0)) * w);
        const nextT = (i+1 < framesMeta.length) ? framesMeta[i+1].time : (framesMeta[i].time + ((framesMeta[i].time - (framesMeta[i-1] ? framesMeta[i-1].time : viewport.t0)) || 0.02));
        const x2 = Math.round((nextT - viewport.t0) / Math.max(1e-6, (viewport.t1 - viewport.t0)) * w);
        const width = Math.max(1, Math.abs(x2 - x));
        const cluster = assignments[i];
        const color = (kmodel && kmodel.colors && kmodel.colors[cluster]) ? kmodel.colors[cluster] : (palette[cluster % palette.length] || '#888');
        ctx.fillStyle = hexToRgba(color, cfg.alpha);
        if (cfg.mode === 'fill') {
          ctx.fillRect(x, 0, width, h);
        } else {
          ctx.fillRect(x, 0, width, Math.min(cfg.barHeight, h));
        }
      }

      lastAssignments = assignments.slice();
      lastFramesMeta = framesMeta.slice();
      if (kmodel && kmodel.k) renderLegend(kmodel);
    }

    // classifica frames entre t0-t1; garante extrair features se necessário
    async function classifyWindowForActiveRecording(rec, t0, t1) {
      if (!rec) throw new Error('Gravação inválida.');
      // garantir features
      let fr;
      try {
        fr = await ensureFeaturesForRecord(rec);
      } catch (e) {
        throw new Error('Falha ao extrair features: ' + (e && e.message ? e.message : e));
      }

      if (!window._pcaModel) throw new Error('PCA não ativo (window._pcaModel). Treine/selecionar um treino.');
      if (!window._kmeansModel) throw new Error('KMeans não ativo (window._kmeansModel). Treine/selecionar um treino.');

      const flat = fr.features;
      const dims = (fr.shape && fr.shape.dims) ? fr.shape.dims : (fr.d || fr.meta && fr.meta.dims) || null;
      const frames = (fr.shape && fr.shape.frames) ? fr.shape.frames : (fr.frames || (flat ? Math.floor(flat.length / dims) : 0));
      const timestamps = (Array.isArray(fr.timestamps) && fr.timestamps.length) ? fr.timestamps.slice() : null;
      const nMels = fr.meta && fr.meta.nMels ? fr.meta.nMels : Math.max(0, (dims ? dims - 3 : 0));
      const sampleRate = (fr.meta && fr.meta.sampleRate) ? fr.meta.sampleRate : 16000;

      // fallback timestamps: linear over audio duration if available
      let ts = timestamps;
      if (!ts || ts.length !== frames) {
        const audDur = audio && audio.duration ? audio.duration : null;
        ts = new Array(frames);
        if (audDur && frames > 1) {
          for (let i=0;i<frames;i++) ts[i] = (i / (frames - 1)) * audDur;
        } else {
          for (let i=0;i<frames;i++) ts[i] = i * 0.02; // fallback 20ms per frame
        }
      }

      // collect indices in [t0,t1]
      const idxs = [];
      for (let i=0;i<ts.length;i++) {
        const tt = ts[i];
        if (tt >= t0 && tt <= t1) idxs.push(i);
      }
      if (!idxs.length) throw new Error('Nenhum frame na janela selecionada.');

      const modelPca = window._pcaModel;
      const modelK = window._kmeansModel;

      const assignments = [];
      const framesMeta = [];

      for (let ii=0; ii<idxs.length; ii++) {
        const f = idxs[ii];
        const base = f * dims;
        const vec = new Float32Array(dims);
        for (let j=0;j<dims;j++) vec[j] = flat[base + j];
        normalizeFeatureVector(vec, nMels, sampleRate);
        const proj = modelPca.project(vec);
        const kdim = modelK.dim || Math.min(modelPca.k || 2, 2);
        const x = new Float32Array(kdim);
        for (let d=0; d<kdim; d++) x[d] = proj[d] || 0;
        const c = modelK.predict ? modelK.predict(x) : 0;
        assignments.push(c);
        framesMeta.push({ time: ts[f], frameIndex: f });
      }

      return { assignments, framesMeta };
    }

    async function clusterizeWholeTrack() {
      if (!enabled) {
        alert('Ative o overlay (clique "Clusters") antes de "Clusterizar faixa".');
        return;
      }
      const rec = findRecordingForAudio(audio);
      if (!rec) { alert('Gravação ativa não encontrada ou sem features. Execute "Analyze" para extrair features antes.'); return; }
      // garantir features
      try {
        await ensureFeaturesForRecord(rec);
      } catch (e) {
        alert('Falha ao extrair features: ' + (e && e.message ? e.message : e));
        return;
      }
      const fr = rec.__featuresCache;
      const ts = (fr && Array.isArray(fr.timestamps) && fr.timestamps.length) ? fr.timestamps : null;
      const t0 = ts && ts.length ? ts[0] : 0;
      const t1 = ts && ts.length ? ts[ts.length - 1] : (audio && audio.duration ? audio.duration : t0 + 1);
      try {
        const res = await classifyWindowForActiveRecording(rec, t0, t1);
        const kmodel = window._kmeansModel ? Object.assign({}, window._kmeansModel) : null;
        if (kmodel && !kmodel.colors) {
          kmodel.colors = [];
          for (let i=0;i<(kmodel.k||0);i++) kmodel.colors[i] = palette[i % palette.length];
          kmodel.sizes = kmodel.clusterSizes ? Array.from(kmodel.clusterSizes) : new Array(kmodel.k||0).fill(0);
        }
        drawAssignments(res.assignments, res.framesMeta, kmodel);
      } catch (err) {
        console.error('spectroClusterOverlay: erro clusterizeWholeTrack', err);
        alert('Erro ao clusterizar faixa inteira: ' + (err && err.message ? err.message : err));
      }
    }

    function exportLastCsv() {
      if (!lastAssignments || !lastFramesMeta || !lastAssignments.length) {
        alert('Nenhuma análise disponível para exportar. Clique no espectrograma primeiro ou execute "Clusterizar faixa".');
        return;
      }
      const rows = [['timeSec','frameIndex','cluster']];
      for (let i=0;i<lastFramesMeta.length;i++){
        const m = lastFramesMeta[i];
        rows.push([m.time, m.frameIndex, lastAssignments[i]]);
      }
      const csv = rows.map(r=>r.map(c=>String(c).replace(/"/g,'""')).map(c=>`"${c}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `spectrogram-clusters-${Date.now()}.csv`;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(url),5000);
    }

    async function onClick(e) {
      if (!enabled) return;
      try {
        syncCanvasSizeToCSS(overlay, specCanvas);
        const rect = specCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        let viewport = null;
        if (window.getSpectrogramViewport && typeof window.getSpectrogramViewport === 'function') {
          try { viewport = window.getSpectrogramViewport(); } catch(e){ viewport = null; }
        }
        const audioDuration = audio && audio.duration ? audio.duration : null;
        if (!viewport) viewport = { t0: 0, t1: audioDuration || 1, duration: audioDuration || 1 };
        const tClick = viewport.t0 + (x / rect.width) * (viewport.t1 - viewport.t0);
        const t0 = Math.max(viewport.t0, tClick - cfg.windowBefore);
        const t1 = Math.min(viewport.t1, tClick + cfg.windowAfter);
        const rec = findRecordingForAudio(audio);
        if (!rec) { alert('Gravação ativa não encontrada ou sem features. Execute "Analyze" para extrair features antes.'); return; }
        const res = await classifyWindowForActiveRecording(rec, t0, t1);
        const kmodel = window._kmeansModel ? Object.assign({}, window._kmeansModel) : null;
        if (kmodel && !kmodel.colors) {
          kmodel.colors = [];
          for (let i=0;i<(kmodel.k||0);i++) kmodel.colors[i] = palette[i % palette.length];
          kmodel.sizes = kmodel.clusterSizes ? Array.from(kmodel.clusterSizes) : new Array(kmodel.k||0).fill(0);
        }
        drawAssignments(res.assignments, res.framesMeta, kmodel);
      } catch (err) {
        console.error('spectroClusterOverlay: erro no click:', err);
        alert('Erro ao classificar trecho: ' + (err && err.message ? err.message : err));
      }
    }

    toggleBtn.onclick = () => {
      enabled = !enabled;
      if (!enabled) {
        toggleBtn.style.background = '#fff';
        clearOverlay();
      } else {
        toggleBtn.style.background = '#cfe';
        syncCanvasSizeToCSS(overlay, specCanvas);
      }
    };

    fullBtn.onclick = () => clusterizeWholeTrack();
    exportBtn.onclick = () => exportLastCsv();

    // resize observer
    const ro = new ResizeObserver(() => syncCanvasSizeToCSS(overlay, specCanvas));
    try { ro.observe(specCanvas); } catch (e) {}

    overlay.addEventListener('click', onClick);

    // quando o treinamento mudar, redesenhar último conjunto se existir
    document.addEventListener('training-changed', () => {
      if (!lastAssignments || !lastFramesMeta) return;
      const kmodel = window._kmeansModel ? Object.assign({}, window._kmeansModel) : null;
      if (kmodel && !kmodel.colors) {
        kmodel.colors = [];
        for (let i=0;i<(kmodel.k||0);i++) kmodel.colors[i] = palette[i % palette.length];
        kmodel.sizes = kmodel.clusterSizes ? Array.from(kmodel.clusterSizes) : new Array(kmodel.k||0).fill(0);
      }
      drawAssignments(lastAssignments, lastFramesMeta, kmodel);
    });

    window.addEventListener('beforeunload', () => {
      try { overlay.removeEventListener('click', onClick); } catch(e){}
    });

    return {
      enable() { enabled = true; toggleBtn.style.background = '#cfe'; syncCanvasSizeToCSS(overlay, specCanvas); },
      disable() { enabled = false; toggleBtn.style.background = '#fff'; clearOverlay(); },
      clear() { clearOverlay(); },
      clusterizeWholeTrack,
      exportLastCsv,
      syncSize: () => syncCanvasSizeToCSS(overlay, specCanvas)
    };
  }

  // expose API and auto-init
  let manager = null;
  window.spectroClusterOverlay = {
    init(options) {
      try {
        manager = makeManager(options || {});
        return manager;
      } catch (e) {
        console.error('spectroClusterOverlay.init erro', e);
        return null;
      }
    },
    getManager() { return manager; }
  };

  function maybeAutoInit() {
    try {
      if (window.spectroClusterOverlay && window.spectroClusterOverlay.getManager && window.spectroClusterOverlay.getManager()) return;
      window.spectroClusterOverlay.init(); // defaults
    } catch (e) {
      console.warn('spectroClusterOverlay: auto init falhou', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoInit);
  } else {
    maybeAutoInit();
  }

})();