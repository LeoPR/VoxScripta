// pca-diagnostics.js
// Instrumentação para diagnosticar entradas do PCA incremental e resultado final.
// NÃO altera o treinamento existente (pca-incremental.js). Apenas coleta estatísticas.
// Expõe:
//   window.pcaDiagnostics.collectPre(trainPoolIds)
//   window.pcaDiagnostics.collectPost(model, preStats)
//
// Resultado salvo em window._pcaDiagnostics = { pre, post }
//
// Pré-PCA (retorno):
// {
//   recordings: nRecs,
//   framesTotal,
//   dims,
//   nMels,
//   rms: {min,max,mean,pctBelow:{'0.001':x,...}, maxGlobal},
//   melSum: {min,max,mean},
//   dimStats: {
//      topVar: [{dim,var},...],
//      lowVar: [{dim,var},...],
//      zeroVarCount,
//      meanVar,
//      dimsWithZeroVar:[...optional limited],
//   },
//   sampleFrames: { indices:[f0,fMid,fLast], vectors:[Float32Array, ...] }, // cópia dos vetores
//   warnings: [...],
//   preparedAt: Date.now()
// }
//
// Pós-PCA:
// {
//   componentNorms: { min,max,mean, list:[...] },
//   projections: { frames:[{index, values:Float32Array}], allSmall:boolean },
//   explained: Float32Array(k),
//   cumulative: Float32Array(k),
//   sumExplained: number,
//   warnings: [...],
//   preparedAt: Date.now()
// }

