// kmeans-auto-bootstrap.js
// Bootstrap mínimo para garantir que o painel "Auto K (KMeans)" apareça e funcione.
// Cole este arquivo no console ou salve como kmeans-auto-bootstrap.js e inclua no index.html.
//
// O script:
// - cria o painel se #train-panel existir;
// - expõe window.kmeansAutoEnsure() para forçar a criação;
// - expõe window.buildProjectedDatasetFromTrainPool(...) (compatível com a UI) para uso no console;
// - chama window.kmeansEvaluator.runRange(...) quando você clicar "Executar" no painel.
//
// Uso rápido:
// 1) Cole inteiro no console e pressione Enter.
// 2) Vá ao Train Pool -> verá "Auto K (KMeans)".
// 3) Ajuste Kmin/Kmax/nInit/Dim e clique Executar.
// 4) Use os botões "Selecionar" que aparecem.
//
// Nota: Este bootstrap não altera seus arquivos originais; é um fallback para teste.

(function(){
  'use strict';
  if (window.__kmeans_auto_bootstrap_installed) {
    console.log('kmeans-auto-bootstrap já instalado.');
    return;
  }
  window.__kmeans_auto_bootstrap_installed = true;

  function getMerged() {
    try {
      return window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function'
        ? window.appConfig.getMergedProcessingOptions()
        : { analyzer:{}, pca:{}, clusterOverlay:{}, kmeans:{ autoK:{} } };
    } catch (e) {
      return { analyzer:{}, pca:{}, clusterOverlay:{}, kmeans:{ autoK:{} } };
    }
  }

  function computeQuantile(arr, q) {
    if (!arr || !arr.length) return 0;
    const a = Array.from(arr).sort((x,y)=>x-y);
    const pos = (a.length - 1) * Math.min(Math.max(q,0),1);
    const base = Math.floor(pos);
    const rest = pos - base;
    if ((base+1) < a.length) return a[base] + rest * (a[base+1] - a[base]);
    return a[base];
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

  function segmentSpeechMaskAndRms_local(fr) {
    // fallback local: se não houver segmentSilence, considera todos frames como fala
    const merged = getMerged();
    const a = merged.analyzer || {};
    const dims = (fr.shape && fr.shape.dims) ? fr.shape.dims : (fr.d || 0);
    const frames = (fr.shape && fr.shape.frames) ? fr.shape.frames : (fr.frames || 0);
    const nMels = fr.meta && fr.meta.nMels ? fr.meta.nMels : Math.max(0, dims - 3);
    const rmsIdx = nMels;
    const flat = fr.features || [];
    const rmsArr = new Float32Array(frames);
    let localMaxRms = 0;
    for (let i=0;i<frames;i++){
      const r = flat[i*dims + rmsIdx] || 0;
      rmsArr[i] = r;
      if (r > localMaxRms) localMaxRms = r;
    }
    localMaxRms = Math.max(localMaxRms, 1e-9);

    const segFn = (window.segmentSilence || (window.analyzerOverlay && window.analyzerOverlay.segmentSilence));
    if (typeof segFn !== 'function') {
      const all = new Uint8Array(frames); all.fill(1); return { mask: all, rmsArr };
    }
    const segs = segFn(rmsArr, localMaxRms, {
      silenceRmsRatio: (merged.pca && merged.pca.silenceRmsRatio) || (a.silenceRmsRatio || 0.06),
      minSilenceFrames: (merged.pca && merged.pca.minSilenceFrames) || (a.minSilenceFrames || 5),
      minSpeechFrames: (merged.pca && merged.pca.minSpeechFrames) || (a.minSpeechFrames || 3)
    }) || [];
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

  // expõe uma versão global do construtor de dataset (para console e bootstrap)
  window.buildProjectedDatasetFromTrainPool = function(maxPoints=5000, kDims=3, minRmsQuantile=0.15) {
    if (!window._pcaModel) throw new Error('PCA ativo ausente. Rode e selecione um treinamento.');
    const pca = window._pcaModel;
    const trainPool = (window.uiAnalyzer && typeof window.uiAnalyzer.getTrainPool === 'function') ? window.uiAnalyzer.getTrainPool() : [];
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
      dims = (fr.shape && fr.shape.dims) ? fr.shape.dims : (fr.d || 0);
      nMels = fr.meta && fr.meta.nMels ? fr.meta.nMels : Math.max(0, dims - 3);
      sampleRate = (fr.meta && fr.meta.sampleRate) ? fr.meta.sampleRate : 16000;

      const { mask, rmsArr } = segmentSpeechMaskAndRms_local(fr);

      let thr = 0;
      if (minRmsQuantile && minRmsQuantile > 0) {
        const speechRms = [];
        for (let i=0;i<rmsArr.length;i++) if (mask[i]) speechRms.push(rmsArr[i]);
        thr = speechRms.length ? computeQuantile(speechRms, minRmsQuantile) : 0;
      }

      const perRecCap = Math.max(50, Math.ceil(maxPoints / Math.max(1, trainPool.length)));
      const idxs = sampleFramesIdx(mask, perRecCap, (i)=> rmsArr[i] >= thr);

      const flat = fr.features || [];
      for (const f of idxs) {
        const base = f * dims;
        const vec = new Float32Array(dims);
        for (let d=0; d<dims; d++) vec[d] = flat[base + d] || 0;
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
  };

  function createPanelBootstrap() {
    const trainPanel = document.getElementById('train-panel');
    if (!trainPanel) {
      console.warn('createPanelBootstrap: #train-panel não encontrado no DOM.');
      return null;
    }
    if (document.getElementById('kmeans-auto-panel')) return document.getElementById('kmeans-auto-panel');

    const panel = document.createElement('div');
    panel.id = 'kmeans-auto-panel';
    panel.style.marginTop = '8px';
    panel.style.borderTop = '1px solid #eee';
    panel.style.paddingTop = '8px';
    panel.style.fontSize = '13px';

    // defaults desde config (se disponível)
    const merged = getMerged();
    const ak = (merged.kmeans && merged.kmeans.autoK) || {};
    const defKmin = Math.max(3, ak.defaultKmin || 3);
    const defKmax = Math.max(defKmin, ak.defaultKmax || 10);
    const defNInit = Math.max(1, ak.defaultNInit || 10);
    const defDim = Math.max(2, ak.defaultDim || 3);

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>Auto K (KMeans)</strong>
        <label>Kmin <input id="ak-kmin" type="number" value="${defKmin}" min="2" style="width:60px"/></label>
        <label>Kmax <input id="ak-kmax" type="number" value="${defKmax}" min="2" style="width:60px"/></label>
        <label>nInit <input id="ak-ninit" type="number" value="${defNInit}" min="1" style="width:60px"/></label>
        <label>Dim (PCA) <input id="ak-kdim" type="number" value="${defDim}" min="2" style="width:60px"/></label>
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

    // bind
    const runBtn = panel.querySelector('#ak-run');
    runBtn.addEventListener('click', async function(){
      const statusEl = panel.querySelector('#ak-status');
      const plotInertia = panel.querySelector('#ak-plot-inertia');
      const plotSil = panel.querySelector('#ak-plot-sil');
      const resDiv = panel.querySelector('#ak-results');
      const recoDiv = panel.querySelector('#ak-reco');

      const Kmin = Math.max(2, parseInt(panel.querySelector('#ak-kmin').value || '3',10));
      const Kmax = Math.max(Kmin, parseInt(panel.querySelector('#ak-kmax').value || '10',10));
      const nInit = Math.max(1, parseInt(panel.querySelector('#ak-ninit').value || '10',10));
      let kDims = Math.max(2, parseInt(panel.querySelector('#ak-kdim').value || '3',10));
      try {
        if (!window._pcaModel) { alert('PCA ativo ausente. Rode/Selecione um treinamento.'); return; }
        const pcaK = window._pcaModel.k || 2;
        if (kDims > pcaK) { kDims = pcaK; panel.querySelector('#ak-kdim').value = String(kDims); }
        statusEl.textContent = 'Coletando e projetando dados...';
        const akCfg = (getMerged().kmeans && getMerged().kmeans.autoK) || {};
        const minRmsQuantile = akCfg.minRmsQuantile || 0.15;
        const ds = window.buildProjectedDatasetFromTrainPool(5000, kDims, minRmsQuantile);
        statusEl.textContent = `Executando KMeans K=${Kmin}..${Kmax} nInit=${nInit} Dim=${kDims}...`;
        const results = await window.kmeansEvaluator.runRange(ds.Xflat, ds.nRows, ds.dim, {
          Kmin, Kmax, nInit, maxIter: 200, tol: 1e-4, silhouetteSample: Math.min(akCfg.silhouetteSample||1500, ds.nRows)
        });
        statusEl.textContent = 'Concluído. Selecione um K abaixo.';
        // render mini plots (simple)
        const xs = results.map(r=>r.K);
        function plot(canvas, ys, color, title) {
          const w=280,h=120,pad=24; canvas.width=w; canvas.height=h;
          const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,w,h); ctx.fillStyle='#fff'; ctx.fillRect(0,0,w,h);
          if(title){ ctx.fillStyle='#333'; ctx.font='12px sans-serif'; ctx.fillText(title,6,14); }
          if(!xs.length) return;
          const xmin = Math.min(...xs), xmax = Math.max(...xs);
          const ymin = Math.min(...ys), ymax = Math.max(...ys);
          const xspan = Math.max(1e-9, xmax-xmin), yspan = Math.max(1e-9, ymax-ymin);
          const x0=pad,x1=w-pad,y0=h-pad,y1=pad;
          ctx.strokeStyle='#999'; ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y0); ctx.moveTo(x0,y0); ctx.lineTo(x0,y1); ctx.stroke();
          ctx.strokeStyle=color; ctx.beginPath();
          for(let i=0;i<xs.length;i++){
            const px = x0 + ((xs[i]-xmin)/xspan)*(x1-x0);
            const py = y0 - ((ys[i]-ymin)/yspan)*(y0-y1);
            if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
          }
          ctx.stroke();
        }
        plot(plotInertia, results.map(r=>r.inertia), '#1f77b4', 'Inertia (SSE) vs K');
        plot(plotSil, results.map(r=>r.silhouette), '#d62728', 'Silhouette médio vs K');

        // recommendations: pick top 3 by silhouette + elbow
        const bySil = results.slice().sort((a,b)=> b.silhouette - a.silhouette);
        const picked=[];
        const used=new Set();
        if(bySil.length){ picked.push(bySil[0]); used.add(bySil[0].K); }
        for(let i=1;i<bySil.length;i++){ const c=bySil[i]; if(!used.has(c.K) && Math.abs(c.K-picked[0].K)>=2){ picked.push(c); used.add(c.K); break; } }
        if(picked.length<2 && bySil.length>1){ picked.push(bySil[1]); used.add(bySil[1].K); }
        // elbow:
        const inertias = results.map(r=>r.inertia);
        let elbowIdx = null, bestVal=-Infinity;
        for (let i=1;i<inertias.length-1;i++){ const d2 = inertias[i-1] - 2*inertias[i] + inertias[i+1]; if(d2>bestVal){ bestVal=d2; elbowIdx=i; } }
        if(elbowIdx!=null){
          const elbowK = results[elbowIdx].K;
          if(!used.has(elbowK)){ picked.push(results[elbowIdx]); used.add(elbowK); }
        }
        for(const r of bySil){ if(picked.length>=3) break; if(!used.has(r.K)){ picked.push(r); used.add(r.K); } }

        // render recommendations
        recoDiv.innerHTML = '<div style="margin:6px 0;"><strong>Recomendações:</strong></div>';
        for(const r of picked){
          const div = document.createElement('div');
          div.style.display='flex'; div.style.alignItems='center'; div.style.gap='8px';
          div.innerHTML = `<span><b>K=${r.K}</b></span><span>Sil:${r.silhouette.toFixed(3)}</span><span>Iner:${r.inertia.toFixed(1)}</span><button class="small sel">Selecionar</button>`;
          const btn = div.querySelector('.sel');
          btn.onclick = ()=> { applySelectedK(r, ds.dim); };
          recoDiv.appendChild(div);
        }

        // table
        resDiv.innerHTML = '';
        const table = document.createElement('table'); table.style.width='100%'; table.style.borderCollapse='collapse';
        const thead = document.createElement('thead');
        thead.innerHTML = `<tr><th style="text-align:left;padding:4px">K</th><th style="text-align:left;padding:4px">Inertia</th><th style="text-align:left;padding:4px">Silhouette</th><th style="text-align:left;padding:4px">Ação</th></tr>`;
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for(const r of results){
          const tr = document.createElement('tr');
          tr.innerHTML = `<td style="padding:4px">${r.K}</td><td style="padding:4px">${r.inertia.toFixed(1)}</td><td style="padding:4px">${r.silhouette.toFixed(3)}</td><td style="padding:4px"><button class="small sel2">Selecionar</button></td>`;
          tr.querySelector('.sel2').onclick = ()=> applySelectedK(r, ds.dim);
          tbody.appendChild(tr);
        }
        table.appendChild(tbody); resDiv.appendChild(table);

      } catch (err) {
        console.error('runAutoK bootstrap erro', err);
        alert('Auto K falhou: ' + (err && err.message ? err.message : err));
      }
    });

    return panel;
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
    // ensure predict
    if (!model.predict) {
      model.predict = function(x) {
        let best=0, bestD=Infinity;
        for (let c=0;c<this.k;c++){
          let s=0;
          const base = c*this.dim;
          for (let i=0;i<this.dim;i++){
            const d = x[i] - (this.centroids[base+i] || 0);
            s += d*d;
          }
          if (s < bestD) { bestD=s; best=c; }
        }
        return best;
      };
    }
    window._kmeansModel = model;
    document.dispatchEvent(new CustomEvent('training-changed', {
      detail: { activeId: (window.modelStore && window.modelStore.getActiveTrainingId && window.modelStore.getActiveTrainingId()) || null,
        meta: { k: model.k, autoK: true, dimUsed: dim } }
    }));
    alert(`KMeans aplicado com K=${model.k} usando Dim PCA=${dim}.`);
  }

  // expor global
  window.kmeansAutoEnsure = function(){ try { return createPanelBootstrap(); } catch(e){ console.error(e); return null; } };
  // tentar criar agora e de novo após 700ms (cobre race)
  try { createPanelBootstrap(); } catch(e){ console.warn('createPanelBootstrap erro', e); }
  setTimeout(()=>{ try { createPanelBootstrap(); } catch(e){} }, 700);

  console.log('kmeans-auto-bootstrap instalado. Use window.kmeansAutoEnsure() se necessário.');
})();