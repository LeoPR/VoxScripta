// kmeans-auto-ui.js
// UI "Auto K" para KMeans: testa K em Kmin..Kmax com nInit (kmeans++), mostra métricas e sugere 3 Ks.
// - Lê defaults do config.js (appConfig.kmeans.autoK): Kmin/Kmax/nInit/Dim/silhouetteSample/minRmsQuantile.
// - Filtra frames de fala de baixa energia via quantil de RMS (somente no Auto K).
// - Recomenda pelo menos 3 opções de K: melhor silhouette, segundo melhor (diversificado) e "cotovelo" (elbow).
// - Selecionar aplica window._kmeansModel e dispara 'training-changed'.
// PATCH: expõe inicializador global e tenta novamente após pequeno atraso para evitar race do DOM.

(function(){
  'use strict';

  const PANEL_ID = 'kmeans-auto-panel';

  function getMerged() {
    try {
      return window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function'
        ? window.appConfig.getMergedProcessingOptions()
        : { analyzer:{}, pca:{}, clusterOverlay:{}, kmeans:{ autoK:{} } };
    } catch { return { analyzer:{}, pca:{}, clusterOverlay:{}, kmeans:{ autoK:{} } }; }
  }

  function normalizeFeatureVector(vec, nMels, sampleRate){
    for (let m = 0; m < nMels; m++) vec[m] = Math.log1p(Number.isFinite(vec[m]) ? vec[m] : 0);
    if (!sampleRate) sampleRate = 16000;
    const centroidIdx = nMels + 1;
    if (centroidIdx < vec.length) { vec[centroidIdx] = Number.isFinite(vec[centroidIdx]) ? (vec[centroidIdx] / (sampleRate/2)) : 0; }
    const zIdx = nMels + 2;
    if (zIdx < vec.length) { if (!Number.isFinite(vec[zIdx])) vec[zIdx] = 0; }
    return vec;
  }

  function computeQuantile(arr, q) {
    if (!arr.length) return 0;
    const a = Float32Array.from(arr).slice().sort((x,y)=>x-y);
    const pos = (a.length - 1) * Math.min(Math.max(q,0),1);
    const base = Math.floor(pos);
    const rest = pos - base;
    if ((base+1) < a.length) return a[base] + rest * (a[base+1] - a[base]);
    return a[base];
  }

  function segmentSpeechMaskAndRms(fr) {
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
      const all = new Uint8Array(frames); all.fill(1); return { mask: all, rmsArr };
    }
    const segs = segFn(rmsArr, localMaxRms, { silenceRmsRatio, minSilenceFrames, minSpeechFrames }) || [];
    const mask = new Uint8Array(frames);
    for (const seg of segs) {
      if (seg.type !== 'speech') continue;
      const s = Math.max(0, seg.startFrame|0);
      const e = Math.min(frames-1, seg.endFrame|0);
      for (let f=s; f<=e; f++) mask[f] = 1;
    }
    return { mask, rmsArr };
  }

  function sampleFramesIdx(mask, targetMax, filterByIdxFn = null) {
    const idxs = [];
    for (let i=0;i<mask.length;i++) {
      if (mask[i] && (!filterByIdxFn || filterByIdxFn(i))) idxs.push(i);
    }
    if (!targetMax || idxs.length <= targetMax) return idxs;
    const step = Math.ceil(idxs.length / targetMax);
    const out = [];
    for (let i=0; i<idxs.length; i+=step) out.push(idxs[i]);
    return out;
  }

  function buildProjectedDatasetFromTrainPool(maxPoints=5000, kDims=3, minRmsQuantile=0.15) {
    if (!window._pcaModel) throw new Error('PCA ativo ausente. Rode e selecione um treinamento.');
    const pca = window._pcaModel;

    const trainPool = (window.uiAnalyzer && typeof window.uiAnalyzer.getTrainPool === 'function')
      ? window.uiAnalyzer.getTrainPool()
      : [];
    if (!trainPool || !trainPool.length) throw new Error('Train Pool vazio. Adicione gravações ao Train Pool.');

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

      const { mask, rmsArr } = segmentSpeechMaskAndRms(fr);

      let thr = 0;
      if (minRmsQuantile && minRmsQuantile > 0) {
        const speechRms = [];
        for (let i=0;i<rmsArr.length;i++) if (mask[i]) speechRms.push(rmsArr[i]);
        thr = speechRms.length ? computeQuantile(speechRms, minRmsQuantile) : 0;
      }

      const perRecCap = Math.max(100, Math.ceil(maxPoints / Math.max(1, trainPool.length)));
      const idxs = sampleFramesIdx(mask, perRecCap, (i)=> rmsArr[i] >= thr);

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

    if (!points.length) throw new Error('Nenhum frame de fala com energia suficiente no Train Pool. Ajuste minRmsQuantile ou execute Analyze.');

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

    const x0 = pad, x1 = w - pad, y0 = h - pad, y1 = pad;
    ctx.strokeStyle = '#999';
    ctx.beginPath();
    ctx.moveTo(x0,y0); ctx.lineTo(x1,y0);
    ctx.moveTo(x0,y0); ctx.lineTo(x0,y1);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i=0;i<xs.length;i++){
      const px = x0 + ( (xs[i]-xmin)/xspan ) * (x1-x0);
      const py = y0 - ( (ys[i]-ymin)/yspan ) * (y0-y1);
      if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.stroke();

    ctx.fillStyle = color;
    for (let i=0;i<xs.length;i++){
      const px = x0 + ( (xs[i]-xmin)/xspan ) * (x1-x0);
      const py = y0 - ( (ys[i]-ymin)/yspan ) * (y0-y1);
      ctx.beginPath();
      ctx.arc(px,py,2.5,0,Math.PI*2);
      ctx.fill();
    }
  }

  // "Cotovelo" (elbow) por distância à reta Kmin-Kmax
  function findElbowK(results) {
    if (!results || results.length < 3) return null;
    const xs = results.map(r=>r.K);
    const ys = results.map(r=>r.inertia);
    const x0 = xs[0], y0 = ys[0];
    const xN = xs[xs.length-1], yN = ys[ys.length-1];

    function pointLineDistance(x, y, x1, y1, x2, y2) {
      const A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
      const dot = A * C + B * D;
      const len_sq = C * C + D * D || 1e-12;
      const param = dot / len_sq;
      const xx = x1 + param * C;
      const yy = y1 + param * D;
      const dx = x - xx, dy = y - yy;
      return Math.sqrt(dx*dx + dy*dy);
    }

    let bestK = null, bestDist = -Infinity;
    for (let i=1; i<xs.length-1; i++) {
      const d = pointLineDistance(xs[i], ys[i], x0, y0, xN, yN);
      if (d > bestDist) { bestDist = d; bestK = xs[i]; }
    }
    return bestK;
  }

  function pickRecommendations(results) {
    if (!results || !results.length) return [];
    const bySil = results.slice().sort((a,b)=> b.silhouette - a.silhouette);
    const picked = [];
    const usedK = new Set();

    if (bySil.length) { picked.push(bySil[0]); usedK.add(bySil[0].K); }

    for (let i=1;i<bySil.length;i++) {
      const cand = bySil[i];
      if (!usedK.has(cand.K) && Math.abs(cand.K - picked[0].K) >= 2) {
        picked.push(cand); usedK.add(cand.K);
        break;
      }
    }
    if (picked.length < 2 && bySil.length > 1) {
      picked.push(bySil[1]); usedK.add(bySil[1].K);
    }

    const elbowK = findElbowK(results);
    if (elbowK != null && !usedK.has(elbowK)) {
      const elbowRes = results.find(r=>r.K === elbowK);
      if (elbowRes) { picked.push(elbowRes); usedK.add(elbowK); }
    }

    for (const r of bySil) {
      if (picked.length >= 3) break;
      if (!usedK.has(r.K)) { picked.push(r); usedK.add(r.K); }
    }
    return picked.slice(0,3);
  }

  function createPanel(defaults) {
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

    const defKmin = Math.max(3, defaults.defaultKmin || 3);
    const defKmax = Math.max(defKmin, defaults.defaultKmax || 10);
    const defNInit = Math.max(1, defaults.defaultNInit || 10);
    const defDim = Math.max(2, defaults.defaultDim || 3);

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>Auto K (KMeans)</strong>
        <label>Kmin <input id="ak-kmin" type="number" value="${defKmin}" min="2" style="width:60px"/></label>
        <label>Kmax <input id="ak-kmax" type="number" value="${defKmax}" min="2" style="width:60px"/></label>
        <label>nInit <input id="ak-ninit" type="number" value="${defNInit}" min="1" style="width:60px"/></label>
        <label>Dim (PCA) <input id="ak-kdim" type="number" value="${defDim}" min="2" style="width:60px" title="Nº de componentes do PCA usadas no KMeans"/></label>
        <button id="ak-run" class="small">Executar</button>
        <span id="ak-status" style="color:#666"></span>
      </div>
      <div id="ak-reco" style="margin-top:10px;"></div>
      <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;">
        <canvas id="ak-plot-inertia"></canvas>
        <canvas id="ak-plot-sil"></canvas>
      </div>
      <div id="ak-results" style="margin-top:8px;"></div>
    `;
    trainPanel.appendChild(panel);
    return panel;
  }

  async function runAutoK() {
    const merged = getMerged();
    const akCfg = (merged.kmeans && merged.kmeans.autoK) || {};
    const silhouetteSample = akCfg.silhouetteSample || 1500;
    const minRmsQuantile = akCfg.minRmsQuantile || 0.15;

    const panel = document.getElementById(PANEL_ID) || createPanel(akCfg);
    const kminEl = panel.querySelector('#ak-kmin');
    const kmaxEl = panel.querySelector('#ak-kmax');
    const ninitEl = panel.querySelector('#ak-ninit');
    const kdimEl = panel.querySelector('#ak-kdim');
    const statusEl = panel.querySelector('#ak-status');
    const plotInertia = panel.querySelector('#ak-plot-inertia');
    const plotSil = panel.querySelector('#ak-plot-sil');
    const resDiv = panel.querySelector('#ak-results');
    const recoDiv = panel.querySelector('#ak-reco');

    let Kmin = Math.max(3, parseInt(kminEl.value || String(akCfg.defaultKmin || 3),10));
    let Kmax = Math.max(Kmin, parseInt(kmaxEl.value || String(akCfg.defaultKmax || 10),10));
    const nInit = Math.max(1, parseInt(ninitEl.value || String(akCfg.defaultNInit || 10),10));

    if (!window._pcaModel) { alert('PCA ativo ausente. Rode/Selecione um treinamento.'); return; }
    const pcaK = window._pcaModel.k || 2;
    let kDims = Math.max(2, parseInt(kdimEl.value || String(akCfg.defaultDim || 3),10));
    if (kDims > pcaK) { kDims = pcaK; kdimEl.value = String(kDims); }

    let dataset;
    try {
      statusEl.textContent = `Coletando e projetando dados (Dim PCA=${kDims}, filtro RMS q=${minRmsQuantile})...`;
      dataset = buildProjectedDatasetFromTrainPool(5000, kDims, minRmsQuantile);
    } catch (e) {
      console.error(e);
      alert('Falha ao coletar/projetar dados: ' + (e && e.message ? e.message : e));
      statusEl.textContent = '';
      return;
    }

    try {
      statusEl.textContent = `Executando KMeans para K=${Kmin}..${Kmax} (nInit=${nInit}, Dim=${kDims})...`;
      const results = await window.kmeansEvaluator.runRange(dataset.Xflat, dataset.nRows, dataset.dim, {
        Kmin, Kmax, nInit, maxIter: 200, tol: 1e-4, silhouetteSample: Math.min(silhouetteSample, dataset.nRows)
      });
      statusEl.textContent = 'Concluído. Selecione um K abaixo.';

      const recos = pickRecommendations(results);
      const recoDivEl = panel.querySelector('#ak-reco');
      if (recos.length) {
        const items = recos.map(r => `
          <div style="display:flex;align-items:center;gap:8px;">
            <span><b>K=${r.K}</b></span>
            <span>Sil: ${r.silhouette.toFixed(3)}</span>
            <span>Inertia: ${r.inertia.toFixed(1)}</span>
            <span>CH: ${r.ch.toFixed(2)}</span>
            <span>DB: ${isFinite(r.db)?r.db.toFixed(3):'∞'}</span>
            <button class="small ak-select-reco" data-k="${r.K}">Selecionar</button>
          </div>
        `).join('');
        recoDivEl.innerHTML = `<div style="margin:6px 0;"><strong>Recomendações:</strong></div>${items}`;
        const btns = recoDivEl.querySelectorAll('.ak-select-reco');
        btns.forEach(btn => {
          btn.addEventListener('click', () => {
            const k = parseInt(btn.getAttribute('data-k'),10);
            const sel = results.find(x=>x.K===k);
            if (sel) applySelectedK(sel, dataset.dim);
          });
        });
      } else {
        recoDivEl.innerHTML = '';
      }

      const xs = results.map(r=>r.K);
      drawMiniPlot(plotInertia, xs, results.map(r=>r.inertia), '#1f77b4', 'Inertia (SSE) vs K');
      drawMiniPlot(plotSil, xs, results.map(r=>r.silhouette), '#d62728', 'Silhouette médio vs K');

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

    document.dispatchEvent(new CustomEvent('training-changed', {
      detail: { activeId: (window.modelStore && window.modelStore.getActiveTrainingId && window.modelStore.getActiveTrainingId()) || null,
        meta: { k: model.k, autoK: true, dimUsed: dim } }
    }));
    alert(`KMeans aplicado com K=${model.k} usando Dim PCA=${dim}. Abra o overlay ou visualizador para ver os clusters.`);
  }

  function ensurePanelAndBind() {
    const merged = getMerged();
    const akCfg = (merged.kmeans && merged.kmeans.autoK) || {};
    const panel = createPanel(akCfg);
    if (!panel) return;
    const runBtn = panel.querySelector('#ak-run');
    if (runBtn && !runBtn.__bound) {
      runBtn.__bound = true;
      runBtn.addEventListener('click', runAutoK);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensurePanelAndBind);
  } else {
    ensurePanelAndBind();
  }

  // PATCH: expõe inicializador global e tenta novamente após 700ms
  window.kmeansAutoEnsure = ensurePanelAndBind;
  setTimeout(ensurePanelAndBind, 700);

})();