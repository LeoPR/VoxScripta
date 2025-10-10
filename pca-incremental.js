// pca-incremental.js — consumindo dados pré-processados via pca-data-prep.js (fala apenas)
// Mantém estabilidade + avisos. Adição: inclui model.segmentsSummary (da preparação) para uso na UI.

(function(){
  'use strict';

  function getCfg() {
    if (window.appConfig && window.appConfig.getMergedProcessingOptions) {
      const m = window.appConfig.getMergedProcessingOptions();
      return (m && m.pca) ? m.pca : {};
    }
    return {};
  }

  function mulberry32(seed) {
    return function() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function safeOrRandom(vec, d, rng) {
    let norm=0;
    for (let i=0;i<d;i++) norm += vec[i]*vec[i];
    if (norm < 1e-12) {
      if (rng) {
        for (let i=0;i<d;i++) vec[i] = (rng()*2-1)*0.01;
      } else {
        for (let i=0;i<d;i++) vec[i] = (Math.random()*2-1)*0.01;
      }
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

  function createPcaModel(k, d, seed) {
    const W = new Float32Array(k*d);
    if (Number.isFinite(seed)) {
      const rng = mulberry32(seed >>> 0);
      for (let i=0;i<k*d;i++) W[i] = (rng()*2-1)*0.01;
    } else {
      for (let i=0;i<k*d;i++) W[i] = (Math.random()*2-1)*0.01;
    }
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

  function ojaUpdate(model, x, baseLr, reorthEvery, lrDecayFactor, lrPower){
    model.updateMean(x);
    const d = model.d;
    const xc = new Float32Array(d);
    for (let i=0;i<d;i++) {
      const xi = x[i];
      const mi = model.mean[i];
      xc[i] = (Number.isFinite(xi) && Number.isFinite(mi)) ? (xi - mi) : 0;
    }
    const nObs = Math.max(1, model.nObs);
    const lr = (baseLr || 0.05) * (lrDecayFactor || 1.0) / Math.pow(nObs, (typeof lrPower === 'number' ? lrPower : 0.5));

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
        model.components[base+i] = Number.isFinite(cand) ? cand : w;
      }
    }
    if (model.nObs % reorthEvery === 0) {
      reOrthogonalize(model.components, model.k, model.d);
    }
  }

  async function gatherTrainFeaturesWithChecks() {
    const cfg = getCfg();
    const trainIds = (window.uiAnalyzer && window.uiAnalyzer.getTrainPool) ? window.uiAnalyzer.getTrainPool() : [];
    if (!trainIds.length) throw new Error('Train Pool vazio.');
    if (!window.pcaDataPrep || typeof window.pcaDataPrep.prepareDataForPCA !== 'function') {
      throw new Error('pca-data-prep.js não carregado. Inclua pca-data-prep.js antes do PCA.');
    }

    const prep = await window.pcaDataPrep.prepareDataForPCA(trainIds, {
      useSegmentSpeech: true,
      keepSilenceFraction: 0.0,
      applyZScore: false,
      maxFramesPerRecording: cfg.maxFramesPerRecording || 4000,
      contextWindow: 0,
      sampleLimitTotal: cfg.sampleLimitTotal || 80000,
      minRmsAbsolute: cfg.minRmsAbsolute || 0.002,
      minMelSumRatio: cfg.minMelSumRatio || 0.02
    });

    const warnings = [];
    const perRecordingCounts = prep.perRecordingCounts || {};
    const lowRecIds = [];
    for (const idStr of Object.keys(perRecordingCounts)) {
      const c = perRecordingCounts[idStr];
      if (c < (getCfg().minSamplesPerRecordingToWarn || 4)) lowRecIds.push({ id: idStr, count: c });
    }
    if (lowRecIds.length && (getCfg().alertOnLowSamples !== false)) {
      warnings.push(`Algumas gravações forneceram poucas amostras: ${lowRecIds.map(x=>`${x.id}:${x.count}`).join(', ')}`);
    }

    if (prep.n < (getCfg().minFramesForGood || 200)) {
      warnings.push(`Poucas amostras totais para PCA robusto: ${prep.n} frames (recomendado >= ${getCfg().minFramesForGood || 200}).`);
    }

    return Object.assign({}, prep, { warnings, perRecordingCounts });
  }

  async function runBatchFallback(prep, cfg) {
    if (!window.pcaBatch || typeof window.pcaBatch.computePCA !== 'function') {
      throw new Error('pca-batch.js não disponível para fallback.');
    }
    const k = Math.min(cfg.components || 8, prep.d);
    const modelB = window.pcaBatch.computePCA(prep.dataMatrix, prep.n, prep.d, { k });
    const model = {
      k: modelB.k,
      d: modelB.d,
      nObs: prep.n,
      mean: Float32Array.from(modelB.mean || []),
      components: new Float32Array(modelB.components),
      explainedVariance: modelB.explainedVariance || new Float32Array(k),
      cumulativeVariance: modelB.cumulativeVariance || new Float32Array(k),
      framesUsed: prep.n,
      framesSkipped: 0,
      framesSilenceTotal: 0,
      framesSilenceKept: 0,
      framesSilenceRemoved: 0,
      speechFrames: prep.n,
      centroidNormalized: true,
      project(vec) {
        const out = new Float32Array(this.k);
        for (let c = 0; c < this.k; c++) {
          let s = 0;
          const base = c * this.d;
          for (let i = 0; i < this.d; i++) {
            const xi = Number.isFinite(vec[i]) ? vec[i] : 0;
            const mi = this.mean[i] || 0;
            s += this.components[base + i] * (xi - mi);
          }
          out[c] = s;
        }
        return out;
      }
    };
    // anexar resumo de segmentação
    model.segmentsSummary = prep.segmentsSummary || {};
    return model;
  }

  async function runIncrementalPCAOnTrainPool(progressCb){
    const cfg = getCfg();
    const prep = await gatherTrainFeaturesWithChecks();

    const warnings = Array.isArray(prep.warnings) ? prep.warnings.slice() : [];

    if (prep.n <= (cfg.minFramesForBatchFallback || 30)) {
      try {
        const batchModel = await runBatchFallback(prep, cfg);
        batchModel.warnings = warnings;
        batchModel.__updatedAt = Date.now();
        window._pcaModel = batchModel;
        window._pcaWarnings = warnings;
        return batchModel;
      } catch (err) {
        console.warn('[pca-incremental] falha no fallback batch:', err);
      }
    }

    const k = Math.min(cfg.components || 8, prep.d);
    const seed = Number.isFinite(cfg.initSeed) ? (cfg.initSeed & 0xFFFFFFFF) : null;
    const model = createPcaModel(k, prep.d, seed);
    model.framesUsed = prep.n;
    model.framesSkipped = 0;

    const totalEpochs = cfg.maxEpochs || 1;
    const reorth = cfg.reorthogonalizeEvery || 3000;
    const baseLr = cfg.learningRate || 0.05;
    const lrDecayFactor = cfg.lrDecayFactor || 1.0;
    const lrPower = (typeof cfg.lrPower === 'number') ? cfg.lrPower : 0.5;

    let processed=0;
    for (let epoch=0; epoch<totalEpochs; epoch++){
      for (let r=0;r<prep.n;r++){
        const sample = prep.dataMatrix.subarray(r*prep.d, r*prep.d + prep.d);
        ojaUpdate(model, sample, baseLr, reorth, lrDecayFactor, lrPower);
        processed++;
        if (progressCb && processed % 1000 === 0){
          progressCb(processed / (prep.n*totalEpochs));
        }
      }
      if (progressCb) progressCb((epoch+1)/totalEpochs);
    }
    reOrthogonalize(model.components, model.k, model.d);

    const stats = estimateExplainedVariance(model, prep.dataMatrix);
    model.explainedVariance = stats.explained;
    model.cumulativeVariance = stats.cumulative;

    // anexar resumo de segmentação (para a UI)
    model.segmentsSummary = prep.segmentsSummary || {};

    // degeneradas
    const norms = new Float32Array(model.k);
    let degCount = 0;
    for (let c=0;c<model.k;c++){
      let sum=0;
      const base = c * model.d;
      for (let i=0;i<model.d;i++){
        const v = model.components[base + i];
        sum += (Number.isFinite(v) ? v*v : 0);
      }
      norms[c] = Math.sqrt(sum);
      if (!Number.isFinite(norms[c]) || norms[c] < (cfg.degenerateThreshold || 1e-6)) degCount++;
    }
    if (degCount > 0) {
      warnings.push(`Componentes degeneradas detectadas: ${degCount}/${model.k}`);
      if (cfg.replaceDegenerateWithBatch && window.pcaBatch && typeof window.pcaBatch.computePCA === 'function') {
        try {
          const batch = window.pcaBatch.computePCA(prep.dataMatrix, prep.n, prep.d, { k: model.k });
          model.components = new Float32Array(batch.components);
          model.mean = Float32Array.from(batch.mean || []);
          model.explainedVariance = batch.explainedVariance || model.explainedVariance;
          model.cumulativeVariance = batch.cumulativeVariance || model.cumulativeVariance;
          warnings.push('Substituído componentes degeneradas por PCA batch.');
        } catch (err) {
          warnings.push('Falha ao substituir por PCA batch: ' + (err && err.message ? err.message : String(err)));
        }
      } else {
        warnings.push('replaceDegenerateWithBatch desabilitado ou pca-batch não disponível.');
      }
    }

    model.framesUsed = prep.n;
    model.framesSkipped = prep.skippedFrames || 0;
    model.framesSilenceTotal = prep.framesSilenceTotal || 0;
    model.framesSilenceKept = prep.framesSilenceKept || 0;
    model.framesSilenceRemoved = prep.framesSilenceRemoved || 0;
    model.speechFrames = prep.n;
    model.silenceFilterEnabled = false;
    model.centroidNormalized = true;

    model.warnings = warnings;
    model.perRecordingCounts = prep.perRecordingCounts || {};
    model.prepMeta = prep.meta || {};

    model.__updatedAt = Date.now();
    window._pcaModel = model;
    window._pcaWarnings = warnings;

    if (warnings.length) console.warn('[pca-incremental] Warnings:', warnings);
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