// model-store.js
// Persistência simples de "treinamentos" (PCA + KMeans) em localStorage.
// API exposta em window.modelStore:
// - saveTraining(name) -> { id, name, createdAt }
// - listTrainings() -> [meta]
// - loadTraining(id) -> full saved object (raw JSON as stored)
// - deleteTraining(id)
// - renameTraining(id, newName)
// - setActiveTraining(id) -> aplica window._pcaModel e window._kmeansModel reconstruídos
// - getActiveTrainingId()
// - getActiveMeta()
// Emite CustomEvent 'training-changed' no document quando o ativo muda.

(function(){
  'use strict';

  const LS_KEY = 'pca_kmeans_trainings_v1';
  const LS_ACTIVE = 'pca_kmeans_active_v1';

  function loadStore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch (e) {
      console.warn('model-store: falha ao ler localStorage', e);
      return [];
    }
  }

  function saveStore(list) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(list));
    } catch (e) {
      console.error('model-store: falha ao salvar localStorage', e);
      throw e;
    }
  }

  function uid() {
    return String(Date.now()) + '-' + Math.floor(Math.random()*1e9).toString(36);
  }

  // Helpers de (de)serialização
  function float32From(arr) {
    try { return new Float32Array(arr); } catch (e) { return new Float32Array(0); }
  }
  function int32From(arr) {
    try { return new Int32Array(arr); } catch (e) { return new Int32Array(0); }
  }

  function safeClone(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  // Reconstroi um modelo PCA salvo (rawSavedModel.pca)
  function reconstructPca(savedPca) {
    if (!savedPca || !savedPca.d || !savedPca.k) return null;
    const k = savedPca.k;
    const d = savedPca.d;
    const compArr = savedPca.components || [];
    const meanArr = savedPca.mean || [];
    const W = float32From(compArr);
    const mean = float32From(meanArr);
    const model = {
      k, d,
      nObs: savedPca.nObs || 0,
      mean,
      components: W,
      framesUsed: savedPca.framesUsed || 0,
      explainedVariance: savedPca.explainedVariance ? Float32Array.from(savedPca.explainedVariance) : null,
      cumulativeVariance: savedPca.cumulativeVariance ? Float32Array.from(savedPca.cumulativeVariance) : null,
      warnings: savedPca.warnings || [],
      segmentsSummary: savedPca.segmentsSummary || {},
      perRecordingCounts: savedPca.perRecordingCounts || {},
      prepMeta: savedPca.prepMeta || {},
      __updatedAt: savedPca.__updatedAt || Date.now()
    };

    // project / transformMatrix (compatível com uso no resto do app)
    model.project = function(x){
      const out = new Float32Array(this.k);
      for (let c=0;c<this.k;c++){
        let sum = 0;
        const base = c * this.d;
        for (let i=0;i<this.d;i++){
          const comp = this.components[base + i] || 0;
          const xi = (x[i] !== undefined && Number.isFinite(x[i])) ? x[i] : 0;
          const mi = this.mean[i] || 0;
          sum += comp * (xi - mi);
        }
        out[c] = sum;
      }
      return out;
    };

    model.transformMatrix = function(Xflat){
      const n = Math.floor(Xflat.length / this.d);
      const out = new Float32Array(n * this.k);
      for (let r=0;r<n;r++){
        for (let c=0;c<this.k;c++){
          let s=0;
          const baseC = c*this.d;
          for (let i=0;i<this.d;i++){
            const xi = Xflat[r*this.d + i] || 0;
            const mi = this.mean[i] || 0;
            s += this.components[baseC + i] * (xi - mi);
          }
          out[r*this.k + c] = s;
        }
      }
      return out;
    };

    return model;
  }

  function reconstructKMeans(savedKm) {
    if (!savedKm || !savedKm.k) return null;
    const k = savedKm.k;
    const dim = savedKm.dim || savedKm.pcaDimsUsed || 2;
    const centroids = float32From(savedKm.centroids || []);
    const clusterSizes = int32From(savedKm.clusterSizes || []);
    const model = {
      k,
      dim,
      centroids,
      clusterSizes,
      inertia: savedKm.inertia || 0,
      assignmentsPreview: savedKm.assignmentsPreview || [],
      perRecordingClusterCounts: savedKm.perRecordingClusterCounts || {},
      optionsUsed: savedKm.optionsUsed || {},
      warnings: savedKm.warnings || [],
      __updatedAt: savedKm.__updatedAt || Date.now()
    };

    model.predict = function(x) {
      let best = 0, bestD = Infinity;
      for (let c=0;c<this.k;c++){
        let s=0;
        const base = c*this.dim;
        for (let i=0;i<this.dim;i++){
          const v = (x[i] !== undefined && Number.isFinite(x[i])) ? x[i] : 0;
          const d0 = v - (this.centroids[base + i] || 0);
          s += d0*d0;
        }
        if (s < bestD) { bestD = s; best = c; }
      }
      return best;
    };

    model.assignMatrix = function(Zflat, nRows, dimIn){
      const out = new Int32Array(nRows);
      for (let r=0;r<nRows;r++){
        let best=0, bestD=Infinity;
        const base = r*dimIn;
        for (let c=0;c<this.k;c++){
          let s=0;
          const cBase = c*this.dim;
          for (let i=0;i<this.dim;i++){
            const v = Zflat[base + i] || 0;
            const dd = v - (this.centroids[cBase + i] || 0);
            s += dd*dd;
          }
          if (s < bestD) { bestD = s; best = c; }
        }
        out[r] = best;
      }
      return out;
    };

    return model;
  }

  // Exporta um objeto pronto para persistência (converte TypedArrays em arrays regulares)
  function prepareSaveObject(name, extraMeta) {
    const pca = window._pcaModel || null;
    const km = window._kmeansModel || null;
    const now = Date.now();
    const o = {
      id: uid(),
      name: name || ('treino-' + new Date(now).toISOString()),
      createdAt: now,
      trainPoolIds: (window.uiAnalyzer && typeof window.uiAnalyzer.getTrainPool === 'function') ? window.uiAnalyzer.getTrainPool().slice() : [],
      pca: null,
      kmeans: null,
      meta: extraMeta || {}
    };

    if (pca) {
      o.pca = {
        k: pca.k,
        d: pca.d,
        nObs: pca.nObs || 0,
        mean: Array.from(pca.mean || []),
        components: Array.from(pca.components || []),
        explainedVariance: pca.explainedVariance ? Array.from(pca.explainedVariance) : null,
        cumulativeVariance: pca.cumulativeVariance ? Array.from(pca.cumulativeVariance) : null,
        framesUsed: pca.framesUsed || 0,
        warnings: pca.warnings || [],
        segmentsSummary: pca.segmentsSummary || {},
        perRecordingCounts: pca.perRecordingCounts || {},
        prepMeta: pca.prepMeta || {},
        __updatedAt: pca.__updatedAt || now
      };
    }

    if (km) {
      o.kmeans = {
        k: km.k,
        dim: km.dim || km.pcaDimsUsed || 2,
        centroids: Array.from(km.centroids || []),
        clusterSizes: Array.from(km.clusterSizes || []),
        inertia: km.inertia || 0,
        assignmentsPreview: km.assignmentsPreview || [],
        perRecordingClusterCounts: km.perRecordingClusterCounts || {},
        optionsUsed: km.optionsUsed || {},
        warnings: km.warnings || [],
        __updatedAt: km.__updatedAt || now
      };
    }

    return o;
  }

  // Public API
  const api = {
    saveTraining(name, extraMeta) {
      const list = loadStore();
      const obj = prepareSaveObject(name, extraMeta);
      list.push(obj);
      saveStore(list);
      return { id: obj.id, name: obj.name, createdAt: obj.createdAt };
    },

    listTrainings() {
      const list = loadStore();
      return list.map(l => ({
        id: l.id,
        name: l.name,
        createdAt: l.createdAt,
        hasPCA: !!l.pca,
        hasKMeans: !!l.kmeans,
        trainPoolIds: l.trainPoolIds || []
      }));
    },

    loadTraining(id) {
      const list = loadStore();
      return list.find(x => x.id === id) || null;
    },

    deleteTraining(id) {
      let list = loadStore();
      const idx = list.findIndex(x => x.id === id);
      if (idx >= 0) {
        list.splice(idx,1);
        saveStore(list);
      }
      // se removemos o ativo atual, limpar ativo
      const active = localStorage.getItem(LS_ACTIVE);
      if (active === id) {
        localStorage.removeItem(LS_ACTIVE);
        window._pcaModel = window._pcaModel || null;
        window._kmeansModel = window._kmeansModel || null;
        document.dispatchEvent(new CustomEvent('training-changed', { detail: { activeId: null } }));
      }
    },

    renameTraining(id, newName) {
      const list = loadStore();
      const it = list.find(x=>x.id===id);
      if (!it) throw new Error('Treinamento não encontrado');
      it.name = newName;
      saveStore(list);
      return true;
    },

    exportTraining(id) {
      const t = this.loadTraining(id);
      if (!t) throw new Error('Treinamento não encontrado');
      return JSON.stringify(t, null, 2);
    },

    setActiveTraining(id) {
      const t = this.loadTraining(id);
      if (!t) throw new Error('Treinamento não encontrado');
      // reconstrói modelos e aplica em window._pcaModel e window._kmeansModel
      window._pcaModel = t.pca ? reconstructPca(t.pca) : null;
      window._kmeansModel = t.kmeans ? reconstructKMeans(t.kmeans) : null;
      localStorage.setItem(LS_ACTIVE, id);
      document.dispatchEvent(new CustomEvent('training-changed', { detail: { activeId: id, meta: { name: t.name, createdAt: t.createdAt } } }));
      return true;
    },

    getActiveTrainingId() {
      return localStorage.getItem(LS_ACTIVE) || null;
    },

    getActiveMeta() {
      const id = this.getActiveTrainingId();
      if (!id) return null;
      const t = this.loadTraining(id);
      if (!t) return null;
      return { id: t.id, name: t.name, createdAt: t.createdAt, trainPoolIds: t.trainPoolIds || [] };
    }
  };

  window.modelStore = api;
  // inicialmente, se houver active em LS, aplicar (reconstruindo)
  (function initActive(){
    try {
      const aid = localStorage.getItem(LS_ACTIVE);
      if (!aid) return;
      const t = api.loadTraining(aid);
      if (!t) return;
      window._pcaModel = t.pca ? reconstructPca(t.pca) : null;
      window._kmeansModel = t.kmeans ? reconstructKMeans(t.kmeans) : null;
      document.dispatchEvent(new CustomEvent('training-changed', { detail: { activeId: aid, meta: { name: t.name } } }));
    } catch (e) {
      console.warn('model-store: falha ao inicializar ativo', e);
    }
  })();

})();