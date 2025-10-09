// pca-incremental.js — agora usando segmentação do overlay + log1p nas bandas Mel
(function(){
  'use strict';

  function getCfg() {
    if (window.appConfig && window.appConfig.getMergedProcessingOptions) {
      const m = window.appConfig.getMergedProcessingOptions();
      return (m && m.pca) ? m.pca : {};
    }
    return {};
  }

  function safeOrRandom(vec, d) {
    let norm=0;
    for (let i=0;i<d;i++) norm += vec[i]*vec[i];
    if (norm < 1e-12) {
      for (let i=0;i<d;i++) vec[i] = (Math.random()*2-1)*0.01;
    }
  }

  function reOrthogonalize(W, k, d) {
    for (let i=0;i<k;i++){
      const baseI = i*d;
      safeOrRandom(W.subarray(baseI, baseI+d), d);
      let nrm=0;
      for (let j=0;j<d;j++) nrm+= W[baseI+j]*W[baseI+j];
      nrm = Math.sqrt(nrm) || 1;
      for (let j=0;j<d;j++) W[baseI+j] /= nrm;
      for (let r=i+1;r<k;r++){
        const baseR = r*d;
        let dot=0;
        for (let j=0;j<d;j++) dot += W[baseR+j]*W[baseI+j];
        for (let j=0;j<d;j++) W[baseR+j] -= dot*W[baseI+j];
      }
    }
    for (let i=0;i<k;i++){
      const baseI=i*d;
      let nrm=0;
      for (let j=0;j<d;j++) nrm+=W[baseI+j]*W[baseI+j];
      nrm=Math.sqrt(nrm)||1;
      for (let j=0;j<d;j++) W[baseI+j]/=nrm;
    }
  }

  function createPcaModel(k, d) {
    const W = new Float32Array(k*d);
    for (let i=0;i<k*d;i++) W[i] = (Math.random()*2-1)*0.01;
    reOrthogonalize(W,k,d);
    return {
      k,d,
      nObs:0,
      mean: new Float32Array(d),
      components: W,
      updateMean(x){
        this.nObs++;
        const n=this.nObs;
        for (let i=0;i<this.d;i++){
          const xi = x[i];
          const mi = this.mean[i];
          // proteger contra não-finitos na média
          const diff = (Number.isFinite(xi) && Number.isFinite(mi)) ? (xi - mi) : 0;
          const newMi = mi + diff/n;
          this.mean[i] = Number.isFinite(newMi) ? newMi : mi;
        }
      },
      project(x){
        const out = new Float32Array(this.k);
        for (let c=0;c<this.k;c++){
          const base=c*this.d;
          let sum=0;
          for (let i=0;i<this.d;i++){
            const comp = this.components[base+i];
            const xi = x[i];
            const mi = this.mean[i];
            const term = (Number.isFinite(comp) && Number.isFinite(xi) && Number.isFinite(mi)) ? comp*(xi-mi) : 0;
            sum += term;
          }
          out[c]=sum;
        }
        return out;
      },
      transformMatrix(X){
        const n = Math.floor(X.length / this.d);
        const out = new Float32Array(n*this.k);
        for (let r=0;r<n;r++){
          for (let c=0;c<this.k;c++){
            const base = c*this.d;
            let sum=0;
            for (let i=0;i<this.d;i++){
              const comp = this.components[base+i];
              const xi = X[r*this.d+i];
              const mi = this.mean[i];
              const term = (Number.isFinite(comp) && Number.isFinite(xi) && Number.isFinite(mi)) ? comp*(xi-mi) : 0;
              sum += term;
            }
            out[r*this.k + c] = sum;
          }
        }
        return out;
      }
    };
  }

  function ojaUpdate(model, x, baseLr, reorthEvery){
    model.updateMean(x);
    const d = model.d;
    const xc = new Float32Array(d);
    for (let i=0;i<d;i++) {
      const xi = x[i];
      const mi = model.mean[i];
      xc[i] = (Number.isFinite(xi) && Number.isFinite(mi)) ? (xi - mi) : 0;
    }

    const lr = baseLr / Math.sqrt(model.nObs||1);

    for (let c=0;c<model.k;c++){
      const base = c*d;
      let y=0;
      for (let i=0;i<d;i++){
        const w = model.components[base+i];
        const xi = xc[i];
        if (Number.isFinite(w) && Number.isFinite(xi)) y += w*xi;
      }
      for (let i=0;i<d;i++){
        const w = model.components[base+i];
        const xi = xc[i];
        const upd = (Number.isFinite(lr) && Number.isFinite(y) && Number.isFinite(xi) && Number.isFinite(w))
          ? (lr * y * (xi - y*w))
          : 0;
        const cand = w + upd;
        model.components[base+i] = Number.isFinite(cand) ? cand : w; // proteção contra não-finitos
      }
    }
    if (model.nObs % reorthEvery === 0) {
      reOrthogonalize(model.components, model.k, model.d);
    }
  }

  function estimateExplainedVariance(model, dataMatrix){
    const d = model.d;
    const n = Math.floor(dataMatrix.length / d);
    if (!n) return { explained: new Float32Array(model.k), cumulative: new Float32Array(model.k) };

    const Z = model.transformMatrix(dataMatrix);
    const k = model.k;

    const means = new Float32Array(k);
    for (let r=0;r<n;r++){
      for (let c=0;c<k;c++) means[c]+= Z[r*k + c];
    }
    for (let c=0;c<k;c++) means[c]/=n;

    const varC = new Float32Array(k);
    for (let r=0;r<n;r++){
      for (let c=0;c<k;c++){
        const diff = Z[r*k + c]-means[c];
        varC[c]+= diff*diff;
      }
    }
    for (let c=0;c<k;c++) varC[c]/= Math.max(1,n-1);

    const meanX = model.mean;
    let varTotal=0;
    if (n>1){
      for (let r=0;r<n;r++){
        for (let i=0;i<d;i++){
          const diff = dataMatrix[r*d + i]-meanX[i];
          varTotal += diff*diff;
        }
      }
      varTotal/= (n-1);
    }

    const explained = new Float32Array(k);
    if (varTotal > 1e-18){
      for (let c=0;c<k;c++){
        explained[c] = varC[c]/varTotal;
        if (!Number.isFinite(explained[c])) explained[c]=0;
      }
    }
    const cumulative = new Float32Array(k);
    let sum=0;
    for (let c=0;c<k;c++){
      sum += explained[c];
      cumulative[c]=sum;
    }
    return { explained, cumulative };
  }

  // Normalização mínima: centróide Hz → [0..1] (divide por sampleRate/2) + log1p nas bandas Mel
  function normalizeFeatureVector(vec, nMels, sampleRate){
    for (let m = 0; m < nMels; m++) {
      let v = vec[m];
      // mel energies devem ser ≥0; se vier algo inválido, trata como 0 antes do log1p
      if (!Number.isFinite(v) || v < 0) v = 0;
      vec[m] = Math.log1p(v);
    }
    if (!sampleRate) sampleRate = 16000;
    const centroidIdx = nMels+1;
    const c = vec[centroidIdx];
    vec[centroidIdx] = Number.isFinite(c) ? (c / (sampleRate/2)) : 0;
    // ZCR (nMels+2) fica como está; se for não-finito, zera
    const zcrIdx = nMels+2;
    if (!Number.isFinite(vec[zcrIdx])) vec[zcrIdx] = 0;
    return vec;
  }

  function isFiniteVector(vec){
    for (let i=0;i<vec.length;i++){
      if (!Number.isFinite(vec[i])) return false;
    }
    return true;
  }

  // -- gatherTrainFeatures usando segmentSilence global do overlay --
  async function gatherTrainFeatures() {
    const cfg = getCfg();
    const silenceFilterEnabled = !!cfg.silenceFilterEnabled;
    const keepSilFrac = Math.min(1, Math.max(0, cfg.keepSilenceFraction !== undefined ? cfg.keepSilenceFraction : 0.001));
    const trainIds = (window.uiAnalyzer && window.uiAnalyzer.getTrainPool) ? window.uiAnalyzer.getTrainPool() : [];
    if (!trainIds.length) throw new Error('Train Pool vazio.');
    const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings||[]);
    let dims=null;

    // Descobrir função segmentSilence do overlay
    let segmentSilenceFn = (window.segmentSilence || (window.analyzerOverlay && window.analyzerOverlay.segmentSilence));
    if (typeof segmentSilenceFn !== "function") {
      throw new Error("Função segmentSilence não encontrada. Exporte 'segmentSilence' no overlay-analyzer.js (window.segmentSilence = segmentSilence;)");
    }

    const collected = [];
    let globalMaxRms = 0;
    let sampleRate = 16000;

    // Passagem 1: carregar e descobrir max RMS global
    for (const rid of trainIds) {
      const rec = recs.find(r=> r && String(r.id)===String(rid));
      if (!rec) continue;
      if (!rec.__featuresCache) {
        if (!window.analyzer || !window.analyzer.extractFeatures) throw new Error('analyzer.extractFeatures indisponível.');
        rec.__featuresCache = await window.analyzer.extractFeatures(rec.blob || rec.url, {});
      }
      const fr = rec.__featuresCache;
      if (!dims) dims = fr.shape.dims;
      if (!sampleRate && fr.meta && fr.meta.sampleRate) sampleRate = fr.meta.sampleRate;
      if (fr.shape.dims !== dims) {
        console.warn('Dims inconsistentes; pulando', rid);
        continue;
      }
      collected.push(fr);
      const flat = fr.features;
      const frames = fr.shape.frames;
      const rmsIndex = fr.meta.nMels;
      for (let f=0; f<frames; f++){
        const rms = flat[f*dims + rmsIndex];
        if (rms>globalMaxRms) globalMaxRms = rms;
      }
    }
    if (!collected.length) throw new Error('Nenhuma feature válida coletada.');

    // Passagem 2: aplicar segmentação do overlay e filtragem
    const vectors=[];
    let silenceTotal=0;
    let silenceKept=0;
    let speechFrames=0;
    let invalidFrames=0;

    const silenceRmsRatio = cfg.silenceRmsRatio || 0.05;
    const minSilenceFrames = cfg.minSilenceFrames || 5;
    const minSpeechFrames = cfg.minSpeechFrames || 3;

    for (const fr of collected){
      const flat=fr.features;
      const frames=fr.shape.frames;
      const nMels = fr.meta.nMels;
      const rmsIdx = nMels;

      // Construir array de RMS
      const rmsArr = new Float32Array(frames);
      for (let f=0; f<frames; f++){
        const rv = flat[f*dims + rmsIdx];
        rmsArr[f] = Number.isFinite(rv) ? rv : 0;
      }

      let segments = [];
      if (silenceFilterEnabled){
        segments = segmentSilenceFn(rmsArr, globalMaxRms, {
          silenceRmsRatio,
          minSilenceFrames,
          minSpeechFrames
        });
      } else {
        segments = [{ startFrame: 0, endFrame: frames-1, type: "speech" }];
      }

      const speechIdxs = [];
      const silenceIdxs = [];
      for (const seg of segments){
        for (let f=seg.startFrame; f<=seg.endFrame; f++){
          if (seg.type === "speech") speechIdxs.push(f);
          else silenceIdxs.push(f);
        }
      }

      silenceTotal += silenceIdxs.length;
      speechFrames += speechIdxs.length;

      // Adicionar fala (sanitizando)
      for (const f of speechIdxs){
        const base = f*dims;
        let vec = new Float32Array(flat.subarray(base, base+dims));
        vec = normalizeFeatureVector(vec, nMels, sampleRate);
        if (!isFiniteVector(vec)) { invalidFrames++; continue; }
        vectors.push(vec);
      }

      // Amostra de silêncio, se keepSilFrac > 0
      let chosen = [];
      if (silenceFilterEnabled && keepSilFrac > 0 && silenceIdxs.length > 0){
        const totalLocal = silenceIdxs.length + speechIdxs.length;
        const maxSilKeepLocal = Math.max(1, Math.floor(keepSilFrac * totalLocal));
        if (silenceIdxs.length <= maxSilKeepLocal){
          chosen = silenceIdxs;
        } else {
          const step = silenceIdxs.length / maxSilKeepLocal;
          for (let i=0;i<maxSilKeepLocal;i++){
            const idx = Math.floor(i*step);
            chosen.push(silenceIdxs[idx]);
          }
        }
        silenceKept += chosen.length;
        for (const f of chosen){
          const base = f*dims;
          let vec = new Float32Array(flat.subarray(base, base+dims));
          vec = normalizeFeatureVector(vec, nMels, sampleRate);
          if (!isFiniteVector(vec)) { invalidFrames++; continue; }
          vectors.push(vec);
        }
      }
    }

    const n=vectors.length;
    if (!n) throw new Error('Após filtragem não há frames suficientes.');

    const data = new Float32Array(n*dims);
    for (let r=0;r<n;r++) data.set(vectors[r], r*dims);

    if (invalidFrames > 0) {
      console.warn(`[PCA] Frames inválidos descartados: ${invalidFrames}`);
    }

    return {
      data,
      n,
      d:dims,
      usedFrames: n,
      skippedFrames: (silenceTotal - silenceKept),
      framesSilenceTotal: silenceTotal,
      framesSilenceKept: silenceKept,
      framesSilenceRemoved: silenceTotal - silenceKept,
      speechFrames,
      centroidNormalized: true
    };
  }

  async function runIncrementalPCAOnTrainPool(progressCb){
    const cfg = getCfg();
    const {
      data, n, d,
      usedFrames,
      framesSilenceTotal,
      framesSilenceKept,
      framesSilenceRemoved,
      speechFrames,
      centroidNormalized,
      skippedFrames
    } = await gatherTrainFeatures();

    const k = Math.min(cfg.components || 8, d);
    const model = createPcaModel(k,d);

    const totalEpochs = cfg.maxEpochs || 1;
    const reorth = cfg.reorthogonalizeEvery || 3000;
    const baseLr = cfg.learningRate || 0.05;
    let processed=0;

    for (let epoch=0; epoch<totalEpochs; epoch++){
      for (let r=0;r<n;r++){
        const sample = data.subarray(r*d, r*d + d);
        ojaUpdate(model, sample, baseLr, reorth);
        processed++;
        if (progressCb && processed % 1000 === 0){
          progressCb(processed / (n*totalEpochs));
        }
      }
      if (progressCb) progressCb((epoch+1)/totalEpochs);
    }
    reOrthogonalize(model.components, model.k, model.d);

    const stats = estimateExplainedVariance(model, data);
    model.explainedVariance = stats.explained;
    model.cumulativeVariance = stats.cumulative;
    model.framesUsed = usedFrames;
    model.framesSkipped = skippedFrames || 0;

    model.framesSilenceTotal = framesSilenceTotal;
    model.framesSilenceKept = framesSilenceKept;
    model.framesSilenceRemoved = framesSilenceRemoved;
    model.speechFrames = speechFrames;
    model.silenceFilterEnabled = !!cfg.silenceFilterEnabled;
    model.centroidNormalized = !!centroidNormalized;

    window._pcaModel = model;
    return model;
  }

  function transformFeaturesFlat(flat, frames, dims){
    if (!window._pcaModel) throw new Error('Modelo PCA inexistente');
    if (dims !== window._pcaModel.d) throw new Error('Dims incompatível com PCA');
    const out = new Float32Array(frames * window._pcaModel.k);
    for (let f=0; f<frames; f++){
      const vec = flat.subarray(f*dims, f*dims + dims);
      const proj = window._pcaModel.project(vec);
      out.set(proj, f*window._pcaModel.k);
    }
    return out;
  }

  window.runIncrementalPCAOnTrainPool = runIncrementalPCAOnTrainPool;
  window.pcaModel = { transformFeaturesFlat };

})();