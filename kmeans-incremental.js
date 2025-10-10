// kmeans-incremental.js
// Mini-batch/online K-Means sobre as projeções do PCA atual (window._pcaModel).
// - Usa pca-data-prep.prepareDataForPCA(trainIds, ...) para obter apenas fala já filtrada.
// - Projeta a matriz preparada no espaço do PCA (model.transformMatrix).
// - Treina KMeans incremental em pcaDims dimensões (primeiras componentes do PCA).
// - Saída em window._kmeansModel, com predict/assignMatrix e resumo por gravação.
//
// Uso básico no console (após rodar PCA):
//   await window.kmeans.runIncrementalKMeansOnTrainPool({ k: 3, pcaDims: 2, batchSize: 256, epochs: 5 });
//   window._kmeansModel // veja o modelo e estatísticas
//
// Opções (todas opcionais; têm defaults sensatos):
// - k: número de clusters (default 3)
// - pcaDims: quantas dimensões do PCA usar (default 2; limitado por model.k)
// - batchSize: tamanho do mini-batch (default 256)
// - epochs: quantas passadas sobre os dados (default 3)
// - seed: semente determinística (default null -> aleatório)
// - reassessInertiaEvery: frequência (em iterações) para recomputar inércia aproximada (default 0 = só no final)
// - normalizeZ: normalizar Z por variância de cada dimensão (default false)
// - maxPointsForPreview: quantos pontos amostrar para assignmentsPreview (default 2000)
// - progressCb: função opcional(progress) chamada com valor entre 0 e 1
//
// Observações:
// - Exige que window._pcaModel exista (rode o PCA antes).
// - Usa pca-data-prep; segmentação de fala e filtros já foram validados no seu pipeline.
// - Sem UI própria; kmeans-ui.js insere um botão no modal do PCA para rodar e mostrar resumo.

