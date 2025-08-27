(function(){
// Simple optimized radix-2 FFT implementation with precomputed twiddles.
// Exposes class FFT with constructor(size) and method transform(real, imag)
// Works in browser and in WebWorker. Designed for reuse across multiple frames.

class FFT {
  constructor(n) {
    if (!Number.isInteger(Math.log2(n))) throw new Error('FFT size must be power of 2');
    this.n = n;
    this._buildReverseTable();
    this._buildTwiddles();
  }

  _buildReverseTable() {
    const n = this.n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let y = 0;
      for (let j = 0; j < bits; j++) {
        y = (y << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = y;
    }
  }

  _buildTwiddles() {
    const n = this.n;
    this.cos = new Float32Array(n/2);
    this.sin = new Float32Array(n/2);
    for (let i = 0; i < n/2; i++) {
      const angle = -2 * Math.PI * i / n;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
  }

  // in-place radix-2 iterative FFT
  transform(real, imag) {
    const n = this.n;
    const rev = this.rev;
    // bit reversal
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = real[i]; real[i] = real[j]; real[j] = tr;
        const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = this.n / size;
      for (let i = 0; i < n; i += size) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const cos = this.cos[k];
          const sin = this.sin[k];
          const l = j + half;
          const tre = cos * real[l] - sin * imag[l];
          const tim = cos * imag[l] + sin * real[l];
          real[l] = real[j] - tre;
          imag[l] = imag[j] - tim;
          real[j] += tre;
          imag[j] += tim;
          k += step;
        }
      }
    }
  }
}

// export in worker/global scope
if (typeof self !== 'undefined') self.FFT = FFT;
if (typeof window !== 'undefined') window.FFT = FFT;
})();
