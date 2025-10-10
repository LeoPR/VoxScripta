// feature-validator.js
// Pequena ferramenta para diagnosticar a qualidade das features extraídas pelo analyzer.
// - Expor window.featureValidator.validate(featuresResult) -> objeto com estatísticas
// - Expor window.featureValidator.validateAndLog(recOrFeatures) -> executa extractFeatures se necessário e loga no console
//
// Uso:
//   const rec = window.getWorkspaceRecordings()[0];
//   await window.featureValidator.validateAndLog(rec);
//   // retorno: objeto com campos: valid, nanCount, infCount, frames, dims, nMels, perDimStats (mean,min,max,var), warnings

(function(){
  'use strict';

  function safeGetFeatures(input) {
    // aceita: featuresResult (obj), recording object (com __featuresCache ou blob/url)
    if (!input) return null;
    if (input.features && input.shape && input.meta) return input;
    return null;
  }

  async function ensureFeaturesForRecord(rec) {
    if (!rec) return null;
    if (rec.__featuresCache) return rec.__featuresCache;
    if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function') {
      throw new Error('analyzer.extractFeatures não disponível');
    }
    const src = rec.blob || rec.url;
    const res = await window.analyzer.extractFeatures(src, {});
    rec.__featuresCache = res;
    return res;
  }

  function computeDimStats(flat, frames, dims, sampleLimit = 1e6) {
    // calcula mean, min, max, variance (uma passada) por dimensão
    const n = Math.min(frames, Math.floor(sampleLimit / dims));
    const mean = new Float64Array(dims);
    const min = new Float64Array(dims);
    const max = new Float64Array(dims);
    const m2 = new Float64Array(dims);
    for (let i = 0; i < dims; i++) { min[i] = Infinity; max[i] = -Infinity; }

    // usar amostragem se necessário
    const step = Math.max(1, Math.floor(frames / Math.max(1, n)));
    let count = 0;
    for (let f = 0; f < frames; f += step) {
      const base = f * dims;
      count++;
      for (let d = 0; d < dims; d++) {
        const v = flat[base + d];
        const val = Number.isFinite(v) ? v : 0;
        const delta = val - mean[d];
        mean[d] += delta / count;
        m2[d] += delta * (val - mean[d]);
        if (val < min[d]) min[d] = val;
        if (val > max[d]) max[d] = val;
      }
    }
    const varArr = new Float64Array(dims);
    for (let d = 0; d < dims; d++) {
      varArr[d] = (count > 1) ? (m2[d] / (count - 1)) : 0;
      if (!Number.isFinite(varArr[d])) varArr[d] = 0;
    }
    return { mean, min, max, var: varArr, sampled: count };
  }

  function topKVariance(varArr, k=8) {
    const idx = Array.from({length: varArr.length}, (_,i) => i);
    idx.sort((a,b) => (varArr[b] - varArr[a]));
    return idx.slice(0, Math.min(k, idx.length)).map(i => ({ dim: i, var: varArr[i] }));
  }

  function validateFeaturesResult(fr) {
    if (!fr || !fr.features || !fr.shape || !fr.meta) {
      return { valid: false, error: 'Formato inesperado de featuresResult' };
    }
    const frames = fr.shape.frames;
    const dims = fr.shape.dims;
    const nMels = (fr.meta && fr.meta.nMels) ? fr.meta.nMels : Math.max(0, dims - 3);
    const flat = fr.features;

    let nanCount = 0, infCount = 0;
    // percorrer com passo para não travar se muito grande (amostra até 100k valores)
    const maxVals = 100000;
    const totalVals = Math.min(flat.length, maxVals);
    const step = Math.max(1, Math.floor(flat.length / totalVals));
    for (let i = 0; i < flat.length; i += step) {
      const v = flat[i];
      if (Number.isNaN(v)) nanCount++;
      else if (!Number.isFinite(v)) infCount++;
    }

    // estatísticas por dimensão (amostra)
    const dimStats = computeDimStats(flat, frames, dims, 200000);

    const warnings = [];
    const pctNaN = (nanCount / Math.max(1, flat.length)) * 100;
    const pctInf = (infCount / Math.max(1, flat.length)) * 100;
    if (pctNaN > 0.01) warnings.push(`Muitos NaN: ${pctNaN.toFixed(4)}% dos valores`);
    if (pctInf > 0.01) warnings.push(`Muitos Inf: ${pctInf.toFixed(4)}% dos valores`);
    // verificar melSum e RMS baixos
    // melSum médio:
    let melSumMean = 0;
    const sampleFrames = Math.min(frames, 2000);
    const stepF = Math.max(1, Math.floor(frames / sampleFrames));
    for (let f = 0; f < frames; f += stepF) {
      let ms = 0;
      const base = f * dims;
      for (let m = 0; m < nMels; m++) {
        const v = flat[base + m];
        ms += (Number.isFinite(v) ? v : 0);
      }
      melSumMean += ms;
    }
    melSumMean = melSumMean / Math.max(1, Math.ceil(frames / stepF));
    // RMS ratio estimation
    const rmsIdx = nMels;
    let rmsLowCount = 0;
    for (let f = 0; f < frames; f += stepF) {
      const r = flat[f * dims + rmsIdx];
      if (!Number.isFinite(r) || r < 0.005) rmsLowCount++;
    }
    const pctLowRms = (rmsLowCount / Math.max(1, Math.ceil(frames / stepF))) * 100;
    if (pctLowRms > 40) warnings.push(`ALTO SILÊNCIO: ~${pctLowRms.toFixed(1)}% frames com RMS baixo (<0.005)`);
    if (melSumMean < 1e-4) warnings.push(`MEL MUITO BAIXO: média de mel-sum ~${melSumMean.toExponential(2)}`);

    // top/bottom variance dims
    const topVar = topKVariance(dimStats.var, 8);
    const lowVar = Array.from({length: dimStats.var.length}, (_,i)=>i)
      .filter(i => dimStats.var[i] > 0)
      .sort((a,b) => dimStats.var[a] - dimStats.var[b])
      .slice(0,8)
      .map(i => ({ dim: i, var: dimStats.var[i] }));

    return {
      valid: (nanCount === 0 && infCount === 0),
      nanCount,
      infCount,
      frames,
      dims,
      nMels,
      sampleRate: (fr.meta && fr.meta.sampleRate) ? fr.meta.sampleRate : undefined,
      dimStatsSummary: {
        topVar,
        lowVar,
        meanVar: (Array.from(dimStats.var).reduce((a,b)=>a+b,0) / dimStats.var.length)
      },
      perDim: {
        mean: Array.from(dimStats.mean).slice(0, 24),
        min: Array.from(dimStats.min).slice(0, 24),
        max: Array.from(dimStats.max).slice(0, 24),
        varSampledCount: dimStats.sampled
      },
      melSumMean,
      pctLowRms,
      warnings
    };
  }

  async function validateAndLog(input) {
    try {
      let fr = safeGetFeatures(input);
      if (!fr) {
        // tentar como recording object
        fr = await ensureFeaturesForRecord(input);
      }
      const res = validateFeaturesResult(fr);
      console.group('%cfeature-validator: resultado', 'color:#036; font-weight:700');
      console.log('Frames:', res.frames, 'Dims:', res.dims, 'nMels:', res.nMels, 'sampleRate:', res.sampleRate);
      console.log('NaN count:', res.nanCount, 'Inf count:', res.infCount);
      console.log('melSum mean (amostra):', res.melSumMean);
      console.log('pctLowRms (amostra):', res.pctLowRms.toFixed(2) + '%');
      console.log('Top variance dims:', res.dimStatsSummary.topVar);
      console.log('Low variance dims:', res.dimStatsSummary.lowVar);
      if (res.warnings && res.warnings.length) {
        console.warn('Avisos:', res.warnings);
      } else {
        console.log('Sem avisos críticos detectados.');
      }
      console.groupEnd();
      return res;
    } catch (err) {
      console.error('feature-validator erro:', err);
      throw err;
    }
  }

  // Expor API
  window.featureValidator = {
    validate: validateFeaturesResult,
    validateAndLog,
    _internal: { computeDimStats }
  };
})();