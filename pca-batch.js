// pca-batch.js
// PCA "batch" baseado em autovetores (power iteration + deflation).
// Expor window.pcaBatch.computePCA(dataMatrix, n, d, options)
//
// Uso:
//   const model = window.pcaBatch.computePCA(dataMatrix, n, d, { k: 8 });
//   console.log(model.explainedVariance, model.cumulativeVariance);

(function(){
  'use strict';

  function mulMatVec(C, d, v, out) {
    for (let i = 0; i < d; i++) {
      let s = 0;
      const row = i * d;
      for (let j = 0; j < d; j++) s += C[row + j] * v[j];
      out[i] = s;
    }
  }

  function dot(a, b, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  function norm2(a, n) {
    return Math.sqrt(dot(a, a, n));
  }

  function scaleInplace(a, n, s) {
    for (let i = 0; i < n; i++) a[i] *= s;
  }

  function copyVec(src, dst, n) {
    for (let i = 0; i < n; i++) dst[i] = src[i];
  }

  function orthogonalizeAgainst(v, basis, k, dim) {
    for (let c = 0; c < k; c++) {
      let dotc = 0;
      const base = c * dim;
      for (let i = 0; i < dim; i++) dotc += v[i] * basis[base + i];
      if (dotc !== 0) {
        for (let i = 0; i < dim; i++) v[i] -= dotc * basis[base + i];
      }
    }
  }

  function buildCovarianceMatrix(dataMatrix, n, d, mean) {
    const C = new Float64Array(d * d);
    const denom = Math.max(1, n - 1);
    for (let r = 0; r < n; r++) {
      const base = r * d;
      for (let i = 0; i < d; i++) {
        const xi = Number.isFinite(dataMatrix[base + i]) ? (dataMatrix[base + i] - mean[i]) : 0;
        const rowI = i * d;
        for (let j = 0; j < d; j++) {
          const xj = Number.isFinite(dataMatrix[base + j]) ? (dataMatrix[base + j] - mean[j]) : 0;
          C[rowI + j] += xi * xj;
        }
      }
    }
    const scale = 1.0 / denom;
    for (let i = 0; i < d * d; i++) C[i] *= scale;
    return C;
  }

  function computeMean(dataMatrix, n, d) {
    const mean = new Float64Array(d);
    for (let r = 0; r < n; r++) {
      const base = r * d;
      for (let j = 0; j < d; j++) {
        mean[j] += Number.isFinite(dataMatrix[base + j]) ? dataMatrix[base + j] : 0;
      }
    }
    const invn = 1.0 / Math.max(1, n);
    for (let j = 0; j < d; j++) mean[j] *= invn;
    return mean;
  }

  function powerIterationEigenvector(C, d, prevBasis, maxIter=200, tol=1e-6) {
    const v = new Float64Array(d);
    for (let i = 0; i < d; i++) v[i] = Math.random() - 0.5;
    if (prevBasis && prevBasis.length > 0) {
      orthogonalizeAgainst(v, prevBasis, prevBasis.length / d, d);
    }
    let nrm = norm2(v, d) || 1;
    scaleInplace(v, d, 1.0 / nrm);

    const tmp = new Float64Array(d);
    let lambda = 0;
    for (let it = 0; it < maxIter; it++) {
      mulMatVec(C, d, v, tmp);
      if (prevBasis && prevBasis.length > 0) orthogonalizeAgainst(tmp, prevBasis, prevBasis.length / d, d);
      const nrm2 = norm2(tmp, d) || 1;
      scaleInplace(tmp, d, 1.0 / nrm2);
      let diff = 0;
      for (let i = 0; i < d; i++) {
        const delta = tmp[i] - v[i];
        diff += delta * delta;
      }
      copyVec(tmp, v, d);
      lambda = dot(v, tmp, d);
      if (diff < tol * tol) break;
    }
    const Cv = new Float64Array(d);
    mulMatVec(C, d, v, Cv);
    const eig = dot(v, Cv, d);
    return { vec: v, eigenvalue: eig };
  }

  function deflate(C, d, vec, eig) {
    for (let i = 0; i < d; i++) {
      const vi = vec[i];
      const row = i * d;
      for (let j = 0; j < d; j++) {
        C[row + j] -= eig * vi * vec[j];
      }
    }
  }

  function computePCA_EigenDecomp(C, d, k, options) {
    const comps = new Float64Array(k * d);
    const eigs = new Float64Array(k);
    const Ccopy = new Float64Array(C);
    for (let c = 0; c < k; c++) {
      const prevBasis = (c === 0) ? new Float64Array(0) : comps.subarray(0, c * d);
      const res = powerIterationEigenvector(Ccopy, d, prevBasis, options.maxIter || 500, options.tol || 1e-6);
      const vec = res.vec;
      const eig = res.eigenvalue;
      const vnorm = norm2(vec, d) || 1;
      scaleInplace(vec, d, 1.0 / vnorm);
      for (let i = 0; i < d; i++) comps[c * d + i] = vec[i];
      eigs[c] = eig;
      deflate(Ccopy, d, vec, eig);
    }
    return { components: comps, eigenvalues: eigs };
  }

  function computePCA(dataMatrix, n, d, options = {}) {
    if (!dataMatrix || n <= 0 || d <= 0) throw new Error('Dados inválidos para PCA');
    const opts = Object.assign({ k: Math.min(8, d), maxIter: 500, tol: 1e-6 }, options);
    const k = Math.min(opts.k, d);

    const mean = computeMean(dataMatrix, n, d);
    const C = buildCovarianceMatrix(dataMatrix, n, d, mean);

    let totalVar = 0;
    for (let i = 0; i < d; i++) totalVar += C[i * d + i];

    const eigRes = computePCA_EigenDecomp(C, d, k, opts);

    const componentsFloat32 = new Float32Array(k * d);
    for (let i = 0; i < k * d; i++) componentsFloat32[i] = eigRes.components[i];

    const eigenvalues = eigRes.eigenvalues;
    const explained = new Float64Array(k);
    const cumulative = new Float64Array(k);
    let cum = 0;
    for (let i = 0; i < k; i++) {
      const val = Number.isFinite(eigenvalues[i]) ? eigenvalues[i] : 0;
      const frac = (totalVar > 1e-12) ? (val / totalVar) : 0;
      explained[i] = frac;
      cum += frac;
      cumulative[i] = cum;
    }

    const model = {
      k, d,
      mean,
      components: componentsFloat32,
      eigenvalues: new Float64Array(eigenvalues),
      explainedVariance: explained,
      cumulativeVariance: cumulative,
      project(vecInput) {
        const out = new Float64Array(k);
        for (let c = 0; c < k; c++) {
          let s = 0;
          const base = c * d;
          for (let i = 0; i < d; i++) {
            const xi = Number.isFinite(vecInput[i]) ? vecInput[i] : 0;
            s += componentsFloat32[base + i] * (xi - mean[i]);
          }
          out[c] = s;
        }
        return out;
      },
      transformMatrix(flat) {
        const out = new Float64Array(n * k);
        for (let r = 0; r < n; r++) {
          const baseR = r * d;
          for (let c = 0; c < k; c++) {
            let s = 0;
            const base = c * d;
            for (let i = 0; i < d; i++) {
              const xi = Number.isFinite(flat[baseR + i]) ? flat[baseR + i] : 0;
              s += componentsFloat32[base + i] * (xi - mean[i]);
            }
            out[r * k + c] = s;
          }
        }
        return out;
      }
    };

    return model;
  }

  window.pcaBatch = {
    computePCA
  };

})();