// pca-data-prep.js
// Preparador de matriz para PCA / clustering a partir do Train Pool.
// Adição: retorna segmentsSummary por gravação (contagens de segmentos/frames de fala e silêncio, frames selecionados e silêncio mantido)
// e percentuais: percentSelectedOfSpeech e percentSelectedOfTotal.
//
// Expor window.pcaDataPrep.prepareDataForPCA(trainIds?, options?) e buildContextVector.
//
// Uso:
//   const res = await window.pcaDataPrep.prepareDataForPCA();
//   // res: {
//   //   dataMatrix: Float32Array, n, d, meta,
//   //   perRecordingCounts, framesIndexMap,
//   //   segmentsSummary: {
//   //     [recId]: {
//   //       speechSegmentsCount, silenceSegmentsCount,
//   //       speechFrames, silenceFrames,
//   //       selectedFrames, keptSilenceFrames,
//   //       percentSelectedOfSpeech, percentSelectedOfTotal
//   //     }
//   //   }
//   // }

(function(){
  'use strict';

  function getCfg() {
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        return window.appConfig.getMergedProcessingOptions();
      }
    } catch (_) {}
    return { pca:{}, analyzer:{} };
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

  function isFiniteVector(vec) {
    for (let i = 0; i < vec.length; i++) {
      if (!Number.isFinite(vec[i])) return false;
    }
    return true;
  }

  function clampInplace(vec, minV, maxV) {
    for (let i = 0; i < vec.length; i++) {
      if (!Number.isFinite(vec[i])) {
        vec[i] = 0;
      } else if (vec[i] < minV) {
        vec[i] = minV;
      } else if (vec[i] > maxV) {
        vec[i] = maxV;
      }
    }
  }

  function buildContextVector(flat, frames, dims, t, contextWindow) {
    if (contextWindow <= 0) return new Float32Array(flat.subarray(t * dims, t * dims + dims));
    const width = 2 * contextWindow + 1;
    const out = new Float32Array(width * dims);
    let pos = 0;
    for (let dt = -contextWindow; dt <= contextWindow; dt++) {
      const idx = t + dt;
      if (idx < 0 || idx >= frames) {
        pos += dims;
        continue;
      }
      const start = idx * dims;
      for (let j = 0; j < dims; j++) {
        out[pos++] = flat[start + j];
      }
    }
    return out;
  }

  function computeZScoreMatrix(rows, n, d, scope, nMels) {
    const means = new Float64Array(d);
    const m2 = new Float64Array(d);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const v = rows[i];
      count++;
      for (let j = 0; j < d; j++) {
        const val = Number.isFinite(v[j]) ? v[j] : 0;
        const delta = val - means[j];
        means[j] += delta / count;
        m2[j] += delta * (val - means[j]);
      }
    }
    const std = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      const variance = (count > 1) ? (m2[j] / (count - 1)) : 0;
      std[j] = Math.sqrt(Math.max(variance, 1e-12));
    }

    const applyMask = new Array(d).fill(false);
    if (scope === 'mel') {
      for (let j = 0; j < nMels && j < d; j++) applyMask[j] = true;
    } else {
      for (let j = 0; j < d; j++) applyMask[j] = true;
    }

    for (let i = 0; i < n; i++) {
      const v = rows[i];
      for (let j = 0; j < d; j++) {
        if (applyMask[j]) {
          v[j] = (v[j] - means[j]) / std[j];
        }
      }
    }
    return { means: Array.from(means), std: Array.from(std) };
  }

  async function prepareDataForPCA(trainIds = null, options = {}) {
    const merged = getCfg();
    const defaultPcaCfg = merged.pca || {};
    const analyzerCfg = merged.analyzer || {};

    const opts = Object.assign({
      useSegmentSpeech: true,
      rmsRatioThreshold: defaultPcaCfg.silenceRmsRatio || analyzerCfg.silenceRmsRatio || 0.06,
      minSilenceFrames: defaultPcaCfg.minSilenceFrames || analyzerCfg.minSilenceFrames || 5,
      minSpeechFrames: defaultPcaCfg.minSpeechFrames || analyzerCfg.minSpeechFrames || 3,
      maxFramesPerRecording: 800,
      keepSilenceFraction: (defaultPcaCfg.keepSilenceFraction !== undefined) ? defaultPcaCfg.keepSilenceFraction : 0.0,
      applyZScore: true,
      zscoreScope: 'all',
      contextWindow: 0,
      sampleLimitTotal: 20000,
      clampAbsValue: 1e3,

      // Filtros robustos de fala:
      minRmsAbsolute: 0.002,
      minMelSumRatio: 0.02
    }, options || {});

    const trainPoolIds = Array.isArray(trainIds) && trainIds.length ? trainIds
      : (window.uiAnalyzer && typeof window.uiAnalyzer.getTrainPool === 'function') ? window.uiAnalyzer.getTrainPool() : [];

    if (!trainPoolIds || !trainPoolIds.length) {
      throw new Error('Train Pool vazio. Forneça trainIds ou preencha uiAnalyzer.getTrainPool().');
    }

    const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
    const selectedRecs = trainPoolIds.map(id => recs.find(r => r && String(r.id) === String(id))).filter(Boolean);
    if (!selectedRecs.length) throw new Error('Nenhuma gravação válida encontrada no Train Pool.');

    // descobrir globalMaxRms
    let globalMaxRms = 0;
    const collectedFeatures = []; // {rec, fr}
    let dims = null;
    let nMels = null;
    let sampleRate = 16000;

    for (const rec of selectedRecs) {
      const fr = await ensureFeaturesForRecord(rec);
      if (!fr || !fr.features) continue;
      if (dims == null) dims = fr.shape.dims;
      if (fr.shape.dims !== dims) {
        console.warn('pca-data-prep: dims inconsistentes; pulando rec', rec && rec.id);
        continue;
      }
      if (fr.meta && fr.meta.sampleRate) sampleRate = fr.meta.sampleRate;
      nMels = (fr.meta && fr.meta.nMels) ? fr.meta.nMels : Math.max(0, dims - 3);
      const flat = fr.features;
      const frames = fr.shape.frames;
      const rmsIdx = nMels;
      for (let f = 0; f < frames; f++) {
        const r = flat[f * dims + rmsIdx];
        if (Number.isFinite(r) && r > globalMaxRms) globalMaxRms = r;
      }
      collectedFeatures.push({ rec, fr });
    }
    if (!collectedFeatures.length) throw new Error('Nenhuma feature válida coletada.');

    const safeGlobalMaxRms = Math.max(globalMaxRms, 1e-12);

    const segFn = (window.segmentSilence || (window.analyzerOverlay && window.analyzerOverlay.segmentSilence));
    const useSeg = opts.useSegmentSpeech && typeof segFn === 'function';

    const perRecordingCounts = new Map();
    const segmentsSummary = {}; // por recId (string)
    const selectedVectors = [];
    const framesIndexMap = [];

    for (const { rec, fr } of collectedFeatures) {
      const flat = fr.features;
      const frames = fr.shape.frames;
      const rmsIdx = nMels;

      // Arrays auxiliares
      const rmsArr = new Float32Array(frames);
      const melSumArr = new Float32Array(frames);
      let maxMelSumLocal = 0;
      for (let f = 0; f < frames; f++) {
        const base = f * dims;
        const rv = flat[base + rmsIdx];
        rmsArr[f] = Number.isFinite(rv) ? rv : 0;

        let ms = 0;
        for (let m = 0; m < nMels; m++) {
          const v = flat[base + m];
          if (Number.isFinite(v) && v > 0) ms += v;
        }
        melSumArr[f] = ms;
        if (ms > maxMelSumLocal) maxMelSumLocal = ms;
      }

      // ignora gravação silenciosa
      const localMaxRms = Math.max(...rmsArr);
      if (!Number.isFinite(localMaxRms) || localMaxRms <= 1e-9) {
        console.warn('pca-data-prep: gravação ignorada (RMS máximo ~0):', rec && rec.id);
        perRecordingCounts.set(rec.id, 0);
        segmentsSummary[String(rec.id)] = {
          speechSegmentsCount: 0,
          silenceSegmentsCount: 0,
          speechFrames: 0,
          silenceFrames: frames,
          selectedFrames: 0,
          keptSilenceFrames: 0,
          percentSelectedOfSpeech: 0,
          percentSelectedOfTotal: 0
        };
        continue;
      }

      let segments = [{ startFrame: 0, endFrame: frames - 1, type: 'speech' }];
      if (useSeg) {
        segments = segFn(rmsArr, localMaxRms, {
          silenceRmsRatio: opts.rmsRatioThreshold,
          minSilenceFrames: opts.minSilenceFrames,
          minSpeechFrames: opts.minSpeechFrames
        }) || segments;
      }

      const speechIdxs = [];
      const silenceIdxs = [];
      let speechSegmentsCount = 0;
      let silenceSegmentsCount = 0;
      for (const seg of segments) {
        if (seg.type === 'speech') {
          speechSegmentsCount++;
          for (let f = seg.startFrame; f <= seg.endFrame; f++) {
            if (f >= 0 && f < frames) speechIdxs.push(f);
          }
        } else {
          silenceSegmentsCount++;
          for (let f = seg.startFrame; f <= seg.endFrame; f++) {
            if (f >= 0 && f < frames) silenceIdxs.push(f);
          }
        }
      }

      // thresholds finais
      const thrRmsRelative = (opts.rmsRatioThreshold || 0.0) * safeGlobalMaxRms;
      const thrRms = Math.max(thrRmsRelative, opts.minRmsAbsolute || 0);
      const thrMelSum = (opts.minMelSumRatio || 0) * (maxMelSumLocal || 1);

      // manter fração de silêncio (opcional)
      const chosenSilence = [];
      if (opts.keepSilenceFraction > 0 && silenceIdxs.length > 0) {
        const totalLocal = silenceIdxs.length + speechIdxs.length;
        const maxSilKeepLocal = Math.max(0, Math.floor(opts.keepSilenceFraction * totalLocal));
        if (maxSilKeepLocal > 0) {
          const step = silenceIdxs.length / Math.max(1, maxSilKeepLocal);
          for (let i = 0; i < maxSilKeepLocal; i++) chosenSilence.push(silenceIdxs[Math.floor(i * step)]);
        }
      }

      let candFrames = speechIdxs.concat(chosenSilence);
      candFrames.sort((a,b) => a - b);

      // filtros robustos (RMS e mel-sum)
      candFrames = candFrames.filter(f => {
        const r = rmsArr[f];
        const ms = melSumArr[f];
        const okR = Number.isFinite(r) && r >= thrRms;
        const okM = Number.isFinite(ms) && ms >= thrMelSum;
        return okR && okM;
      });

      // limitar máximo por gravação
      const maxPerRec = Math.max(1, Math.floor(opts.maxFramesPerRecording));
      if (candFrames.length > maxPerRec) {
        const step = candFrames.length / maxPerRec;
        const sampled = [];
        for (let i = 0; i < maxPerRec; i++) sampled.push(candFrames[Math.floor(i * step)]);
        candFrames = sampled;
      }

      // context + normalizações
      let added = 0;
      for (const fIdx of candFrames) {
        const vec = buildContextVector(flat, frames, dims, fIdx, Math.max(0, Math.floor(opts.contextWindow)));
        for (let m = 0; m < nMels && m < vec.length; m++) {
          let v = vec[m];
          if (!Number.isFinite(v) || v < 0) v = 0;
          vec[m] = Math.log1p(v);
        }
        if (vec.length > nMels) {
          const origRms = vec[nMels];
          const safeLocalMaxRms = Math.max(localMaxRms, 1e-12);
          vec[nMels] = Number.isFinite(origRms) ? (origRms / safeLocalMaxRms) : 0;
        }
        if (vec.length > nMels + 1) {
          const origC = vec[nMels + 1];
          const ny = (fr.meta && fr.meta.sampleRate) ? (fr.meta.sampleRate / 2) : (sampleRate / 2);
          vec[nMels + 1] = Number.isFinite(origC) ? (origC / Math.max(1e-6, ny)) : 0;
        }
        if (vec.length > nMels + 2) {
          const z = vec[nMels + 2];
          vec[nMels + 2] = Number.isFinite(z) ? z : 0;
        }

        const clamp = opts.clampAbsValue || 1e3;
        clampInplace(vec, -clamp, clamp);

        if (!isFiniteVector(vec)) continue;
        selectedVectors.push(vec);
        framesIndexMap.push({ recId: rec.id, frameIndex: fIdx, timeSec: (fr.timestamps && fr.timestamps[fIdx] !== undefined) ? fr.timestamps[fIdx] : fIdx });
        added++;
        if (selectedVectors.length >= opts.sampleLimitTotal) break;
      }

      perRecordingCounts.set(rec.id, added);

      // percentuais
      const totalFramesLocal = speechIdxs.length + silenceIdxs.length;
      const percentSelectedOfSpeech = (speechIdxs.length > 0) ? (added / speechIdxs.length) * 100 : 0;
      const percentSelectedOfTotal = (totalFramesLocal > 0) ? (added / totalFramesLocal) * 100 : 0;

      segmentsSummary[String(rec.id)] = {
        speechSegmentsCount,
        silenceSegmentsCount,
        speechFrames: speechIdxs.length,
        silenceFrames: silenceIdxs.length,
        selectedFrames: added,
        keptSilenceFrames: chosenSilence.length,
        percentSelectedOfSpeech,
        percentSelectedOfTotal
      };

      if (selectedVectors.length >= opts.sampleLimitTotal) break;
    }

    const n = selectedVectors.length;
    if (!n) throw new Error('Após filtragem não há frames suficientes para PCA (0).');

    const finalDim = selectedVectors[0].length;
    if (opts.applyZScore) {
      const cw = opts.contextWindow > 0 ? (2*opts.contextWindow+1) : 1;
      computeZScoreMatrix(selectedVectors, n, finalDim, opts.zscoreScope, nMels * cw);
    }

    const dataMatrix = new Float32Array(n * finalDim);
    for (let i = 0; i < n; i++) dataMatrix.set(selectedVectors[i], i * finalDim);

    const meta = {
      originalDims: dims,
      finalDims: finalDim,
      nMels,
      sampleRate,
      contextWindow: opts.contextWindow,
      appliedZScore: !!opts.applyZScore,
      zscoreScope: opts.zscoreScope,
      thresholds: {
        rmsRatioThreshold: opts.rmsRatioThreshold,
        minRmsAbsolute: opts.minRmsAbsolute,
        minMelSumRatio: opts.minMelSumRatio
      }
    };

    return {
      dataMatrix,
      n,
      d: finalDim,
      meta,
      perRecordingCounts: Object.fromEntries(perRecordingCounts),
      framesIndexMap,
      segmentsSummary
    };
  }

  window.pcaDataPrep = {
    prepareDataForPCA,
    buildContextVector
  };

})();