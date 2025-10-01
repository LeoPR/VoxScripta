// analyzer.js
// Pipeline inicial de extração de features por frame (STFT -> mel bands + RMS + centroid + ZCR).
// Exports: window.analyzer.extractFeatures(source, options)
// - source: Blob ou URL string
// - options: { fftSize, hopSize, nMels, sampleRate (override), window: 'hann' }
// Returns Promise resolving to:
// { features: Float32Array, shape: { frames, dims }, timestamps: Float32Array, meta: {...} }

(function () {
  'use strict';

  // Defaults (will try to read from appConfig if available)
  const DEFAULTS = {
    fftSize: 2048,
    hopSize: 512,
    nMels: 40,
    window: 'hann'
  };

  function _getDefaultsFromConfig() {
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        const merged = window.appConfig.getMergedProcessingOptions();
        return {
          fftSize: (merged.spectrogram && merged.spectrogram.fftSize) || DEFAULTS.fftSize,
          hopSize: (merged.spectrogram && merged.spectrogram.hopSize) || DEFAULTS.hopSize,
          nMels: (merged.spectrogram && merged.spectrogram.nMels) || DEFAULTS.nMels,
          window: DEFAULTS.window
        };
      }
    } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULTS);
  }

  // -------------------------
  // Helpers: decode Blob/URL -> AudioBuffer
  // -------------------------
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
        throw new Error('Fonte inválida: esperado Blob ou URL string');
      }
      // decodeAudioData may require slice depending on browser; slice for safety
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      try { audioCtx.close && audioCtx.close(); } catch (_) {}
      return audioBuffer;
    } catch (err) {
      try { audioCtx.close && audioCtx.close(); } catch (_) {}
      throw err;
    }
  }

  // -------------------------
  // Window functions
  // -------------------------
  function hannWindow(N) {
    const w = new Float32Array(N);
    if (N === 1) { w[0] = 1.0; return w; }
    for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    return w;
  }

  // -------------------------
  // Minimal radix-2 Cooley-Tukey FFT implementation (in-place)
  // Returns complex arrays re[], im[] (both Float32Array of length N, N power of 2)
  // -------------------------
  function fftRadix2(re, im) {
    const n = re.length;
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be power of 2');
    // bit-reversal permutation
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        const tmpRe = re[i]; re[i] = re[j]; re[j] = tmpRe;
        const tmpIm = im[i]; im[i] = im[j]; im[j] = tmpIm;
      }
      let m = n >> 1;
      while (j & m) { j ^= m; m >>= 1; }
      j ^= m;
    }
    // Danielson-Lanczos
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
          // update wr, wi
          const nxtWr = wr * wlenRe - wi * wlenIm;
          const nxtWi = wr * wlenIm + wi * wlenRe;
          wr = nxtWr; wi = nxtWi;
        }
      }
    }
  }

  // -------------------------
  // Magnitude spectrum from real samples (frame of length fftSize)
  // -------------------------
  function magnitudeSpectrum(frame, fftSize) {
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    // copy frame into re, zero-pad as necessary
    re.set(frame);
    // im already zeros
    fftRadix2(re, im);
    // compute magnitude for first half (0..fftSize/2)
    const half = Math.floor(fftSize / 2) + 1;
    const mag = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      const rr = re[k];
      const ii = im[k];
      mag[k] = Math.sqrt((isFinite(rr) ? rr * rr : 0) + (isFinite(ii) ? ii * ii : 0));
    }
    return mag;
  }

  // -------------------------
  // Mel filterbank (triangular)
  // -------------------------
  function hzToMel(f) { return 2595 * Math.log10(1 + f / 700); }
  function melToHz(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

  function createMelFilterbank(nMels, fftSize, sampleRate, fmin = 0, fmax = null) {
    if (!fmax) fmax = sampleRate / 2;
    const nFftBins = Math.floor(fftSize / 2) + 1;
    const melMin = hzToMel(fmin);
    const melMax = hzToMel(fmax);
    const melPoints = new Float32Array(nMels + 2);
    for (let i = 0; i < melPoints.length; i++) melPoints[i] = melMin + (i / (nMels + 1)) * (melMax - melMin);
    const hzPoints = new Float32Array(melPoints.length);
    for (let i = 0; i < melPoints.length; i++) hzPoints[i] = melToHz(melPoints[i]);
    const binFreqs = new Float32Array(nFftBins);
    for (let k = 0; k < nFftBins; k++) binFreqs[k] = k * (sampleRate / fftSize);
    const filters = [];
    for (let m = 0; m < nMels; m++) {
      const lower = hzPoints[m];
      const center = hzPoints[m + 1];
      const upper = hzPoints[m + 2];
      const filter = new Float32Array(nFftBins);
      const leftDen = (center - lower) || 1e-9;
      const rightDen = (upper - center) || 1e-9;
      for (let k = 0; k < nFftBins; k++) {
        const f = binFreqs[k];
        if (f >= lower && f <= center) filter[k] = (f - lower) / leftDen;
        else if (f >= center && f <= upper) filter[k] = (upper - f) / rightDen;
        else filter[k] = 0;
      }
      filters.push(filter);
    }
    return filters; // array of Float32Array length nFftBins
  }

  // Apply mel filters to magnitude spectrum -> mel energies
  function applyMelFilterbank(magSpec, melFilters) {
    const nMels = melFilters.length;
    const out = new Float32Array(nMels);
    for (let m = 0; m < nMels; m++) {
      let sum = 0;
      const filt = melFilters[m];
      for (let k = 0; k < filt.length; k++) {
        const v = filt[k];
        if (v) {
          const ms = magSpec[k];
          sum += ms * v;
        }
      }
      out[m] = sum;
    }
    return out;
  }

  // -------------------------
  // Per-frame scalar features
  // -------------------------
  function frameRMS(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      sum += v * v;
    }
    return Math.sqrt(sum / Math.max(1, frame.length));
  }

  function spectralCentroid(magSpec, sampleRate, fftSize) {
    let num = 0;
    let den = 0;
    const half = magSpec.length;
    for (let k = 0; k < half; k++) {
      const mag = magSpec[k];
      const freq = k * (sampleRate / fftSize);
      num += freq * mag;
      den += mag;
    }
    if (den <= 0) return 0;
    return num / den;
  }

  function zeroCrossingRate(frame) {
    let zc = 0;
    let prev = frame[0] >= 0 ? 1 : -1;
    for (let i = 1; i < frame.length; i++) {
      const cur = frame[i] >= 0 ? 1 : -1;
      if (cur !== prev) { zc++; prev = cur; }
    }
    return zc / frame.length;
  }

  // -------------------------
  // Main extractor
  // -------------------------
  async function extractFeatures(source, options = {}) {
    const cfgDefaults = _getDefaultsFromConfig();
    const opts = Object.assign({}, cfgDefaults, options || {});
    const fftSize = Number(opts.fftSize) || cfgDefaults.fftSize;
    const hopSize = Number(opts.hopSize) || cfgDefaults.hopSize;
    const nMels = Number(opts.nMels) || cfgDefaults.nMels;

    // decode
    const audioBuffer = await _decodeToAudioBuffer(source);
    const sampleRate = opts.sampleRate || audioBuffer.sampleRate;
    const channelData = audioBuffer.numberOfChannels ? audioBuffer.getChannelData(0) : null;
    if (!channelData) throw new Error('Áudio não tem canal 0');

    // precompute window and mel filters
    const win = hannWindow(fftSize);
    const melFilters = createMelFilterbank(nMels, fftSize, sampleRate, 0, Math.floor(sampleRate / 2));

    // framing
    const frames = Math.max(0, Math.floor((channelData.length - fftSize) / hopSize) + 1);
    const timestamps = new Float32Array(Math.max(1, frames));
    const dims = nMels + 3; // mel energies + RMS + centroid + zcr
    const features = new Float32Array(Math.max(1, frames) * dims);

    // iterate frames
    for (let f = 0; f < frames; f++) {
      const offset = f * hopSize;
      // build frame with window
      const frame = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        const s = channelData[offset + i] || 0;
        frame[i] = s * win[i];
      }
      // magnitude spectrum
      const mag = magnitudeSpectrum(frame, fftSize); // length fftSize/2+1
      // mel energies
      const melE = applyMelFilterbank(mag, melFilters);
      // scalar features
      const rms = frameRMS(frame);
      const centroid = spectralCentroid(mag, sampleRate, fftSize);
      const zcr = zeroCrossingRate(frame);

      // write into features
      let idx = f * dims;
      // mel energies (raw)
      for (let m = 0; m < nMels; m++) features[idx + m] = melE[m];
      features[idx + nMels] = rms;
      features[idx + nMels + 1] = centroid; // in Hz
      features[idx + nMels + 2] = zcr;

      timestamps[f] = offset / sampleRate;
    }

    // meta info
    const meta = {
      sampleRate,
      fftSize,
      hopSize,
      nMels,
      dims,
      frames
    };

    return {
      features, // Float32Array flattened (frames x dims)
      shape: { frames, dims },
      timestamps,
      meta
    };
  }

  // Expose API
  window.analyzer = window.analyzer || {};
  window.analyzer.extractFeatures = extractFeatures;

  // small helper to reshape flattened features into array of Float32Array rows (optional)
  window.analyzer.reshapeFeatures = function (flat, frames, dims) {
    const out = new Array(frames);
    for (let i = 0; i < frames; i++) {
      out[i] = flat.subarray(i * dims, i * dims + dims);
    }
    return out;
  };

  // done
})();