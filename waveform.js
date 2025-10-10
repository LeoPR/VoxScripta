// waveform.js - desenho de waveform (versão com showWaveform do recorder.js)
// + utilitários de trim com integração ao segmentador de silêncio.
// Exporta globalmente:
// window.showWaveform(source)
// window.drawLiveWaveform(analyser)
// window.stopLiveWaveform()
// window.analyzeLeadingSilence(source, opts)        [compat] delega para segmentador quando ativado
// window.trimLeadingSilence(source, opts)           [compat] delega para recorte pelos 2 lados quando ativado
// window.analyzeTrimRegions(source, opts)           [novo] usa segmentador para detectar [start..end]
// window.trimAudioByRegions(source, {startSec,endSec})
// window.trimAndPersistRecording(source, opts)

(function () {
  'use strict';

  // Fallback local (defaults), mas o caminho preferido é via appConfig.trim (config.js)
  const defaultTrimOptions = {
    threshold: 0.01,
    chunkSizeMs: 10,
    minNonSilenceMs: 50,
    safetyPaddingMs: 10,

    // NOVOS (ver config.js)
    useSegmenter: true,
    preRollFraction: 0.0,
    postRollFraction: 0.0,
    minPreRollMs: 0,
    minPostRollMs: 0
  };

  function _getMerged() {
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        return window.appConfig.getMergedProcessingOptions();
      }
    } catch(_) {}
    return { trim: defaultTrimOptions, analyzer: {}, spectrogram: {} };
  }

  // ------------------------------
  // Helpers: decode url/blob -> AudioBuffer
  // ------------------------------
  async function _decodeToAudioBuffer(source) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      let arrayBuffer;
      if (source instanceof Blob) {
        arrayBuffer = await source.arrayBuffer();
      } else if (typeof source === 'string') {
        const res = await fetch(source);
        arrayBuffer = await res.arrayBuffer();
      } else {
        throw new Error('Fonte inválida (esperado URL ou Blob)');
      }
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      try { audioCtx.close && audioCtx.close(); } catch (_) {}
      return audioBuffer;
    } catch (err) {
      try { audioCtx.close && audioCtx.close(); } catch (_) {}
      throw err;
    }
  }

  // ------------------------------
  // drawWaveformFromSamples
  // ------------------------------
  function drawWaveformFromSamples(samples) {
    const waveform = document.getElementById('waveform');
    if (!waveform) return;
    const dpr = window.devicePixelRatio || 1;
    const container = waveform.parentElement || document.body;
    const w = Math.min(940, container.clientWidth || 940);
    const h = parseInt(getComputedStyle(waveform).height, 10) || 180;

    waveform.width = Math.round(w * dpr);
    waveform.height = Math.round(h * dpr);
    waveform.style.width = w + 'px';
    waveform.style.height = h + 'px';

    const ctx = waveform.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#1976d2';
    ctx.beginPath();

    const step = Math.max(1, Math.floor(samples.length / w));
    for (let i = 0; i < w; i++) {
      const start = i * step;
      let min = 1.0, max = -1.0;
      for (let j = 0; j < step && (start + j) < samples.length; j++) {
        const v = samples[start + j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = (1 - (min + 1) / 2) * h;
      const y2 = (1 - (max + 1) / 2) * h;
      ctx.moveTo(i + 0.5, y1);
      ctx.lineTo(i + 0.5, y2);
    }
    ctx.stroke();
  }

  // ------------------------------
  // showWaveform (decodifica e desenha)
  // ------------------------------
  async function showWaveform(source) {
    const waveform = document.getElementById('waveform');
    if (!waveform) return;
    if (!source) {
      waveform.style.display = 'none';
      return;
    }
    waveform.style.display = 'block';
    const ctx = waveform.getContext('2d');
    ctx.clearRect(0, 0, waveform.width, waveform.height);

    try {
      let arrayBuffer;
      if (source instanceof Blob) {
        arrayBuffer = await source.arrayBuffer();
      } else if (typeof source === 'string') {
        const resp = await fetch(source);
        arrayBuffer = await resp.arrayBuffer();
      } else {
        console.warn('showWaveform: fonte inválida');
        return;
      }
      const aCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await aCtx.decodeAudioData(arrayBuffer.slice(0));
      const samples = audioBuffer.getChannelData(0);
      drawWaveformFromSamples(samples);
      aCtx.close().catch(()=>{});
    } catch (err) {
      console.error('Erro em showWaveform:', err);
      waveform.style.display = 'none';
    }
  }

  // ------------------------------
  // Live waveform drawing
  // ------------------------------
  let _liveAnimationId = null;
  function drawLiveWaveform(analyser) {
    if (!analyser) return;
    const waveform = document.getElementById('waveform');
    if (!waveform) return;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    const dpr = window.devicePixelRatio || 1;
    const container = waveform.parentElement || document.body;
    const w = Math.min(940, container.clientWidth || 940);
    const h = parseInt(getComputedStyle(waveform).height, 10) || 180;
    waveform.width = Math.round(w * dpr);
    waveform.height = Math.round(h * dpr);
    waveform.style.width = w + 'px';
    waveform.style.height = h + 'px';
    const ctx = waveform.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    function draw() {
      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      for (let i = 0; i < w; i++) {
        const idx = Math.floor(i * bufferLength / w);
        const v = dataArray[idx] / 128.0;
        const y = (v * 0.5) * h;
        const drawY = h / 2 + (y - h / 4);
        if (i === 0) ctx.moveTo(i, drawY);
        else ctx.lineTo(i, drawY);
      }
      ctx.strokeStyle = "#1976d2";
      ctx.lineWidth = 2;
      ctx.stroke();
      _liveAnimationId = requestAnimationFrame(draw);
    }
    if (_liveAnimationId) cancelAnimationFrame(_liveAnimationId);
    draw();
  }

  function stopLiveWaveform() {
    try {
      if (_liveAnimationId) {
        cancelAnimationFrame(_liveAnimationId);
        _liveAnimationId = null;
      }
    } catch (e) {
      // ignore
    }
  }

  // ------------------------------
  // Helpers p/ nomes e workspace (evitar erro do helper indefinido)
  // ------------------------------
  function _escapeRegExp(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function _stripTrimmedSuffix(name) {
    const m = String(name || '').match(/^(.*?)(?:\s+Trimmed(?:\s+\d+)?)$/i);
    return (m && m[1]) ? m[1] : (name || '');
  }
  function _getSelectedRecordingNameFromDOM() {
    try {
      const el = document.querySelector('#recordings-list .recording-item.selected .recording-name');
      if (el) return (el.textContent || '').trim();
    } catch (_) {}
    return null;
  }
  function _getWorkspaceRecordingsSafe() {
    try {
      if (typeof window.getWorkspaceRecordings === 'function') {
        const recs = window.getWorkspaceRecordings();
        if (Array.isArray(recs)) return recs;
      }
    } catch (_) {}
    return Array.isArray(window.recordings) ? window.recordings : [];
  }
  function _computeNextTrimmedName(baseName, recs) {
    const base = (_stripTrimmedSuffix(baseName) || 'Gravação').trim();
    const rx = new RegExp('^' + _escapeRegExp(base) + '\\s+Trimmed(?:\\s+(\\d+))?$', 'i');
    let maxN = 0;
    for (const r of (recs || [])) {
      const nm = (r && r.name) ? String(r.name) : '';
      const m = nm.match(rx);
      if (m) {
        const n = parseInt(m[1] || '1', 10);
        if (n > maxN) maxN = n;
      }
    }
    return `${base} Trimmed ${maxN + 1}`;
  }
  // expor para evitar ReferenceError mesmo se bundlers mexerem na ordem
  window._getSelectedRecordingNameFromDOM = _getSelectedRecordingNameFromDOM;
  window._getWorkspaceRecordingsSafe = _getWorkspaceRecordingsSafe;

  // ------------------------------
  // Segmentador: analisar regiões de fala para trim dos 2 lados
  // ------------------------------
  async function analyzeTrimRegions(source, opts = {}) {
    const merged = _getMerged();
    const trimOpt = Object.assign({}, defaultTrimOptions, merged.trim || {}, opts || {});
    const analyzerCfg = merged.analyzer || {};
    const spectCfg = merged.spectrogram || {};

    // Se segmentador não estiver disponível ou desativado, cai no método antigo (leading apenas)
    const segFn = (window.segmentSilence || (window.analyzerOverlay && window.analyzerOverlay.segmentSilence));
    if (!trimOpt.useSegmenter || typeof segFn !== 'function' || !window.analyzer || typeof window.analyzer.extractFeatures !== 'function') {
      // fallback: detectar apenas início (compat)
      const lead = await analyzeLeadingSilence(source, trimOpt);
      const ab = await _decodeToAudioBuffer(source);
      return {
        startSec: lead.silenceEnd || 0,
        endSec: ab.duration,
        sampleRate: ab.sampleRate,
        strategy: 'fallback-leading'
      };
    }

    // Usar features para obter RMS por frame
    const featuresRes = await window.analyzer.extractFeatures(source, {
      fftSize: spectCfg.fftSize,
      hopSize: spectCfg.hopSize,
      nMels: spectCfg.nMels
    });
    const { features, shape, meta, timestamps } = featuresRes;
    const frames = shape.frames;
    const dims = shape.dims;
    const nMels = meta.nMels;
    const rmsIdx = nMels;

    if (!frames) {
      const ab = await _decodeToAudioBuffer(source);
      return { startSec: 0, endSec: ab.duration, sampleRate: ab.sampleRate, strategy: 'no-frames' };
    }

    const rms = new Float32Array(frames);
    let maxRms = 0;
    for (let f=0; f<frames; f++){
      const v = features[f*dims + rmsIdx];
      const val = Number.isFinite(v) ? v : 0;
      rms[f] = val;
      if (val > maxRms) maxRms = val;
    }
    if (maxRms <= 0) maxRms = 1;

    // Parâmetros do segmentador
    const silenceRmsRatio = analyzerCfg.silenceRmsRatio || 0.12;
    const minSilenceFrames = analyzerCfg.minSilenceFrames || 5;
    const minSpeechFrames = analyzerCfg.minSpeechFrames || 3;

    const segments = segFn(rms, maxRms, { silenceRmsRatio, minSilenceFrames, minSpeechFrames }) || [];
    const speechSegs = segments.filter(s => s.type === 'speech');

    // Se não achou fala, volta tudo
    const ab = await _decodeToAudioBuffer(source);
    const duration = ab.duration;
    if (speechSegs.length === 0) {
      return { startSec: 0, endSec: duration, sampleRate: ab.sampleRate, strategy: 'no-speech' };
    }

    // Início = começo do 1º segmento de fala; Fim = final do último segmento de fala
    const first = speechSegs[0];
    const last = speechSegs[speechSegs.length - 1];

    // timestamps[f] indica o tempo de início do frame f; estimar fim do último frame
    const frameDur = (meta.hopSize && meta.sampleRate) ? (meta.hopSize / meta.sampleRate) : ((timestamps[1]||0) - (timestamps[0]||0)) || 0;
    let startSec = timestamps[first.startFrame] || 0;
    let endSec = (timestamps[last.endFrame] || 0) + Math.max(frameDur, 0);

    // Aplicar pré/pós-roll fracionário (opcional) — por padrão 0.0 (etapa 1)
    const preRollByFrac = (trimOpt.preRollFraction || 0) * duration;
    const postRollByFrac = (trimOpt.postRollFraction || 0) * duration;
    const preRollByMs = (trimOpt.minPreRollMs || 0) / 1000;
    const postRollByMs = (trimOpt.minPostRollMs || 0) / 1000;

    const preRoll = Math.max(preRollByFrac, preRollByMs);
    const postRoll = Math.max(postRollByFrac, postRollByMs);

    startSec = Math.max(0, startSec - preRoll);
    endSec = Math.min(duration, endSec + postRoll);
    if (endSec < startSec) { endSec = Math.min(duration, startSec + Math.max(frameDur, 0)); }

    return {
      startSec, endSec,
      sampleRate: ab.sampleRate,
      strategy: 'segmenter',
      frames, nMels,
      segmentsCount: segments.length,
      speechSegmentsCount: speechSegs.length
    };
  }

  // ------------------------------
  // Fallback antigo (leading apenas) — mantido p/ compat e fallback
  // ------------------------------
  function _rms(samples, start, len) {
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const v = samples[start + i] || 0;
      sum += v * v;
    }
    return Math.sqrt(sum / Math.max(1, len));
  }

  async function analyzeLeadingSilence(source, opts = {}) {
    const merged = _getMerged();
    const trimOpt = Object.assign({}, defaultTrimOptions, merged.trim || {}, opts);

    // Se segmentador estiver ativo, delega para analyzeTrimRegions
    if (trimOpt.useSegmenter) {
      const reg = await analyzeTrimRegions(source, trimOpt);
      return { silenceEnd: reg.startSec, sampleRate: reg.sampleRate, samples: 0, strategy: reg.strategy };
    }

    // Método original por chunks (somente início)
    const audioBuffer = await _decodeToAudioBuffer(source);
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.numberOfChannels ? audioBuffer.getChannelData(0) : null;
    if (!channelData) return { silenceEnd: 0, sampleRate, samples: 0 };

    const chunkSize = Math.max(1, Math.floor(((trimOpt.chunkSizeMs || 10) / 1000) * sampleRate));
    const minNonSilenceChunks = Math.max(1, Math.floor((trimOpt.minNonSilenceMs || 50) / (trimOpt.chunkSizeMs || 10)));

    let silenceEndSample = 0;
    let found = false;

    const totalChunks = Math.ceil(channelData.length / chunkSize);

    for (let ci = 0; ci < totalChunks; ci++) {
      const start = ci * chunkSize;
      const len = Math.min(chunkSize, channelData.length - start);
      const rms = _rms(channelData, start, len);

      if (rms > (trimOpt.threshold || 0.01)) {
        // confirmar janela de não-silêncio
        let ok = true;
        for (let look = 1; look <= minNonSilenceChunks - 1; look++) {
          const idx = ci + look;
          if (idx >= totalChunks) break;
          const s2 = idx * chunkSize;
          const l2 = Math.min(chunkSize, channelData.length - s2);
          const rms2 = _rms(channelData, s2, l2);
          if (rms2 <= (trimOpt.threshold || 0.01)) { ok = false; break; }
        }
        if (ok) {
          const pad = Math.max(0, Math.floor(((trimOpt.safetyPaddingMs || 10) / 1000) * sampleRate));
          silenceEndSample = Math.max(0, (ci * chunkSize) - pad);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      return { silenceEnd: audioBuffer.duration, sampleRate, samples: channelData.length };
    }

    const silenceEnd = Math.min(audioBuffer.duration, silenceEndSample / sampleRate);
    return { silenceEnd, sampleRate, samples: channelData.length };
  }

  // ------------------------------
  // Trim por regiões [startSec..endSec] — corta ambos lados
  // ------------------------------
  async function trimAudioByRegions(source, regions) {
    const { startSec = 0, endSec = null } = regions || {};
    const audioBuffer = await _decodeToAudioBuffer(source);
    const sr = audioBuffer.sampleRate;
    const startSample = Math.max(0, Math.floor(startSec * sr));
    const endSample = Math.min(audioBuffer.length, Math.floor((endSec !== null ? endSec : audioBuffer.duration) * sr));
    const length = Math.max(0, endSample - startSample);

    const out = new Float32Array(length);
    const ch0 = audioBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) out[i] = ch0[startSample + i];

    // usa WAV encoder global de audio.js
    const wavBlob = window.encodeWAV(out, sr);
    return wavBlob;
  }

  // Mantém API antiga, mas aplica o novo recorte dos dois lados se useSegmenter=true
  async function trimLeadingSilence(source, opts = {}) {
    const merged = _getMerged();
    const trimOpt = Object.assign({}, defaultTrimOptions, merged.trim || {}, opts);
    if (trimOpt.useSegmenter) {
      const reg = await analyzeTrimRegions(source, trimOpt);
      return await trimAudioByRegions(source, { startSec: reg.startSec, endSec: reg.endSec });
    }
    // Fallback antigo (somente começo)
    const analysis = await analyzeLeadingSilence(source, trimOpt);
    const audioBuffer = await _decodeToAudioBuffer(source);
    const startSample = Math.floor((analysis.silenceEnd || 0) * audioBuffer.sampleRate);
    const remaining = Math.max(0, audioBuffer.length - startSample);
    const out = new Float32Array(remaining);
    const ch0 = audioBuffer.getChannelData(0);
    for (let i = 0; i < remaining; i++) out[i] = ch0[startSample + i];
    return window.encodeWAV(out, audioBuffer.sampleRate);
  }

  // ------------------------------
  // Persist + helpers
  // ------------------------------
  async function trimAndPersistRecording(source, opts = {}) {
    const merged = _getMerged();
    const trimOpt = Object.assign({}, defaultTrimOptions, merged.trim || {}, opts);

    let regions = null;
    try {
      regions = await analyzeTrimRegions(source, trimOpt);
    } catch (e) {
      // fallback total
      const lead = await analyzeLeadingSilence(source, trimOpt);
      const ab = await _decodeToAudioBuffer(source);
      regions = { startSec: lead.silenceEnd || 0, endSec: ab.duration };
    }

    const trimmedBlob = await trimAudioByRegions(source, regions);

    // obter nome base do DOM (seleção) ou do workspace
    let baseName = _getSelectedRecordingNameFromDOM();
    const recs = _getWorkspaceRecordingsSafe();
    if (!baseName && recs && recs.length > 0) {
      const last = recs[recs.length - 1];
      baseName = (last && last.name) ? String(last.name) : null;
    }
    if (!baseName) baseName = 'Gravação';
    const suggestedName = _computeNextTrimmedName(baseName, recs);

    if (typeof window.persistRecording === 'function') {
      const rec = await window.persistRecording(trimmedBlob, suggestedName);
      return { recordingObj: rec };
    } else {
      return { blob: trimmedBlob };
    }
  }

  // ------------------------------
  // Botão Trim — agora mostrando [start..end] detectado
  // ------------------------------
  async function _onTrimButtonClick() {
    const btn = document.getElementById('trim-audio-btn');
    if (btn) btn.disabled = true;
    try {
      const audioEl = document.getElementById('audio-player');
      if (!audioEl || !audioEl.src) { alert('Nenhum áudio carregado para trim.'); return; }
      const src = audioEl.src;

      const reg = await analyzeTrimRegions(src);
      const start = Math.max(0, reg.startSec || 0);
      const end = Math.max(start, reg.endSec || 0);
      const dur = (end - start);

      const msg = `Intervalo de fala detectado: ${start.toFixed(3)}s → ${end.toFixed(3)}s (≈ ${(dur).toFixed(3)}s).
Aplicar trim e criar nova gravação?`;
      if (!confirm(msg)) return;

      const res = await trimAndPersistRecording(src);
      if (res && res.recordingObj) {
        alert('Trim aplicado: nova gravação criada.');
        try { if (res.recordingObj.url) showWaveform(res.recordingObj.url); } catch (_) {}
      } else if (res && res.blob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(res.blob);
        a.download = `trimmed-${Date.now()}.wav`;
        a.click();
        alert('Trim aplicado: arquivo gerado para download (não persistido automaticamente).');
        showWaveform(res.blob);
      } else {
        alert('Trim concluído (sem resultado persistido).');
      }
    } catch (err) {
      console.error('Erro ao aplicar trim:', err);
      alert('Erro ao aplicar trim. Veja o console.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  try {
    const trimBtn = document.getElementById('trim-audio-btn');
    if (trimBtn && !trimBtn.__trim_bound) {
      trimBtn.addEventListener('click', _onTrimButtonClick);
      trimBtn.__trim_bound = true;
    }
  } catch (e) {
    // silent
  }

  // ------------------------------
  // Exports
  // ------------------------------
  window.showWaveform = showWaveform;
  window.drawLiveWaveform = drawLiveWaveform;
  window.stopLiveWaveform = stopLiveWaveform;
  window.analyzeLeadingSilence = analyzeLeadingSilence;
  window.trimLeadingSilence = trimLeadingSilence;
  window.analyzeTrimRegions = analyzeTrimRegions;
  window.trimAudioByRegions = trimAudioByRegions;
  window.trimAndPersistRecording = trimAndPersistRecording;

})();