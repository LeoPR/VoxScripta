// spectrogram.js - computa e desenha um espectrograma em escala Mel.
// Parâmetros padrão ajustados conforme solicitado:
//   - fftSize (window size): 2048
//   - window type: Hann
//   - hopSize: 512
//   - colormap padrão: 'viridis'
//
// Implementação com proteções adicionais para evitar canvas "preto" quando
// há valores inválidos, sinal curto ou ranges degenerados.
//
// Nota: reassignment/pitch (EAC) permanecem como placeholders.

(function() {
  window.spectrogramOptions = {
    fftSize: 2048,
    hopSize: 512,
    nMels: 64,
    fmin: 0,
    fmax: null,
    logScale: true,
    dynamicRange: 80,
    colormap: 'viridis',
    windowType: 'hann',
    enableReassignment: false,
    computePitchEAC: false
  };

  // ---------- utilidades ----------
  function isPowerOfTwo(x) {
    return (x & (x - 1)) === 0;
  }
  function nextPowerOfTwo(x) {
    return 1 << Math.ceil(Math.log2(x));
  }

  function bitReverse(n, bits) {
    let rev = 0;
    for (let i = 0; i < bits; i++) {
      rev = (rev << 1) | (n & 1);
      n >>>= 1;
    }
    return rev;
  }

  function fftComplex(real, imag) {
    const n = real.length;
    const bits = Math.log2(n);
    if (!Number.isInteger(bits)) throw new Error('fft size must be power of 2');

    for (let i = 0; i < n; i++) {
      const j = bitReverse(i, bits);
      if (j > i) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const tableStep = Math.PI * 2 / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0; k < half; k++) {
          const t = tableStep * k;
          const wr = Math.cos(t);
          const wi = -Math.sin(t);
          const ix = i + k;
          const jx = ix + half;
          const tr = wr * real[jx] - wi * imag[jx];
          const ti = wr * imag[jx] + wi * real[jx];
          real[jx] = real[ix] - tr;
          imag[jx] = imag[ix] - ti;
          real[ix] += tr;
          imag[ix] += ti;
        }
      }
    }
  }

  function hannWindow(size) {
    const w = new Float32Array(size);
    if (size === 1) { w[0] = 1.0; return w; }
    for (let i = 0; i < size; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return w;
  }

  function hzToMel(f) {
    return 2595 * Math.log10(1 + f / 700);
  }
  function melToHz(m) {
    return 700 * (Math.pow(10, m / 2595) - 1);
  }

  function createMelFilterbank(nMels, fftSize, sampleRate, fmin, fmax) {
    fmax = fmax || sampleRate / 2;
    if (fmin < 0) fmin = 0;
    const melMin = hzToMel(fmin);
    const melMax = hzToMel(fmax);
    const meltabs = new Float32Array(nMels + 2);
    for (let i = 0; i < meltabs.length; i++) {
      meltabs[i] = melToHz(melMin + (i / (nMels + 1)) * (melMax - melMin));
    }
    const binFreqs = new Float32Array(fftSize / 2 + 1);
    for (let i = 0; i < binFreqs.length; i++) binFreqs[i] = i * (sampleRate / fftSize);

    const fb = [];
    for (let m = 0; m < nMels; m++) {
      const lower = meltabs[m];
      const center = meltabs[m + 1];
      const upper = meltabs[m + 2];
      const filter = new Float32Array(binFreqs.length);
      const leftDen = (center - lower) || 1e-9;
      const rightDen = (upper - center) || 1e-9;
      for (let k = 0; k < binFreqs.length; k++) {
        const f = binFreqs[k];
        if (f >= lower && f <= center) {
          filter[k] = (f - lower) / leftDen;
        } else if (f >= center && f <= upper) {
          filter[k] = (upper - f) / rightDen;
        } else {
          filter[k] = 0;
        }
      }
      fb.push(filter);
    }
    return fb;
  }

  function applyMelFilterbank(magSpectrum, melFilters) {
    const nMels = melFilters.length;
    const out = new Float32Array(nMels);
    for (let m = 0; m < nMels; m++) {
      let sum = 0;
      const filter = melFilters[m];
      for (let k = 0; k < filter.length; k++) {
        const f = filter[k];
        if (f) {
          const v = magSpectrum[k];
          if (isFinite(v)) sum += v * f;
        }
      }
      out[m] = sum;
    }
    return out;
  }

  function toDb(array, ref = 1.0) {
    const out = new Float32Array(array.length);
    const amin = 1e-10;
    for (let i = 0; i < array.length; i++) {
      const val = Math.max(array[i], amin);
      out[i] = 20 * Math.log10(val / ref);
    }
    return out;
  }

  function colorMap(value, colormap) {
    let v = Number(value);
    if (!isFinite(v)) v = 0;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    if (colormap === 'grayscale') {
      const c = Math.round(v * 255);
      return [c, c, c, 255];
    }
    // viridis-like stops
    const stops = [
      [68, 1, 84],
      [59, 82, 139],
      [33, 144, 140],
      [94, 201, 98],
      [253, 231, 37]
    ];
    const t = v * (stops.length - 1);
    const i = Math.floor(t);
    const frac = t - i;
    const a = stops[Math.max(0, Math.min(stops.length - 1, i))];
    const b = stops[Math.max(0, Math.min(stops.length - 1, i + 1))];
    const r = Math.round(a[0] + (b[0] - a[0]) * frac);
    const g = Math.round(a[1] + (b[1] - a[1]) * frac);
    const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
    return [r, g, bl, 255];
  }

  // ---------- principal ----------
  window.showSpectrogram = function(audioUrl, options = {}) {
    const opts = Object.assign({}, window.spectrogramOptions, options);

    let fftSize = opts.fftSize;
    if (!isPowerOfTwo(fftSize)) {
      const newSize = nextPowerOfTwo(fftSize);
      console.warn(`spectrogram: fftSize ${fftSize} não é potência de 2. Ajustando para ${newSize}.`);
      fftSize = newSize;
    }
    const hopSize = opts.hopSize > 0 ? opts.hopSize : Math.floor(fftSize / 4);
    const nMels = Math.max(1, opts.nMels);

    const spectCanvas = document.getElementById('spectrogram');
    if (!spectCanvas) return;
    if (!audioUrl) {
      spectCanvas.style.display = 'none';
      return;
    }
    spectCanvas.style.display = 'block';
    const ctx = spectCanvas.getContext('2d');

    // ensure canvas minimal visible bg
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, spectCanvas.width, spectCanvas.height);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    fetch(audioUrl)
      .then(res => res.arrayBuffer())
      .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
      .then(audioBuffer => {
        const fs = audioBuffer.sampleRate;
        const fmin = Math.max(0, opts.fmin || 0);
        const fmax = opts.fmax || fs / 2;

        const signal = audioBuffer.getChannelData(0) || new Float32Array(0);
        if (!signal || signal.length === 0) {
          console.warn('spectrogram: sinal vazio.');
          spectCanvas.style.display = 'none';
          return;
        }

        const windowFunc = (opts.windowType === 'hann') ? hannWindow(fftSize) : hannWindow(fftSize);
        const melFilters = createMelFilterbank(nMels, fftSize, fs, fmin, fmax);

        let frames = Math.max(0, Math.floor((signal.length - fftSize) / hopSize) + 1);
        if (frames <= 0) {
          // fallback: zero-pad to fftSize and produce single frame
          frames = 1;
        }

        // prepare canvas sizes based on frames and nMels but capping to reasonable sizes
        const desiredW = Math.min(1200, Math.max(200, frames));
        const desiredH = Math.min(512, Math.max(100, nMels));
        spectCanvas.width = desiredW;
        spectCanvas.height = desiredH;
        const imageW = spectCanvas.width;
        const imageH = spectCanvas.height;
        const imageData = ctx.createImageData(imageW, imageH);

        const frameStep = frames / imageW;

        // pre-alloc arrays for FFT
        const re = new Float32Array(fftSize);
        const im = new Float32Array(fftSize);

        // compute mel spectrogram
        const melSpec = new Float32Array(frames * nMels);
        for (let f = 0; f < frames; f++) {
          const offset = f * hopSize;
          for (let i = 0; i < fftSize; i++) {
            const s = signal[offset + i] || 0;
            re[i] = s * windowFunc[i];
            im[i] = 0;
          }
          // FFT
          try {
            fftComplex(re, im);
          } catch (err) {
            console.error('spectrogram FFT error:', err);
            spectCanvas.style.display = 'none';
            return;
          }
          // magnitude
          const half = fftSize / 2 + 1;
          const mag = new Float32Array(half);
          for (let k = 0; k < half; k++) {
            const rr = re[k];
            const ii = im[k];
            const m = Math.sqrt((isFinite(rr) ? rr * rr : 0) + (isFinite(ii) ? ii * ii : 0));
            mag[k] = isFinite(m) ? m : 0;
          }
          // mel
          const melFrame = applyMelFilterbank(mag, melFilters);
          for (let m = 0; m < nMels; m++) {
            melSpec[f * nMels + m] = isFinite(melFrame[m]) ? melFrame[m] : 0;
          }
        }

        // to dB if requested
        let melDb;
        if (opts.logScale) {
          // choose a reference: median or max of melSpec to avoid huge negative dB
          let maxVal = 0;
          for (let i = 0; i < melSpec.length; i++) if (melSpec[i] > maxVal) maxVal = melSpec[i];
          const ref = maxVal > 0 ? maxVal : 1.0;
          melDb = toDb(melSpec, ref);
        } else {
          melDb = new Float32Array(melSpec);
        }

        // normalization to 0..1
        let minVal = Infinity, maxVal = -Infinity;
        for (let i = 0; i < melDb.length; i++) {
          const v = melDb[i];
          if (!isFinite(v)) continue;
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
        if (!isFinite(minVal) || !isFinite(maxVal)) {
          // degenerate case, fill with zeros
          for (let i = 0; i < melDb.length; i++) melDb[i] = 0;
          minVal = 0; maxVal = 1;
        }

        if (opts.logScale) {
          const top = maxVal;
          const bottom = Math.max(maxVal - opts.dynamicRange, minVal);
          const denom = (top - bottom) || 1e-6;
          for (let i = 0; i < melDb.length; i++) {
            let nv = (melDb[i] - bottom) / denom;
            if (!isFinite(nv)) nv = 0;
            if (nv < 0) nv = 0;
            if (nv > 1) nv = 1;
            melDb[i] = nv;
          }
        } else {
          const denom = (maxVal - minVal) || 1e-6;
          for (let i = 0; i < melDb.length; i++) {
            let nv = (melDb[i] - minVal) / denom;
            if (!isFinite(nv)) nv = 0;
            if (nv < 0) nv = 0;
            if (nv > 1) nv = 1;
            melDb[i] = nv;
          }
        }

        // draw: top frequency at top of canvas
        for (let x = 0; x < imageW; x++) {
          // nearest frame
          const frameIdx = Math.min(frames - 1, Math.max(0, Math.floor(x * frameStep)));
          const base = frameIdx * nMels;
          for (let y = 0; y < imageH; y++) {
            // map canvas y to mel bin (invert vertical)
            const melIdx = Math.floor((1 - y / imageH) * (nMels - 1));
            const idx = base + melIdx;
            let v = 0;
            if (idx >= 0 && idx < melDb.length) {
              const vv = melDb[idx];
              v = (isFinite(vv) ? vv : 0);
            }
            // clamp
            if (v < 0) v = 0;
            if (v > 1) v = 1;
            const color = colorMap(v, opts.colormap);
            const pix = (y * imageW + x) * 4;
            imageData.data[pix] = color[0];
            imageData.data[pix + 1] = color[1];
            imageData.data[pix + 2] = color[2];
            imageData.data[pix + 3] = 255; // force opaque
          }
        }

        ctx.putImageData(imageData, 0, 0);
      })
      .catch(err => {
        console.error('Erro ao gerar espectrograma:', err);
        spectCanvas.style.display = 'none';
      });
  };

})();