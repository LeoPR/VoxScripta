// waveform.js - desenho de waveform (versão com showWaveform do recorder.js)
// + utilitários de trim de silêncio e desenho live.
// Exporta globalmente:
// window.showWaveform(source) // aceita Blob ou URL string
// window.drawLiveWaveform(analyser)
// window.stopLiveWaveform()
// window.analyzeLeadingSilence(source, opts)
// window.trimLeadingSilence(source, opts)
// window.trimAndPersistRecording(source, opts)

(function () {
  'use strict';

  // Fallback local (defaults), mas o caminho preferido é via appConfig.trim (config.js)
  const defaultTrimOptions = {
    threshold: 0.01,
    chunkSizeMs: 10,
    minNonSilenceMs: 50,
    safetyPaddingMs: 10
  };

  function _getTrimOptions() {
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        const merged = window.appConfig.getMergedProcessingOptions();
        if (merged && merged.trim) return Object.assign({}, defaultTrimOptions, merged.trim);
      }
    } catch(_) {}
    return defaultTrimOptions;
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
  // Trim utilities (detecta silêncio e cria WAV usando encodeWAV de audio.js)
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
    const opt = Object.assign({}, defaultTrimOptions, _getTrimOptions(), opts);
    const audioBuffer = await _decodeToAudioBuffer(source);
    const sampleRate = audioBuffer.sampleRate;
    const channelData = audioBuffer.numberOfChannels ? audioBuffer.getChannelData(0) : null;
    if (!channelData) return { silenceEnd: 0, sampleRate, samples: 0 };

    const chunkSize = Math.max(1, Math.floor((opt.chunkSizeMs / 1000) * sampleRate));
    const minNonSilenceChunks = Math.max(1, Math.floor(opt.minNonSilenceMs / opt.chunkSizeMs));

    let silenceEndSample = 0;
    let found = false;

    const totalChunks = Math.ceil(channelData.length / chunkSize);

    for (let ci = 0; ci < totalChunks; ci++) {
      const start = ci * chunkSize;
      const len = Math.min(chunkSize, channelData.length - start);
      const rms = _rms(channelData, start, len);

      if (rms > opt.threshold) {
        // Confirmar que há minNonSilenceChunks consecutivos acima do threshold
        let ok = true;
        for (let look = 1; look <= minNonSilenceChunks - 1; look++) {
          const idx = ci + look;
          if (idx >= totalChunks) break;
          const s2 = idx * chunkSize;
          const l2 = Math.min(chunkSize, channelData.length - s2);
          const rms2 = _rms(channelData, s2, l2);
          if (rms2 <= opt.threshold) { ok = false; break; }
        }
        if (ok) {
          // Fim do silêncio = início deste frame não-silencioso (com padding de segurança)
          const pad = Math.max(0, Math.floor((opt.safetyPaddingMs / 1000) * sampleRate));
          silenceEndSample = Math.max(0, (ci * chunkSize) - pad);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      // Não encontrou voz -> silêncio ocupa tudo
      return { silenceEnd: audioBuffer.duration, sampleRate, samples: channelData.length };
    }

    const silenceEnd = Math.min(audioBuffer.duration, silenceEndSample / sampleRate);
    return { silenceEnd, sampleRate, samples: channelData.length };
  }

  // NOTE: encoding removed from waveform.js — usa audio.js (window.encodeWAV)
  async function trimLeadingSilence(source, opts = {}) {
    const opt = Object.assign({}, defaultTrimOptions, _getTrimOptions(), opts);
    const audioBuffer = await _decodeToAudioBuffer(source);
    if (!audioBuffer) throw new Error('Falha ao decodificar áudio');

    const analysis = await analyzeLeadingSilence(source, opt);
    let startSec = analysis.silenceEnd || 0;
    if (startSec >= audioBuffer.duration) {
      const empty = new Float32Array(0);
      return window.encodeWAV(empty, audioBuffer.sampleRate);
    }

    const startSample = Math.floor(startSec * audioBuffer.sampleRate);
    const remaining = Math.max(0, audioBuffer.length - startSample);
    const out = new Float32Array(remaining);
    const ch0 = audioBuffer.getChannelData(0);
    for (let i = 0; i < remaining; i++) {
      out[i] = ch0[startSample + i];
    }
    const wavBlob = window.encodeWAV(out, audioBuffer.sampleRate);
    return wavBlob;
  }

  // Helpers para nome do Trim
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

  async function trimAndPersistRecording(source, opts = {}) {
    const opt = Object.assign({}, defaultTrimOptions, _getTrimOptions(), opts);
    const trimmedBlob = await trimLeadingSilence(source, opt);

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
  // binding do botão trim
  // ------------------------------
  async function _onTrimButtonClick() {
    const btn = document.getElementById('trim-audio-btn');
    if (btn) btn.disabled = true;
    try {
      const audioEl = document.getElementById('audio-player');
      if (!audioEl || !audioEl.src) { alert('Nenhum áudio carregado para trim.'); return; }
      const src = audioEl.src;
      const info = await analyzeLeadingSilence(src);
      const secs = Math.max(0, Math.min(info.silenceEnd || 0, 60));
      const msg = (secs <= 0) ? 'Nenhum silêncio inicial detectado.' : `Silêncio inicial detectado até ${secs.toFixed(3)}s. Deseja aplicar trim e criar nova gravação?`;
      if (secs <= 0) {
        if (!confirm(msg + '\nMesmo assim deseja tentar trim?')) return;
      } else {
        if (!confirm(msg)) return;
      }

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
  window.trimAndPersistRecording = trimAndPersistRecording;

})();