(function(){
  'use strict';

  function _getTrainRecordings(trainPoolIds){
    const recs = (typeof window.getWorkspaceRecordings === 'function')
      ? window.getWorkspaceRecordings()
      : (window.recordings || []);
    return trainPoolIds
      .map(id => recs.find(r => r && String(r.id) === String(id)))
      .filter(Boolean);
  }

  async function _ensureFeatures(rec){
    if (rec.__featuresCache) return rec.__featuresCache;
    if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function') {
      throw new Error('analyzer.extractFeatures indisponível');
    }
    rec.__featuresCache = await window.analyzer.extractFeatures(rec.blob || rec.url, {});
    return rec.__featuresCache;
  }

  async function collectPre(trainPoolIds){
    const recordings = _getTrainRecordings(trainPoolIds);
    if (!recordings.length) throw new Error('Train Pool vazio para diagnóstico.');

    // Carregar features e acumular estatísticas
    let dims = null;
    let nMels = null;
    let totalFrames = 0;

    let rmsMin = Infinity, rmsMax = -Infinity, rmsSum = 0;
    const rmsBelow = { '0.001':0, '0.005':0, '0.01':0, '0.02':0 };
    let melSumMin = Infinity, melSumMax = -Infinity, melSumSum = 0;
    let globalMaxRms = 0;

    // Para variância por dimensão: soma e soma dos quadrados
    let sumPerDim = null;
    let sumSqPerDim = null;

    // Guardar até 3 frames amostrais: first, mid, last global
    const sampleVectors = [];
    const sampleIndices = []; // índices globais
    let globalFrameIndex = 0;
    let firstCaptured = false;
    let midTarget = null; // será definido após saber total
    let pendingMid = true;

    // Precisamos primeiro saber total de frames para definir midTarget. Faremos em duas passagens:
    // (1) Passagem rápida para contar frames total
    for (const rec of recordings){
      const fr = await _ensureFeatures(rec);
      totalFrames += fr.shape.frames;
    }
    // Definir midTarget
    midTarget = Math.floor(totalFrames / 2);

    // (2) Segunda passagem para coletar estatísticas
    let accumulatedFrames = 0;
    for (const rec of recordings){
      const fr = rec.__featuresCache;
      if (!fr) continue;
      if (dims == null){ dims = fr.shape.dims; nMels = fr.meta.nMels; }
      if (fr.shape.dims !== dims){
        console.warn('Dimensão inconsistente em diagnóstico, pulando gravação', rec.id);
        continue;
      }
      const flat = fr.features;
      const frames = fr.shape.frames;
      const localFramesStart = accumulatedFrames;
      const localFramesEnd = accumulatedFrames + frames - 1;

      // Alocar vetores de acumulação se ainda não
      if (!sumPerDim){
        sumPerDim = new Float64Array(dims);
        sumSqPerDim = new Float64Array(dims);
      }

      for (let f=0; f<frames; f++){
        const base = f * dims;

        // RMS
        const rms = flat[base + nMels];
        if (rms < rmsMin) rmsMin = rms;
        if (rms > rmsMax) rmsMax = rms;
        rmsSum += rms;
        if (rms > globalMaxRms) globalMaxRms = rms;
        if (rms < 0.001) rmsBelow['0.001']++;
        if (rms < 0.005) rmsBelow['0.005']++;
        if (rms < 0.01) rmsBelow['0.01']++;
        if (rms < 0.02) rmsBelow['0.02']++;

        // mel sum
        let melSum = 0;
        for (let m=0; m<nMels; m++){
          melSum += flat[base + m];
        }
        if (melSum < melSumMin) melSumMin = melSum;
        if (melSum > melSumMax) melSumMax = melSum;
        melSumSum += melSum;

        // variância
        for (let d=0; d<dims; d++){
          const v = flat[base + d];
            sumPerDim[d] += v;
            sumSqPerDim[d] += v*v;
        }

        // Captura de frames amostrais:
        // first
        if (!firstCaptured){
          sampleVectors.push(new Float32Array(flat.subarray(base, base + dims)));
          sampleIndices.push(globalFrameIndex);
          firstCaptured = true;
        }
        // middle (aproximar quando passar de midTarget)
        if (pendingMid && globalFrameIndex >= midTarget){
          sampleVectors.push(new Float32Array(flat.subarray(base, base + dims)));
          sampleIndices.push(globalFrameIndex);
          pendingMid = false;
        }
        // last (sempre sobrescrevendo até o final; no final fica o último)
        if (globalFrameIndex === totalFrames -1){
          sampleVectors.push(new Float32Array(flat.subarray(base, base + dims)));
          sampleIndices.push(globalFrameIndex);
        }

        globalFrameIndex++;
      }
      accumulatedFrames += frames;
    }

    const framesTotal = totalFrames;
    const rmsMean = framesTotal ? rmsSum / framesTotal : 0;
    const melSumMean = framesTotal ? melSumSum / framesTotal : 0;

    // Variância por dimensão
    const varPerDim = new Float64Array(dims);
    for (let d=0; d<dims; d++){
      if (framesTotal){
        const mean = sumPerDim[d] / framesTotal;
        const meanSq = sumSqPerDim[d] / framesTotal;
        let v = meanSq - mean*mean;
        if (!Number.isFinite(v) || v < 0) v = 0;
        varPerDim[d] = v;
      } else {
        varPerDim[d] = 0;
      }
    }

    // Ordenar top e low variâncias
    const indices = Array.from({length:dims}, (_,i)=>i);
    indices.sort((a,b)=> varPerDim[b] - varPerDim[a]);

    const topVar = indices.slice(0, Math.min(5,dims)).map(i => ({ dim:i, var: +varPerDim[i].toExponential(3) }));
    const lowVarFiltered = indices
      .filter(i => varPerDim[i] > 0)
      .slice(-5)
      .map(i => ({ dim:i, var:+varPerDim[i].toExponential(3) }));

    const zeroVarDims = indices.filter(i => varPerDim[i] === 0);
    const zeroVarCount = zeroVarDims.length;
    const meanVar = dims ? (varPerDim.reduce((a,b)=>a+b,0)/dims) : 0;

    // Avisos
    const warnings = [];
    const pct005 = (rmsBelow['0.005']/framesTotal)*100;
    if (pct005 > 40){
      warnings.push(`ALTO SILÊNCIO: ${pct005.toFixed(1)}% dos frames com RMS < 0.005`);
    }
    if (melSumMean < 1e-4){
      warnings.push(`MEL MUITO BAIXO: melSum médio ${melSumMean.toExponential(2)}`);
    }
    if (zeroVarCount > 0){
      warnings.push(`Dimensões com variância zero: ${zeroVarCount}`);
    }

    const pre = {
      recordings: recordings.length,
      framesTotal,
      dims,
      nMels,
      rms: {
        min: rmsMin,
        max: rmsMax,
        mean: rmsMean,
        maxGlobal: globalMaxRms,
        pctBelow: {
          '0.001': +(100 * rmsBelow['0.001']/framesTotal).toFixed(2),
          '0.005': +(100 * rmsBelow['0.005']/framesTotal).toFixed(2),
          '0.01': +(100 * rmsBelow['0.01']/framesTotal).toFixed(2),
          '0.02': +(100 * rmsBelow['0.02']/framesTotal).toFixed(2),
        }
      },
      melSum: {
        min: melSumMin,
        max: melSumMax,
        mean: melSumMean
      },
      dimStats: {
        topVar,
        lowVar: lowVarFiltered,
        zeroVarCount,
        meanVar,
        dimsWithZeroVar: zeroVarDims.slice(0, 15) // limitar lista
      },
      sampleFrames: {
        indices: sampleIndices,
        vectors: sampleVectors
      },
      warnings,
      preparedAt: Date.now()
    };

    window._pcaDiagnostics = window._pcaDiagnostics || {};
    window._pcaDiagnostics.pre = pre;
    return pre;
  }

  function collectPost(model, preStats){
    if (!model) throw new Error('Modelo PCA inexistente para diagnóstico pós.');
    if (!preStats || !preStats.sampleFrames) throw new Error('Stats pré-PCA ausentes.');

    const k = model.k;
    const d = model.d;

    // Normas das componentes
    const norms = new Float32Array(k);
    for (let c=0;c<k;c++){
      const base = c*d;
      let sum=0;
      for (let i=0;i<d;i++){
        const v = model.components[base+i];
        sum += v*v;
      }
      norms[c] = Math.sqrt(sum);
    }
    let minN=Infinity,maxN=-Infinity,sumN=0;
    let degenerate=0;
    for (let c=0;c<k;c++){
      const n = norms[c];
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
      sumN += n;
      if (n < 1e-6) degenerate++;
    }

    // Projeções de frames amostrais
    const projections = [];
    let allSmall = true;
    for (let i=0;i<preStats.sampleFrames.vectors.length;i++){
      const vec = preStats.sampleFrames.vectors[i];
      const proj = model.project(vec);
      // checar magnitude
      let mag=0;
      for (let j=0;j<proj.length;j++) mag += proj[j]*proj[j];
      if (mag > 1e-8) allSmall = false;
      projections.push({
        index: preStats.sampleFrames.indices[i],
        values: proj
      });
    }

    // Variância explicada (já vem no modelo)
    const explained = model.explainedVariance || new Float32Array(k);
    const cumulative = model.cumulativeVariance || new Float32Array(k);
    let sumExpl = 0;
    for (let i=0;i<explained.length;i++) sumExpl += explained[i];

    const warnings = [];
    if (degenerate > 0){
      warnings.push(`COMPONENTES DEGENERADAS: ${degenerate}/${k} (norma < 1e-6)`);
    }
    if (allSmall){
      warnings.push('PROJEÇÕES QUASE NULAS: amostras projetadas com magnitude muito baixa');
    }
    if (sumExpl < 1e-6){
      warnings.push('VARIÂNCIA EXPLICADA TOTAL ~0 (possível falta de normalização ou muitos frames silenciosos)');
    }

    const post = {
      componentNorms: {
        list: norms,
        min: minN,
        max: maxN,
        mean: k ? (sumN / k) : 0,
        degenerate
      },
      projections: {
        frames: projections,
        allSmall
      },
      explained,
      cumulative,
      sumExplained: sumExpl,
      warnings,
      preparedAt: Date.now()
    };

    window._pcaDiagnostics = window._pcaDiagnostics || {};
    window._pcaDiagnostics.post = post;

    return post;
  }

  window.pcaDiagnostics = {
    collectPre,
    collectPost
  };
})();