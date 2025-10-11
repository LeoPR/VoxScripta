// kmeans-auto-ui.js
// UI mínima "Auto K" para KMeans: testa K de Kmin..Kmax com nInit, mostra métricas e permite selecionar K.
// - Depende de: window._pcaModel (ativo) e dados para clusterizar (projetados pelo PCA).
// - Coleta dataset projetado do Train Pool (frames de fala) se rec.__featuresCache existir.
// - Desenha gráficos simples (inertia e silhouette) e lista de resultados com botão "Selecionar".
// - Ao selecionar, cria window._kmeansModel compatível com overlay/visualizador e dispara 'training-changed'.

(function(){
  'use strict';

  const PANEL_ID = 'kmeans-auto-panel';

  function getMerged() {
    try {
      return window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function'
        ? window.appConfig.getMergedProcessingOptions()
        : { analyzer:{}, pca:{}, clusterOverlay:{} };
    } catch { return { analyzer:{}, pca:{}, clusterOverlay:{} }; }
  }

  function normalizeFeatureVector(vec, nMels, sampleRate){
    for (let m = 0; m < nMels; m++) vec[m] = Math.log1p(Number.isFinite(vec[m]) ? vec[m] : 0);
    if (!sampleRate) sampleRate = 16000;
    const centroidIdx = nMels + 1;
    if (centroidIdx < vec.length) vec[centroidIdx] = Number.isFinite(vec[centroidIdx]) ? (vec[centroidIdx] / (sampleRate/2)) : 0;
    const zIdx = nMels + 2;
    if (zIdx < vec.length) { if (!Number.isFinite(vec[zIdx])) vec[zIdx] = 0; }
    return vec;
  }

  function segmentSpeechMask(fr) {
    const merged = getMerged();
    const a = merged.analyzer || {};
    const p = merged.pca || {};
    const dims = fr.shape ? fr.shape.dims : 0;
    const frames = fr.shape ? fr.shape.frames : 0;
    const nMels = fr.meta && fr.meta.nMels ? fr.meta.nMels : Math.max(0, dims - 3);
    const rmsIdx = nMels;
    const flat = fr.features;
    const rmsArr = new Float32Array(frames);
    let localMaxRms = 0;
    for (let i=0;i<frames;i++){
      const r = flat[i*dims + rmsIdx] || 0;
      rmsArr[i] = r;
      if (r > localMaxRms) localMaxRms = r;
    }
    localMaxRms = Math.max(localMaxRms, 1e-9);

    const silenceRmsRatio = p.silenceRmsRatio || a.silenceRmsRatio || 0.06;
    const minSilenceFrames = p.minSilenceFrames || a.minSilenceFrames || 5;
    const minSpeechFrames = p.minSpeechFrames || a.minSpeechFrames || 3;

    const segFn = (window.segmentSilence || (window.analyzerOverlay && window.analyzerOverlay.segmentSilence));
    if (typeof segFn !== 'function') {
      const all = new Uint8Array(frames); all.fill(1); return all;
    }
    const segs = segFn(rmsArr, localMaxRms, { silenceRmsRatio, minSilenceFrames, minSpeechFrames }) || [];
    const mask = new Uint8Array(frames);
    for (const seg of segs) {
      if (seg.type !== 'speech') continue;
      const s = Math.max(0, seg.startFrame|0);
      const e = Math.min(frames-1, seg.endFrame|0);
      for (let f=s; f<=e; f++) mask[f] = 1;
    }
    return mask;
  }

  function sampleFramesIdx(mask, targetMax) {
    const idxs = [];
    for (let i=0;i<mask.length;i++) if (mask[i]) idxs.push(i);
    if (!targetMax || idxs.length <= targetMax) return idxs;
    // downsample uniforme
    const step = Math.ceil(idxs.length / targetMax);
    const out = [];
    for (let i=0; i<idxs.length; i+=step) out.push(idxs[i]);
    return out;
  }

  function buildProjectedDatasetFromTrainPool(maxPoints=5000, kDims=2) {
    if (!window._pcaModel) throw new Error('PCA ativo ausente. Rode e selecione um treinamento.');
    const pca = window._pcaModel;

    // obter train pool
    const trainPool = (window.uiAnalyzer && typeof window.uiAnalyzer.getTrainPool === 'function')
      ? window.uiAnalyzer.getTrainPool()
      : [];
    if (!trainPool || !trainPool.length) throw new Error('Train Pool vazio. Adicione gravações ao Train Pool.');

    // map rec ids -> rec objects
    const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
    const byId = new Map();
    for (const r of recs) if (r && r.id != null) byId.set(r.id, r);

    const points = [];
    let dims = null, nMels = null, sampleRate = 16000;

    for (const id of trainPool) {
      const rec = typeof id === 'object' ? id : byId.get(id);
      if (!rec || !rec.__featuresCache) continue;
      const fr = rec.__featuresCache;
      dims = fr.shape.dims;
      nMels = fr.meta && fr.meta.nMels ? fr.meta.nMels : Math.max(0, dims - 3);
      sampleRate = (fr.meta && fr.meta.sampleRate) ? fr.meta.sampleRate : 16000;

      const mask = segmentSpeechMask(fr);
      const idxs = sampleFramesIdx(mask, Math.ceil(maxPoints / trainPool.length));

      const flat = fr.features;
      for (const f of idxs) {
        const base = f * dims;
        const vec = new Float32Array(dims);
        for (let d=0; d<dims; d++) vec[d] = flat[base + d];
        normalizeFeatureVector(vec, nMels, sampleRate);
        const proj = pca.project(vec);
        const x = new Float32Array(kDims);
        for (let d=0; d<kDims; d++) x[d] = proj[d] || 0;
        points.push(x);
      }
    }

    if (!points.length) throw new Error('Nenhum frame de fala com features no Train Pool. Execute Analyze nas gravações.');

    const n = points.length;
    const Xflat = new Float32Array(n * kDims);
    for (let i=0;i<n;i++){
      const off = i*kDims;
      const p = points[i];
      for (let d=0; d<kDims; d++) Xflat[off+d] = p[d];
    }
    return { Xflat, nRows: n, dim: kDims };
  }

  function ensureKModelShape(model) {
    if (!model) return model;
    if (!model.predict) {
      // adiciona método predict para compatibilidade com overlay
      model.predict = function(x) {
        let best=0, bestD=Infinity;
        for (let c=0;c<this.k;c++){
          let s=0;
          const base = c*this.dim;
          for (let i=0;i<this.dim;i++){
            const d = x[i] - this.centroids[base+i];
            s += d*d;
          }
          if (s < bestD) { bestD=s; best=c; }
        }
        return best;
      };
    }
    return model;
  }

  function drawMiniPlot(canvas, xs, ys, color='#333', title='') {
    const w = 280, h = 120, pad = 24;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = '#ccc'; ctx.strokeRect(0,0,w,h);
    if (title) { ctx.fillStyle='#333'; ctx.font='12px sans-serif'; ctx.fillText(title, 6, 14); }

    if (!xs.length) return;
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const xspan = Math.max(1e-9, xmax - xmin);
    const yspan = Math.max(1e-9, ymax - ymin);

    // eixos
    const x0 = pad, x1 = w - pad, y0 = h - pad, y1 = pad;
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    ctx.moveTo(x0,y0); ctx.lineTo(x1,y0); // eixo x
    ctx.moveTo(x0,y0); ctx.lineTo(x0,y1); // eixo y
    ctx.stroke();

    // série
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i=0;i<xs.length;i++){
      const px = x0 + ( (xs[i]-xmin)/xspan ) * (x1-x0);
      const py = y0 - ( (ys[i]-ymin)/yspan ) * (y0-y1);
      if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.stroke();

    // pontos
    ctx.fillStyle = color;
    for (let i=0;i<xs.length;i++){
      const px = x0 + ( (xs[i]-xmin)/xspan ) * (x1-x0);
      const py = y0 - ( (ys[i]-ymin)/yspan ) * (y0-y1);
      ctx.beginPath();
      ctx.arc(px,py,2.5,0,Math.PI*2);
      ctx.fill();
    }
  }

  function createPanel() {
    const trainPanel = document.getElementById('train-panel');
    if (!trainPanel) return null;
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.marginTop = '8px';
    panel.style.borderTop = '1px solid #eee';
    panel.style.paddingTop = '8px';
    panel.style.fontSize = '13px';

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>Auto K (KMeans)</strong>
        <label>Kmin <input id="ak-kmin" type="number" value="2" min="2" style="width:60px"/></label>
        <label>Kmax <input id="ak-kmax" type="number" value="8" min="2" style="width:60px"/></label>
        <label>nInit <input id="ak-ninit" type="number" value="5" min="1" style="width:60px"/></label>
        <button id="ak-run" class="small">Executar</button>
        <span id="ak-status" style="color:#666"></span>
      </div>
      <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;">
        <canvas id="ak-plot-inertia"></canvas>
        <canvas id="ak-plot-sil"></canvas>
      </div>
      <div id="ak-results" style="margin-top:8px;"></div>
    `;
    // inserir no final do trainPanel
    trainPanel.appendChild(panel);
    return panel;
  }

  async function runAutoK() {
    const panel = createPanel();
    const kminEl = panel.querySelector('#ak-kmin');
    const kmaxEl = panel.querySelector('#ak-kmax');
    const ninitEl = panel.querySelector('#ak-ninit');
    const statusEl = panel.querySelector('#ak-status');
    const plotInertia = panel.querySelector('#ak-plot-inertia');
    const plotSil = panel.querySelector('#ak-plot-sil');
    const resDiv = panel.querySelector('#ak-results');

    const Kmin = Math.max(2, parseInt(kminEl.value || '2',10));
    const Kmax = Math.max(Kmin, parseInt(kmaxEl.value || '8',10));
    const nInit = Math.max(1, parseInt(ninitEl.value || '5',10));

    if (!window._pcaModel) { alert('PCA ativo ausente. Rode/Selecione um treinamento.'); return; }

    let dataset;
    try {
      statusEl.textContent = 'Coletando e projetando dados...';
      dataset = buildProjectedDatasetFromTrainPool(5000, Math.min(window._pcaModel.k || 2, 2));
    } catch (e) {
      console.error(e);
      alert('Falha ao coletar/projetar dados: ' + (e && e.message ? e.message : e));
      statusEl.textContent = '';
      return;
    }

    try {
      statusEl.textContent = `Executando KMeans para K=${Kmin}..${Kmax} (nInit=${nInit})...`;
      const results = await window.kmeansEvaluator.runRange(dataset.Xflat, dataset.nRows, dataset.dim, {
        Kmin, Kmax, nInit, maxIter: 200, tol: 1e-4, silhouetteSample: Math.min(1500, dataset.nRows)
      });
      statusEl.textContent = 'Concluído. Selecione um K abaixo.';

      // plots
      const xs = results.map(r=>r.K);
      drawMiniPlot(plotInertia, xs, results.map(r=>r.inertia), '#1f77b4', 'Inertia (SSE) vs K');
      drawMiniPlot(plotSil, xs, results.map(r=>r.silhouette), '#d62728', 'Silhouette médio vs K');

      // lista
      resDiv.innerHTML = '';
      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';
      const thead = document.createElement('thead');
      thead.innerHTML = `<tr>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">K</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">Inertia</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">Silhouette</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">CH</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">DB</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:4px">Ação</th>
      </tr>`;
      table.appendChild(thead);
      const tbody = document.createElement('tbody');

      for (const r of results) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="padding:4px;border-bottom:1px solid #f0f0f0"><b>${r.K}</b></td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${r.inertia.toFixed(1)}</td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${r.silhouette.toFixed(3)}</td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${r.ch.toFixed(2)}</td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0">${isFinite(r.db)?r.db.toFixed(3):'∞'}</td>
          <td style="padding:4px;border-bottom:1px solid #f0f0f0"><button class="small ak-select">Selecionar</button></td>
        `;
        tr.querySelector('.ak-select').onclick = () => applySelectedK(r, dataset.dim);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      resDiv.appendChild(table);

    } catch (e) {
      console.error(e);
      alert('Falha ao executar Auto K: ' + (e && e.message ? e.message : e));
      statusEl.textContent = '';
    }
  }

  function applySelectedK(result, dim) {
    // cria modelo KMeans compatível com fluxo (overlay, visualizador)
    const model = {
      k: result.K,
      dim,
      centroids: result.centroids,
      clusterSizes: result.sizes,
      inertia: result.inertia,
      optionsUsed: { source: 'autoK', metrics: { silhouette: result.silhouette, ch: result.ch, db: result.db } },
      warnings: []
    };
    ensureKModelShape(model);
    window._kmeansModel = model;

    // notificar UI
    document.dispatchEvent(new CustomEvent('training-changed', {
      detail: { activeId: (window.modelStore && window.modelStore.getActiveTrainingId && window.modelStore.getActiveTrainingId()) || null,
        meta: { k: model.k, autoK: true } }
    }));
    alert(`KMeans aplicado com K=${model.k}. Abra o overlay ou visualizador para ver os clusters.`);
  }

  function ensurePanelAndBind() {
    const panel = createPanel();
    if (!panel) return;
    const runBtn = panel.querySelector('#ak-run');
    if (runBtn && !runBtn.__bound) {
      runBtn.__bound = true;
      runBtn.addEventListener('click', runAutoK);
    }
  }

  // Inicializa quando DOM pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensurePanelAndBind);
  } else {
    ensurePanelAndBind();
  }

})();