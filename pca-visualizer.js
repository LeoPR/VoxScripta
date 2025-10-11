// pca-visualizer.js
// Visualizador de projeções PC1 x PC2 com cache por assinatura do modelo PCA.
// Ajustes:
// - Usa por padrão gravações do Train Pool (fallback: workspace se Train Pool vazio).
// - Se existir window._kmeansModel, colore os pontos por cluster (PC1×PC2).
// - Export CSV inclui coluna 'cluster' quando houver K-Means.
// - Legenda mostra clusters (KMeans) e depois gravações.
// - Invalida cache quando window._pcaModel.__updatedAt muda.

(function(){
  'use strict';

  const VIS_MODAL_ID = 'pca-vis-modal';
  const VIS_BTN_ID = 'pca-vis-open-btn';
  const PCA_MODAL_ID = 'pca-modal';

  function getCfg() {
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        return window.appConfig.getMergedProcessingOptions();
      }
    } catch (_) {}
    return { pca:{}, analyzer:{} };
  }

  function normalizeFeatureVector(vec, nMels, sampleRate){
    for (let m = 0; m < nMels; m++) vec[m] = Math.log1p(Number.isFinite(vec[m]) ? vec[m] : 0);
    if (!sampleRate) sampleRate = 16000;
    const centroidIdx = nMels+1;
    vec[centroidIdx] = Number.isFinite(vec[centroidIdx]) ? (vec[centroidIdx] / (sampleRate/2)) : 0;
    const zIdx = nMels+2;
    if (!Number.isFinite(vec[zIdx])) vec[zIdx] = 0;
    return vec;
  }

  async function ensureFeatures(rec){
    if (!rec) return null;
    if (rec.__featuresCache) return rec.__featuresCache;
    if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function')
      throw new Error('analyzer.extractFeatures indisponível');
    const source = rec.blob || rec.url;
    const result = await window.analyzer.extractFeatures(source, {});
    rec.__featuresCache = result;
    return result;
  }

  function getSegmentSilenceFn(){
    return (window.segmentSilence || (window.analyzerOverlay && window.analyzerOverlay.segmentSilence));
  }

  function modelSignature(model) {
    if (!model || !model.components) return 'no-model';
    let h = 5381;
    const comps = model.components;
    const mean = model.mean || new Float32Array(model.d || 0);
    h = ((h << 5) + h) ^ (model.d || 0);
    h = ((h << 5) + h) ^ (model.k || 0);
    if (model.__updatedAt) h = ((h << 5) + h) ^ (model.__updatedAt & 0xffffffff);
    const step = Math.max(1, Math.floor(comps.length / 1000));
    for (let i = 0; i < comps.length; i += step) {
      const v = Math.round((comps[i] || 0) * 1e6);
      h = ((h << 5) + h) ^ (v & 0xFFFFFFFF);
      const mi = mean[i % (mean.length || 1)] || 0;
      const mv = Math.round(mi * 1e6);
      h = ((h << 5) + h) ^ (mv & 0xFFFFFFFF);
    }
    return 'm' + (h >>> 0).toString(16);
  }

  function getSelectionForVisualization() {
    const all = (typeof window.getWorkspaceRecordings === 'function') ? (window.getWorkspaceRecordings() || []) : (window.recordings || []);
    let ids = [];
    try {
      if (window.uiAnalyzer && typeof window.uiAnalyzer.getTrainPool === 'function') {
        ids = window.uiAnalyzer.getTrainPool() || [];
      }
    } catch (_) { ids = []; }

    if (Array.isArray(ids) && ids.length) {
      const selected = ids.map(id => all.find(r => r && String(r.id) === String(id))).filter(Boolean);
      if (selected.length) {
        return {
          recs: selected,
          label: `Train Pool (${selected.length} gravação(ões))`,
          signature: 'train:' + ids.map(String).join(',')
        };
      }
    }
    return {
      recs: all,
      label: `Workspace (todas) (${all.length} gravação(ões))`,
      signature: 'workspace:all'
    };
  }

  async function computeProjectionsPC12(recsToUse) {
    if (!window._pcaModel) throw new Error('Modelo PCA não encontrado. Execute o PCA primeiro.');
    const model = window._pcaModel;
    const cfg = getCfg();
    const pcaCfg = cfg.pca || {};
    const silenceEnabled = !!pcaCfg.silenceFilterEnabled;
    const silenceRmsRatio = pcaCfg.silenceRmsRatio || 0.05;
    const minSilenceFrames = pcaCfg.minSilenceFrames || 5;
    const minSpeechFrames = pcaCfg.minSpeechFrames || 3;

    const recs = Array.isArray(recsToUse) ? recsToUse : [];
    if (!recs || !recs.length) throw new Error('Sem gravações para visualizar.');

    const loaded = [];
    let dims = null;
    let globalMaxRms = 0;
    let sampleRate = 16000;

    for (const rec of recs) {
      const fr = await ensureFeatures(rec);
      if (!fr || !fr.shape || !fr.meta) continue;
      if (dims == null) dims = fr.shape.dims;
      if (fr.shape.dims !== dims) {
        console.warn('Dimensão inconsistente; pulando rec id=', rec.id);
        continue;
      }
      if (fr.meta && fr.meta.sampleRate) sampleRate = fr.meta.sampleRate;
      const flat = fr.features;
      const frames = fr.shape.frames;
      const rmsIndex = fr.meta.nMels;
      for (let f=0; f<frames; f++){
        const rms = flat[f*dims + rmsIndex];
        if (rms > globalMaxRms) globalMaxRms = rms;
      }
      loaded.push({ rec, fr });
    }
    if (!loaded.length) throw new Error('Nenhuma feature válida carregada para visualização.');
    if (!dims) throw new Error('Dims inválida.');

    const segFn = getSegmentSilenceFn();
    const useSeg = silenceEnabled && typeof segFn === 'function';

    const allPoints = []; // [{x,y,recId,recName,frame,timeSec}]
    const perRecCounts = new Map();

    for (const { rec, fr } of loaded) {
      const flat = fr.features;
      const frames = fr.shape.frames;
      const nMels = fr.meta.nMels;
      const rmsIdx = nMels;

      let speechIdxs = [];
      if (useSeg) {
        const rmsArr = new Float32Array(frames);
        for (let f=0; f<frames; f++) rmsArr[f] = flat[f*dims + rmsIdx];
        const segs = segFn(rmsArr, globalMaxRms, { silenceRmsRatio, minSilenceFrames, minSpeechFrames }) || [];
        for (const seg of segs) {
          if (seg.type === 'speech') {
            for (let f=seg.startFrame; f<=seg.endFrame; f++) speechIdxs.push(f);
          }
        }
      } else {
        for (let f=0; f<frames; f++) speechIdxs.push(f);
      }

      for (const f of speechIdxs) {
        const base = f*dims;
        let vec = new Float32Array(flat.subarray(base, base + dims));
        vec = normalizeFeatureVector(vec, nMels, sampleRate);
        const proj = model.project(vec);
        const x = proj[0] || 0;
        const y = proj[1] || 0;

        const t = (fr.timestamps && fr.timestamps[f] !== undefined) ? fr.timestamps[f] : f;
        allPoints.push({ x, y, recId: rec.id, recName: rec.name || String(rec.id), frame: f, timeSec: t });
      }
      perRecCounts.set(rec.id, (perRecCounts.get(rec.id) || 0) + speechIdxs.length);
    }

    return { points: allPoints, perRecCounts };
  }

  function drawScatter(canvas, points, colorForPoint, bbox) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    if (!points || !points.length) return;

    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    if (bbox && typeof bbox === 'object') {
      minX = bbox.minX; maxX = bbox.maxX; minY = bbox.minY; maxY = bbox.maxY;
    } else {
      for (const p of points) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX) || !isFinite(maxX) || minX===maxX) { minX-=1; maxX+=1; }
    if (!isFinite(minY) || !isFinite(maxY) || minY===maxY) { minY-=1; maxY+=1; }

    const plotL = 50, plotT = 20, plotR = w - 20, plotB = h - 40;
    const plotW = plotR - plotL;
    const plotH = plotB - plotT;

    function sx(x){ return plotL + ((x - minX) / (maxX - minX)) * plotW; }
    function sy(y){ return plotB - ((y - minY) / (maxY - minY)) * plotH; }

    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotL, plotB); ctx.lineTo(plotR, plotB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(plotL, plotT); ctx.lineTo(plotL, plotB); ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    const ticks = 4;
    for (let i=0;i<=ticks;i++){
      const tx = minX + i*(maxX-minX)/ticks;
      const px = sx(tx);
      ctx.fillText(tx.toFixed(1), px-10, plotB+14);
      const ty = minY + i*(maxY-minY)/ticks;
      const py = sy(ty);
      ctx.fillText(ty.toFixed(1), plotL-40, py+4);
    }

    for (let i=0;i<points.length;i++) {
      const p = points[i];
      const cx = sx(p.x);
      const cy = sy(p.y);
      ctx.beginPath();
      ctx.arc(cx, cy, 2.6, 0, Math.PI*2);
      ctx.fillStyle = colorForPoint(p, i);
      ctx.fill();
    }

    ctx.fillStyle = '#222';
    ctx.font = '12px sans-serif';
    ctx.fillText('PC1', (plotL+plotR)/2 - 10, h - 8);
    ctx.save();
    ctx.translate(14, (plotT+plotB)/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText('PC2', 0, 0);
    ctx.restore();
  }

  function colorPalette() {
    return [
      '#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00',
      '#ffff33','#a65628','#f781bf','#999999',
      '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
      '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'
    ];
  }

  function buildLegend(container, recsOrder, colorForRec, countsMap, sourceInfo, kmeansInfo){
    container.innerHTML = '';
    const title = document.createElement('div');
    title.style.fontSize = '12px';
    title.style.color = '#666';
    title.style.margin = '2px 0 6px 0';
    title.textContent = sourceInfo || '';
    container.appendChild(title);

    if (kmeansInfo && kmeansInfo.k && Array.isArray(kmeansInfo.sizes)) {
      const h = document.createElement('div');
      h.style.marginBottom = '6px';
      h.innerHTML = `<div style="font-size:12px;"><b>Clusters (KMeans):</b> ${kmeansInfo.k} &nbsp; Inércia: ${kmeansInfo.inertia ? kmeansInfo.inertia.toFixed(3) : '—'}</div>`;
      container.appendChild(h);

      const ulc = document.createElement('ul');
      ulc.style.listStyle = 'none';
      ulc.style.margin = '4px 0 8px 0';
      ulc.style.padding = '0';
      ulc.style.display = 'flex';
      ulc.style.flexWrap = 'wrap';
      ulc.style.gap = '10px';
      for (let i=0;i<kmeansInfo.k;i++){
        const li = document.createElement('li');
        const sw = document.createElement('span');
        sw.style.display = 'inline-block';
        sw.style.width = '12px';
        sw.style.height = '12px';
        sw.style.borderRadius = '3px';
        sw.style.background = kmeansInfo.colors[i] || '#888';
        sw.style.marginRight = '6px';
        const label = document.createElement('span');
        label.textContent = `C${i} (${kmeansInfo.sizes[i]||0})`;
        li.appendChild(sw);
        li.appendChild(label);
        ulc.appendChild(li);
      }
      container.appendChild(ulc);
    }

    if (recsOrder && recsOrder.length) {
      const ul = document.createElement('ul');
      ul.style.listStyle = 'none';
      ul.style.margin = '8px 0 0 0';
      ul.style.padding = '0';
      ul.style.display = 'flex';
      ul.style.flexWrap = 'wrap';
      ul.style.gap = '10px';
      for (const {id, name} of recsOrder){
        const li = document.createElement('li');
        const sw = document.createElement('span');
        sw.style.display = 'inline-block';
        sw.style.width = '12px';
        sw.style.height = '12px';
        sw.style.borderRadius = '3px';
        sw.style.background = colorForRec(id);
        sw.style.marginRight = '6px';
        const label = document.createElement('span');
        label.textContent = `${name || id} (${countsMap.get(id)||0})`;
        li.appendChild(sw);
        li.appendChild(label);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    }
  }

  function createVisModal() {
    const old = document.getElementById(VIS_MODAL_ID);
    if (old) old.remove();

    const m = document.createElement('div');
    m.id = VIS_MODAL_ID;
    m.className = 'analyzer-modal';
    m.style.zIndex = '2200';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('div');
    title.textContent = 'Projeções PCA (PC1 × PC2)';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'small';
    closeBtn.textContent = '✖';
    closeBtn.onclick = () => m.remove();
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.maxHeight = '60vh';
    body.style.overflow = 'auto';

    const canvas = document.createElement('canvas');
    canvas.width = 680;
    canvas.height = 420;
    canvas.style.border = '1px solid #eee';
    canvas.style.borderRadius = '6px';
    canvas.style.display = 'block';
    canvas.style.margin = '4px 0 8px 0';

    const legend = document.createElement('div');
    legend.id = 'pca-vis-legend';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'small';
    exportBtn.textContent = 'Exportar CSV';
    exportBtn.onclick = () => exportCSVFromLast();

    const close2 = document.createElement('button');
    close2.className = 'small';
    close2.textContent = 'Fechar';
    close2.onclick = () => m.remove();

    actions.appendChild(exportBtn);
    actions.appendChild(close2);

    body.appendChild(canvas);
    body.appendChild(legend);

    m.appendChild(header);
    m.appendChild(body);
    m.appendChild(actions);
    document.body.appendChild(m);

    return { modal: m, canvas, legend };
  }

  let _lastPoints = null;
  let _lastRecsOrder = null;
  let _lastKMeansAssignments = null;

  function exportCSVFromLast(){
    if (!_lastPoints || !_lastPoints.length) {
      alert('Sem dados para exportar. Gere a visualização primeiro.');
      return;
    }
    const rows = [['recordingId','recordingName','frameIndex','timeSec','PC1','PC2','cluster']];
    for (let i=0; i<_lastPoints.length; i++) {
      const p = _lastPoints[i];
      const cluster = (_lastKMeansAssignments && _lastKMeansAssignments[i] !== undefined && _lastKMeansAssignments[i] !== null) ? _lastKMeansAssignments[i] : '';
      rows.push([p.recId, p.recName, p.frame, p.timeSec, p.x, p.y, cluster]);
    }
    const csv = rows.map(r => r.map(v => String(v).replace(/"/g,'""')).map(v=>`"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pca-projecoes-${Date.now()}.csv`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 5000);
  }

  window._pcaVisualizerCache = window._pcaVisualizerCache || {};

  async function openVisualizer(){
    try {
      if (!window._pcaModel) {
        alert('Modelo PCA não encontrado. Execute o PCA primeiro.');
        return;
      }

      const updatedAt = window._pcaModel.__updatedAt || 0;
      if (window._pcaVisualizerCache._lastModelUpdatedAt !== undefined &&
          window._pcaVisualizerCache._lastModelUpdatedAt !== updatedAt) {
        window._pcaVisualizerCache = {};
      }
      window._pcaVisualizerCache._lastModelUpdatedAt = updatedAt;

      const selection = getSelectionForVisualization();
      const signature = modelSignature(window._pcaModel) + '|' + selection.signature;
      let cached = window._pcaVisualizerCache[signature];

      if (!cached) {
        const { points, perRecCounts } = await computeProjectionsPC12(selection.recs);
        let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
        for (const p of points) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        if (!isFinite(minX) || !isFinite(maxX)) { minX=-1; maxX=1; }
        if (!isFinite(minY) || !isFinite(maxY)) { minY=-1; maxY=1; }

        const palette = colorPalette();
        const recsOrder = selection.recs.map((r,i)=>({ id:r.id, name:r.name || String(r.id), color: palette[i % palette.length] }));

        cached = {
          points,
          perRecCounts,
          bbox: { minX, maxX, minY, maxY },
          recsOrder,
          sourceInfo: selection.label
        };
        window._pcaVisualizerCache[signature] = cached;
      }

      const { modal, canvas, legend } = createVisModal();

      const recsOrder = cached.recsOrder || [];
      const colorForRec = (id) => {
        const idx = recsOrder.findIndex(rr => String(rr.id) === String(id));
        return (idx>=0) ? recsOrder[idx].color : '#888';
      };

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.fillText('Gerando visualização...', 20, 28);

      _lastPoints = cached.points;
      _lastRecsOrder = recsOrder;

      // Preparar clusters (se houver KMeans)
      const kmodel = window._kmeansModel;
      let kinfo = null;
      let assignments = null;
      let clusterColors = [];
      if (kmodel && kmodel.k && kmodel.centroids) {
        const k = kmodel.k;
        const pal = colorPalette();
        for (let ci=0; ci<k; ci++) clusterColors[ci] = pal[ci % pal.length];

        const cDim = kmodel.dim || 2;
        const centroids2 = [];
        for (let ci=0; ci<k; ci++){
          const base = ci * cDim;
          const cx = (cDim >= 1) ? (kmodel.centroids[base + 0] || 0) : 0;
          const cy = (cDim >= 2) ? (kmodel.centroids[base + 1] || 0) : 0;
          centroids2.push({ cx, cy });
        }

        assignments = new Array(cached.points.length);
        for (let i=0;i<cached.points.length;i++){
          const p = cached.points[i];
          let best = 0, bestD = Infinity;
          for (let ci=0; ci<k; ci++){
            const dx = p.x - centroids2[ci].cx;
            const dy = p.y - centroids2[ci].cy;
            const d2 = dx*dx + dy*dy;
            if (d2 < bestD) { bestD = d2; best = ci; }
          }
          assignments[i] = best;
        }

        kinfo = {
          k: kmodel.k,
          inertia: (kmodel.inertia !== undefined ? kmodel.inertia : null),
          sizes: Array.isArray(kmodel.clusterSizes) ? Array.from(kmodel.clusterSizes) : (kmodel.clusterSizes && Array.from(kmodel.clusterSizes) || []),
          colors: clusterColors
        };
      }

      _lastKMeansAssignments = assignments || null;
      const colorForPoint = (p, idx) => {
        if (_lastKMeansAssignments && _lastKMeansAssignments[idx] !== undefined && _lastKMeansAssignments[idx] !== null) {
          const ci = _lastKMeansAssignments[idx];
          return (kinfo && kinfo.colors && kinfo.colors[ci]) ? kinfo.colors[ci] : '#333';
        }
        return colorForRec(p.recId);
      };

      drawScatter(canvas, cached.points, colorForPoint, cached.bbox);
      buildLegend(legend, recsOrder, colorForRec, cached.perRecCounts || new Map(), cached.sourceInfo, kinfo);

    } catch (err) {
      console.error('pca-visualizer: erro ao abrir visualização:', err);
      alert('Falha ao gerar visualização. Veja o console para detalhes.');
    }
  }

  function injectButtonIfNeeded(root){
    try {
      let modal = null;
      if (root && root.id === PCA_MODAL_ID) {
        modal = root;
      } else if (root && typeof root.querySelector === 'function') {
        modal = root.querySelector('#' + PCA_MODAL_ID);
      } else {
        modal = document.getElementById(PCA_MODAL_ID);
      }
      if (!modal) return;
      if (modal.__pca_vis_btn_injected) return;
      const actions = modal.querySelector('.modal-actions') || modal;
      const btn = document.createElement('button');
      btn.id = VIS_BTN_ID;
      btn.className = 'small';
      btn.textContent = 'Visualizar projeções (PC1 × PC2)';
      btn.style.marginRight = 'auto';
      btn.onclick = openVisualizer;
      if (actions.firstChild) actions.insertBefore(btn, actions.firstChild);
      else actions.appendChild(btn);
      modal.__pca_vis_btn_injected = true;
    } catch (e) {}
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.id === PCA_MODAL_ID || (node.querySelector && node.querySelector('#'+PCA_MODAL_ID))) {
          injectButtonIfNeeded(node);
        }
      }
    }
  });
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  try { injectButtonIfNeeded(document); } catch (_) {}

  window.pcaVisualizer = { open: openVisualizer };

})();