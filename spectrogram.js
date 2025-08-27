// spectrogram.js - computa e desenha um espectrograma em escala Mel.
// Parâmetros padrão ajustados conforme solicitado:
//   - fftSize (window size): 2048
//   - window type: Hann
//   - hopSize: 512
//   - colormap padrão: 'viridis'
//
// Há placeholders em window.spectrogramOptions para future features
// como reassignment (spectral reassignment) e pitch (EAC), mas não foram implementados.
// Se quiser implementar reassignment ou EAC, podemos adicionar processamento extra
// e, idealmente, mover o processamento para um WebWorker para maior performance.

(function() {
  // Defaults - você pode alterar window.spectrogramOptions externamente
  window.spectrogramOptions = {
    fftSize: 2048,        // tamanho da FFT (potência de 2)
    hopSize: 512,         // deslocamento entre janelas
    nMels: 64,            // número de bandas mel
    fmin: 0,              // frequência mínima (Hz)
    fmax: null,           // frequência máxima (Hz) (null -> fs/2)
    logScale: true,       // usar escala log (dB)
    dynamicRange: 80,     // range dinâmico em dB para normalização
    colormap: 'viridis',  // 'viridis' ou 'grayscale'
    windowType: 'hann',   // atualmente apenas 'hann' é suportado
    // placeholders (não implementados): reassignment, pitch (EAC)
    enableReassignment: false,
    computePitchEAC: false
  };

  // ---------- FFT (in-place Cooley-Tukey radix-2) ----------
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

    // bit-reversal permutation
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

  // Hann window
  function hannWindow(size) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return w;
  }

  // mel helpers
  function hzToMel(f) {
    return 2595 * Math.log10(1 + f / 700);
  }
  function melToHz(m) {
    return 700 * (Math.pow(10, m / 2595) - 1);
  }

  function createMelFilterbank(nMels, fftSize, sampleRate, fmin, fmax) {
    fmax = fmax || sampleRate / 2;
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
      for (let k = 0; k < binFreqs.length; k++) {
        const f = binFreqs[k];
        if (f >= lower && f <= center) {
          filter[k] = (f - lower) / (center - lower);
        } else if (f >= center && f <= upper) {
          filter[k] = (upper - f) / (upper - center);
        } else {
          filter[k] = 0;
        }
      }
      fb.push(filter);
    }
    return fb; // array of Float32Array length fftSize/2+1
  }

  function applyMelFilterbank(magSpectrum, melFilters) {
    const nMels = melFilters.length;
    const out = new Float32Array(nMels);
    for (let m = 0; m < nMels; m++) {
      let sum = 0;
      const filter = melFilters[m];
      for (let k = 0; k < filter.length; k++) {
        sum += magSpectrum[k] * filter[k];
      }
      out[m] = sum;
    }
    return out;
  }

  function toDb(array, ref = 1.0) {
    const out = new Float32Array(array.length);
    const amin = 1e-10;
    for (let i = 0; i < array.length; i++) {
      out[i] = 20 * Math.log10(Math.max(array[i], amin) / ref);
    }
    return out;
  }

  // simple colormap: viridis-like approximation or grayscale
  function colorMap(value, colormap) {
    // value: 0..1
    if (colormap === 'grayscale') {
      const v = Math.round(value * 255);
      return [v, v, v, 255];
    }
    // Viridis-ish (approx) gradient stops
    const stops = [
      [68, 1, 84],
      [59, 82, 139],
      [33, 144, 140],
      [94, 201, 98],
      [253, 231, 37]
    ];
    const t = value * (stops.length - 1);
    const i = Math.floor(t);
    const frac = t - i;
    const a = stops[Math.max(0, Math.min(stops.length - 1, i))];
    const b = stops[Math.max(0, Math.min(stops.length - 1, i + 1))];
    const r = Math.round(a[0] + (b[0] - a[0]) * frac);
    const g = Math.round(a[1] + (b[1] - a[1]) * frac);
    const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
    return [r, g, bl, 255];
  }

  // main function exposed
  window.showSpectrogram = function(audioUrl, options = {}) {
    const opts = Object.assign({}, window.spectrogramOptions, options);

    // ensure fftSize is power of 2
    let fftSize = opts.fftSize;
    if (!Number.isInteger(Math.log2(fftSize))) {
      // choose next power of two
      const p = Math.ceil(Math.log2(fftSize));
      fftSize = 1 << p;
      console.warn(`spectrogram: fftSize adjusted to next power of two: ${fftSize}`);
    }

    const spectCanvas = document.getElementById('spectrogram');
    if (!audioUrl) {
      spectCanvas.style.display = 'none';
      return;
    }
    spectCanvas.style.display = 'block';
    const ctx = spectCanvas.getContext('2d');
    ctx.clearRect(0, 0, spectCanvas.width, spectCanvas.height);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    fetch(audioUrl)
      .then(res => res.arrayBuffer())
      .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
      .then(audioBuffer => {
        const fs = audioBuffer.sampleRate;
        const hopSize = opts.hopSize;
        const nMels = opts.nMels;
        const fmin = opts.fmin;
        const fmax = opts.fmax || fs / 2;

        const signal = audioBuffer.getChannelData(0); // use channel 0

        // choose window function
        let windowFunc;
        if (opts.windowType === 'hann') {
          windowFunc = hannWindow(fftSize);
        } else {
          // fallback to hann if unknown
          windowFunc = hannWindow(fftSize);
        }

        const melFilters = createMelFilterbank(nMels, fftSize, fs, fmin, fmax);

        // frame count
        const frames = Math.max(0, Math.floor((signal.length - fftSize) / hopSize) + 1);
        if (frames <= 0) {
          console.warn('spectrogram: sinal muito curto para os parâmetros de janela/shift');
        }

        // prepare image buffer: width = frames, height = nMels
        const width = Math.max(1, frames);
        const height = nMels;
        spectCanvas.width = Math.min(1200, Math.max(200, width)); // cap width
        spectCanvas.height = Math.min(512, Math.max(100, height));
        const imageW = spectCanvas.width;
        const imageH = spectCanvas.height;
        const imageData = ctx.createImageData(imageW, imageH);

        // map frames -> canvas pixels horizontally (could downsample if frames > imageW)
        const frameStep = frames / imageW;

        // pre-allocate arrays
        const re = new Float32Array(fftSize);
        const im = new Float32Array(fftSize);

        // compute mel spectrogram (frames x nMels)
        const melSpec = new Float32Array(frames * nMels);
        for (let f = 0; f < frames; f++) {
          const offset = f * hopSize;
          // windowed frame
          for (let i = 0; i < fftSize; i++) {
            const s = signal[offset + i] || 0;
            re[i] = s * windowFunc[i];
            im[i] = 0;
          }
          // FFT (in-place)
          fftComplex(re, im);
          // magnitude for first fftSize/2+1 bins
          const mag = new Float32Array(fftSize / 2 + 1);
          for (let k = 0; k < mag.length; k++) {
            mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
          }
          // apply mel filters
          const melFrame = applyMelFilterbank(mag, melFilters);
          // store
          for (let m = 0; m < nMels; m++) melSpec[f * nMels + m] = melFrame[m];
        }

        // convert to dB if requested
        const ref = 1.0;
        let melDb = new Float32Array(melSpec.length);
        if (opts.logScale) {
          const tmp = toDb(melSpec, ref);
          melDb.set(tmp);
        } else {
          melDb.set(melSpec);
        }

        // normalize to 0..1 using dynamicRange for dB or max for linear
        let minVal = Number.POSITIVE_INFINITY;
        let maxVal = Number.NEGATIVE_INFINITY;
        if (opts.logScale) {
          for (let i = 0; i < melDb.length; i++) {
            if (melDb[i] > maxVal) maxVal = melDb[i];
            if (melDb[i] < minVal) minVal = melDb[i];
          }
          const top = maxVal;
          const bottom = Math.max(maxVal - opts.dynamicRange, minVal);
          // map value to 0..1
          for (let i = 0; i < melDb.length; i++) {
            melDb[i] = (melDb[i] - bottom) / (top - bottom);
            if (melDb[i] < 0) melDb[i] = 0;
            if (melDb[i] > 1) melDb[i] = 1;
          }
        } else {
          // linear normalization
          for (let i = 0; i < melDb.length; i++) {
            if (melDb[i] > maxVal) maxVal = melDb[i];
            if (melDb[i] < minVal) minVal = melDb[i];
          }
          const range = maxVal - minVal || 1;
          for (let i = 0; i < melDb.length; i++) {
            melDb[i] = (melDb[i] - minVal) / range;
          }
        }

        // draw: top frequency (highest mel) at top of canvas
        // for each canvas pixel x, pick corresponding frame index (nearest)
        for (let x = 0; x < imageW; x++) {
          const frameIdx = Math.floor(x * frameStep);
          const base = frameIdx * nMels;
          for (let y = 0; y < imageH; y++) {
            // map canvas y to mel bin (imageH rows -> nMels)
            const melIdx = Math.floor((1 - y / imageH) * (nMels - 1)); // invert vertical
            const v = melDb[Math.max(0, Math.min(nMels - 1, base + melIdx))] || 0;
            const color = colorMap(v, opts.colormap);
            const pix = (y * imageW + x) * 4;
            imageData.data[pix] = color[0];
            imageData.data[pix + 1] = color[1];
            imageData.data[pix + 2] = color[2];
            imageData.data[pix + 3] = color[3];
          }
        }

        ctx.putImageData(imageData, 0, 0);
      })
      .catch(err => {
        console.error('Erro ao gerar espectrograma:', err);
        document.getElementById('spectrogram').style.display = 'none';
      });
  };

})();