(function(){
  'use strict';

  function getMergedCfg() {
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        return window.appConfig.getMergedProcessingOptions();
      }
    } catch (_) {}
    return { kmeans: {}, pca: {}, analyzer: {} };
  }

  // RNG determinístico (mulberry32)
  function mulberry32(seed) {
    return function() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Distância euclidiana^2 entre vetores (flat subarray base)
  function dist2_flat(flat, baseA, baseB, dim) {
    let s = 0;
    for (let i=0;i<dim;i++){
      const d = (flat[baseA+i] || 0) - (flat[baseB+i] || 0);
      s += d*d;
    }
    return s;
  }
  function dist2_vec_point(centroids, cBase, x, dim) {
    let s = 0;
    for (let i=0;i<dim;i++){
      const d = (x[i] || 0) - centroids[cBase + i];
      s += d*d;
    }
    return s;
  }

  // KMeans++ inicialização em matriz plana (Zflat: n x dim)
  function kmeansPlusPlusInit(Zflat, n, dim, k, seed) {
    const rng = Number.isFinite(seed) ? mulberry32(seed >>> 0) : Math.random;
    const centroids = new Float32Array(k * dim);
    const chosen = new Array(k).fill(-1);

    // escolher primeiro centro aleatório
    chosen[0] = Math.floor(rng() * n);
    for (let d=0; d<dim; d++) centroids[d] = Zflat[chosen[0]*dim + d];

    // dist^2 de cada ponto ao centro mais próximo atual
    const dists = new Float64Array(n);
    for (let i=0;i<n;i++){
      dists[i] = dist2_flat(Zflat, i*dim, 0, dim);
    }

    for (let c=1;c<k;c++){
      // prob proporcional a dists
      let sum = 0;
      for (let i=0;i<n;i++) sum += dists[i];
      const r = rng() * (sum || 1);
      let acc = 0, pick = n-1;
      for (let i=0;i<n;i++){ acc += dists[i]; if (acc >= r) { pick = i; break; } }
      chosen[c] = pick;
      const baseC = c*dim;
      for (let d=0; d<dim; d++) centroids[baseC + d] = Zflat[pick*dim + d];
      // atualizar dists com novo centro
      for (let i=0;i<n;i++){
        const d2 = dist2_flat(Zflat, i*dim, baseC, dim);
        if (d2 < dists[i]) dists[i] = d2;
      }
    }
    return centroids;
  }

  function computeInertia(Zflat, n, dim, centroids, k) {
    let inertia = 0;
    for (let i=0;i<n;i++){
      let best = Infinity;
      for (let c=0;c<k;c++){
        const d2 = dist2_flat(Zflat, i*dim, c*dim, dim);
        if (d2 < best) best = d2;
      }
      inertia += best;
    }
    return inertia;
  }

  function normalizePerDimInplace(Zflat, n, dim) {
    const mean = new Float64Array(dim);
    const m2 = new Float64Array(dim);
    let count = 0;
    for (let i=0;i<n;i++){
      count++;
      const base = i*dim;
      for (let d=0; d<dim; d++){
        const v = Zflat[base + d] || 0;
        const delta = v - mean[d];
        mean[d] += delta / count;
        m2[d] += delta * (v - mean[d]);
      }
    }
    const std = new Float64Array(dim);
    for (let d=0; d<dim; d++){
      std[d] = Math.sqrt(Math.max((count>1 ? m2[d]/(count-1) : 0), 1e-12));
    }
    for (let i=0;i<n;i++){
      const base = i*dim;
      for (let d=0; d<dim; d++){
        Zflat[base + d] = (Zflat[base + d] - mean[d]) / std[d];
      }
    }
  }

  async function prepareProjectedTrainData(pcaDims) {
    if (!window._pcaModel) throw new Error('Modelo PCA inexistente. Execute o PCA antes do K-Means.');
    if (!window.pcaDataPrep || typeof window.pcaDataPrep.prepareDataForPCA !== 'function') {
      throw new Error('pca-data-prep.js não carregado.');
    }
    const trainIds = (window.uiAnalyzer && window.uiAnalyzer.getTrainPool) ? window.uiAnalyzer.getTrainPool() : [];
    if (!trainIds.length) throw new Error('Train Pool vazio.');

    // pedir os dados processados pelo pca-data-prep
    const prep = await window.pcaDataPrep.prepareDataForPCA(trainIds, {
      useSegmentSpeech: true,
      keepSilenceFraction: 0.0,
      applyZScore: false,
      contextWindow: 0
    });

    const model = window._pcaModel;
    // projetar a matriz preparada (dataMatrix) no PCA
    const Zfull = model.transformMatrix(prep.dataMatrix); // flattened n x model.k
    const n = prep.n;
    const modelK = model.k || 2;
    const dim = Math.min(Math.max(1, pcaDims || 2), modelK);

    const Zflat = new Float32Array(n * dim);
    for (let i=0;i<n;i++){
      for (let d=0; d<dim; d++){
        Zflat[i*dim + d] = Zfull[i*modelK + d] || 0;
      }
    }
    return { Zflat, n, dim, framesIndexMap: prep.framesIndexMap || [], trainIds, prep };
  }

  async function runIncrementalKMeansOnTrainPool(options = {}, progressCb) {
    const merged = getMergedCfg().kmeans || {};
    const cfg = Object.assign({
      k: 3,
      pcaDims: 2,
      batchSize: 256,
      epochs: 3,
      seed: null,
      reassessInertiaEvery: 0,
      normalizeZ: false,
      maxPointsForPreview: 2000
    }, merged, options || {});
    const warnings = [];

    const { Zflat, n, dim, framesIndexMap, trainIds, prep } = await prepareProjectedTrainData(cfg.pcaDims);
    if (n < cfg.k) {
      throw new Error(`Pontos insuficientes (${n}) para ${cfg.k} clusters.`);
    }
    if (cfg.normalizeZ) {
      normalizePerDimInplace(Zflat, n, dim);
    }

    // Inicialização KMeans++ determinística opcional
    const centroids = kmeansPlusPlusInit(Zflat, n, dim, cfg.k, cfg.seed);
    const counts = new Int32Array(cfg.k); // contagem de updates por centro

    const totalBatches = Math.ceil(n / Math.max(1, cfg.batchSize));
    const totalIters = totalBatches * Math.max(1, cfg.epochs);
    let iter = 0;

    for (let epoch = 0; epoch < Math.max(1,cfg.epochs); epoch++) {
      // iteração simples por sequência (evita embaralhar para reprodutibilidade); se quiser randomizar, usar rng
      for (let start = 0; start < n; start += cfg.batchSize) {
        const bsz = Math.min(cfg.batchSize, n - start);

        for (let bi = 0; bi < bsz; bi++) {
          const idx = start + bi;
          const base = idx * dim;
          // encontra centro mais próximo
          let bestC = 0, bestD = Infinity;
          for (let c=0;c<cfg.k;c++){
            const d2 = dist2_flat(Zflat, base, c*dim, dim);
            if (d2 < bestD) { bestD = d2; bestC = c; }
          }
          // update incremental (eta = 1 / (counts+1))
          counts[bestC] += 1;
          const eta = 1 / counts[bestC];
          const cBase = bestC * dim;
          for (let d=0; d<dim; d++){
            const prev = centroids[cBase + d];
            const xi = Zflat[base + d];
            centroids[cBase + d] = prev + eta * (xi - prev);
          }
        }

        iter++;
        if (progressCb && typeof progressCb === 'function') {
          progressCb(Math.min(1, iter / totalIters));
        }
      }
    }

    // Inércia final (custo)
    const inertia = computeInertia(Zflat, n, dim, centroids, cfg.k);

    // Assign final (para estatísticas)
    const labels = new Int32Array(n);
    const clusterSizes = new Int32Array(cfg.k);
    for (let r=0;r<n;r++){
      let bestC = 0, bestD = Infinity;
      for (let c=0;c<cfg.k;c++){
        const d2 = dist2_flat(Zflat, r*dim, c*dim, dim);
        if (d2 < bestD) { bestD = d2; bestC = c; }
      }
      labels[r] = bestC;
      clusterSizes[bestC] += 1;
    }

    // Distribuição por gravação (id)
    const perRecordingClusterCounts = {}; // id -> array k
    for (let r=0;r<n;r++){
      const meta = framesIndexMap[r] || {};
      const recId = String(meta.recId !== undefined ? meta.recId : 'unknown');
      if (!perRecordingClusterCounts[recId]) perRecordingClusterCounts[recId] = new Int32Array(cfg.k);
      perRecordingClusterCounts[recId][labels[r]] += 1;
    }

    // Amostra para preview (evitar armazenar tudo)
    const maxPrev = Math.max(0, cfg.maxPointsForPreview|0);
    const step = maxPrev > 0 ? Math.max(1, Math.floor(n / Math.min(n, maxPrev))) : 0;
    const assignmentsPreview = [];
    if (step > 0) {
      for (let r=0;r<n;r+=step){
        const meta = framesIndexMap[r] || {};
        assignmentsPreview.push({
          recId: meta.recId,
          frameIndex: meta.frameIndex,
          timeSec: meta.timeSec,
          cluster: labels[r]
        });
      }
    }

    const model = {
      k: cfg.k,
      dim,
      pcaDimsUsed: dim,
      centroids,
      counts,
      clusterSizes,
      inertia,
      labelsSampledCount: assignmentsPreview.length,
      assignmentsPreview,
      perRecordingClusterCounts,
      trainPoolIds: Array.isArray(trainIds) ? trainIds.slice() : [],
      optionsUsed: cfg,
      warnings,
      __updatedAt: Date.now(),
      predict(x) {
        let bestC = 0, bestD = Infinity;
        for (let c=0;c<this.k;c++){
          const d2 = dist2_vec_point(this.centroids, c*this.dim, x, this.dim);
          if (d2 < bestD) { bestD = d2; bestC = c; }
        }
        return bestC;
      },
      assignMatrix(ZmatFlat, nRows, dimIn) {
        const out = new Int32Array(nRows);
        for (let r=0;r<nRows;r++){
          let bestC = 0, bestD = Infinity;
          const base = r*dimIn;
          for (let c=0;c<this.k;c++){
            let s=0;
            const cBase = c*this.dim;
            for (let d=0; d<this.dim; d++){
              const v = ZmatFlat[base + d] || 0;
              const dd = v - this.centroids[cBase + d];
              s += dd*dd;
            }
            if (s < bestD) { bestD = s; bestC = c; }
          }
          out[r] = bestC;
        }
        return out;
      }
    };

    window._kmeansModel = model;
    return model;
  }

  function summarizeModel(model) {
    try {
      if (!model) model = window._kmeansModel;
      if (!model) { console.warn('Sem modelo KMeans'); return null; }

      const recs = (typeof window.getWorkspaceRecordings === 'function') ? (window.getWorkspaceRecordings() || []) : (window.recordings || []);
      const nameOf = (id) => {
        const r = recs.find(rr => rr && String(rr.id) === String(id));
        return r ? (r.name || String(id)) : String(id);
      };

      const sizes = Array.from(model.clusterSizes || []);
      const perRec = model.perRecordingClusterCounts || {};
      const perRecRows = Object.keys(perRec).map(id => {
        const arr = Array.from(perRec[id]).map((v,i)=>`C${i}:${v}`).join(', ');
        return `${nameOf(id)} -> ${arr}`;
      });

      console.group('%cKMeans summary', 'color:#036;font-weight:700;');
      console.log('k:', model.k, 'dim:', model.dim, 'inertia:', model.inertia);
      console.log('sizes:', sizes);
      if (perRecRows.length) console.log('per recording:', perRecRows);
      console.groupEnd();
      return { sizes, inertia: model.inertia, perRecordingClusterCounts: perRec };
    } catch (e) {
      console.warn('summarizeModel erro:', e);
      return null;
    }
  }

  window.kmeans = {
    runIncrementalKMeansOnTrainPool,
    summarizeModel
  };

})();