// pca-incremental.js — consumindo dados pré-processados via pca-data-prep.js (fala apenas)
// Ajuste: passa limiares robustos (minRmsAbsolute, minMelSumRatio) para evitar frames todos-zero.

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
        model.components[base+i] = Number.isFinite(cand) ? cand : w;
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

  // Consome dados do pca-data-prep (fala somente + filtros robustos)
  async function gatherTrainFeatures() {
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

      // Limiar robusto (evita frames todos-zero)
      minRmsAbsolute: 0.002,
      minMelSumRatio: 0.02
    });

    return {
      data: prep.dataMatrix,
      n: prep.n,
      d: prep.d,
      usedFrames: prep.n,
      skippedFrames: 0,
      framesSilenceTotal: 0,
      framesSilenceKept: 0,
      framesSilenceRemoved: 0,
      speechFrames: prep.n,
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

    model.framesSilenceTotal = framesSilenceTotal || 0;
    model.framesSilenceKept = framesSilenceKept || 0;
    model.framesSilenceRemoved = framesSilenceRemoved || 0;
    model.speechFrames = speechFrames || usedFrames;
    model.silenceFilterEnabled = false; // agora desnecessário
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