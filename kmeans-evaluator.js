// kmeans-evaluator.js
// Executa KMeans para um intervalo de K com kmeans++ e múltiplos inits.
// Calcula métricas: inertia (SSE), silhouette (amostrado), Calinski-Harabasz (CH) e Davies-Bouldin (DB).
// API: window.kmeansEvaluator.runRange(Xflat, nRows, dim, options)
// options: { Kmin=2, Kmax=8, nInit=5, maxIter=200, tol=1e-4, silhouetteSample=1500, randomSeed=null }
// Retorno: Promise<array de resultados ordenados por K> onde cada item:
// { K, inertia, silhouette, ch, db, centroids: Float32Array(K*dim), sizes: Int32Array(K) }

(function(){
  'use strict';

  function rng(seed) {
    let s = seed != null ? (seed>>>0) : Math.floor(Math.random()*0xFFFFFFFF);
    return function() {
      s = (1664525 * s + 1013904223) >>> 0;
      return (s & 0xFFFFFF) / 0x1000000;
    };
  }

  function sqrDist(a, aOff, b, bOff, dim) {
    let s=0;
    for (let i=0;i<dim;i++) {
      const d = a[aOff+i] - b[bOff+i];
      s += d*d;
    }
    return s;
  }

  function euDist(a, aOff, b, bOff, dim) {
    return Math.sqrt(sqrDist(a,aOff,b,bOff,dim));
  }

  function chooseWeightedIndex(weights, rand) {
    const total = weights.reduce((p,c)=>p+c,0);
    if (total <= 0) return Math.floor(rand()*weights.length);
    const r = rand()*total;
    let acc=0;
    for (let i=0;i<weights.length;i++) {
      acc += weights[i];
      if (r <= acc) return i;
    }
    return weights.length-1;
  }

  function kmeansPlusPlusInit(X, n, dim, k, rand) {
    const centroids = new Float32Array(k*dim);
    let idx0 = Math.floor(rand()*n);
    for (let d=0; d<dim; d++) centroids[d] = X[idx0*dim + d];

    const distSq = new Float64Array(n);
    for (let i=0;i<n;i++) distSq[i] = sqrDist(X, i*dim, centroids, 0, dim);
    let chosen = 1;

    while (chosen < k) {
      const weights = distSq.slice();
      const nextIdx = chooseWeightedIndex(weights, rand);
      const cOff = chosen*dim;
      for (let d=0; d<dim; d++) centroids[cOff+d] = X[nextIdx*dim + d];

      for (let i=0;i<n;i++) {
        const d2 = sqrDist(X, i*dim, centroids, cOff, dim);
        if (d2 < distSq[i]) distSq[i] = d2;
      }
      chosen++;
    }
    return centroids;
  }

  function randomInitFromData(X, n, dim, k, rand) {
    const centroids = new Float32Array(k*dim);
    const used = new Set();
    for (let c=0;c<k;c++) {
      let idx = Math.floor(rand()*n);
      while (used.has(idx)) idx = Math.floor(rand()*n);
      used.add(idx);
      for (let d=0; d<dim; d++) centroids[c*dim + d] = X[idx*dim + d];
    }
    return centroids;
  }

  function lloydKMeans(X, n, dim, k, opts) {
    const maxIter = opts.maxIter || 200;
    const tol = opts.tol || 1e-4;
    const rand = opts.rand || Math.random;
    let centroids = opts.init === 'kmeans++'
      ? kmeansPlusPlusInit(X, n, dim, k, rand)
      : randomInitFromData(X, n, dim, k, rand);

    const assignments = new Int32Array(n);
    const sums = new Float64Array(k*dim);
    const counts = new Int32Array(k);

    let prevShift = Infinity;
    for (let iter=0; iter<maxIter; iter++) {
      for (let i=0;i<n;i++) {
        let bestC = 0;
        let bestD = Infinity;
        const xOff = i*dim;
        for (let c=0;c<k;c++) {
          const cOff = c*dim;
          const d2 = sqrDist(X, xOff, centroids, cOff, dim);
          if (d2 < bestD) { bestD = d2; bestC = c; }
        }
        assignments[i] = bestC;
      }

      sums.fill(0);
      counts.fill(0);

      for (let i=0;i<n;i++) {
        const c = assignments[i];
        counts[c]++;
        const xOff = i*dim, cOff = c*dim;
        for (let d=0; d<dim; d++) sums[cOff + d] += X[xOff + d];
      }

      let shift = 0;
      for (let c=0;c<k;c++) {
        const cOff = c*dim;
        if (counts[c] === 0) {
          const ri = Math.floor(rand()*n);
          for (let d=0; d<dim; d++) {
            const old = centroids[cOff+d];
            const neu = X[ri*dim + d];
            centroids[cOff+d] = neu;
            const dd = neu - old; shift += dd*dd;
          }
          continue;
        }
        for (let d=0; d<dim; d++) {
          const old = centroids[cOff+d];
          const neu = sums[cOff+d] / counts[c];
          centroids[cOff+d] = neu;
          const dd = neu - old; shift += dd*dd;
        }
      }

      if (shift < tol) { prevShift = shift; break; }
      prevShift = shift;
    }

    let inertia = 0;
    for (let i=0;i<n;i++) {
      const c = assignments[i];
      inertia += sqrDist(X, i*dim, centroids, c*dim, dim);
    }

    return {
      centroids: new Float32Array(centroids),
      assignments,
      inertia,
      counts
    };
  }

  function computeGlobalMean(X, n, dim) {
    const mean = new Float64Array(dim);
    for (let i=0;i<n;i++) {
      const off = i*dim;
      for (let d=0; d<dim; d++) mean[d] += X[off+d];
    }
    for (let d=0; d<dim; d++) mean[d] /= n;
    return mean;
  }

  function computeCH(X, n, dim, centroids, assignments, counts) {
    const k = counts.length;
    const mean = computeGlobalMean(X, n, dim);
    let B = 0;
    for (let c=0;c<k;c++) {
      const cOff = c*dim;
      const w = counts[c];
      if (w <= 0) continue;
      let d2 = 0;
      for (let d=0; d<dim; d++) {
        const dd = centroids[cOff+d] - mean[d];
        d2 += dd*dd;
      }
      B += w * d2;
    }
    let W = 0;
    for (let i=0;i<n;i++) {
      const c = assignments[i];
      const cOff = c*dim;
      W += sqrDist(X, i*dim, centroids, cOff, dim);
    }
    const ch = (W === 0 || k === 1 || n === k) ? 0 : (B*(n-k)) / (W*(k-1));
    return ch;
  }

  function sampleIndices(n, limit, rand=Math.random) {
    if (!limit || limit >= n) {
      const a = new Array(n); for (let i=0;i<n;i++) a[i]=i; return a;
    }
    const res = new Array(limit);
    let i=0;
    for (; i<limit; i++) res[i]=i;
    for (; i<n; i++) {
      const j = Math.floor(rand()*(i+1));
      if (j < limit) res[j] = i;
    }
    return res;
  }

  function computeDB(X, n, dim, centroids, assignments, counts, sampleLimit=2000, rand=Math.random) {
    const k = counts.length;
    const Si = new Float64Array(k).fill(0);
    const denom = new Int32Array(k).fill(0);
    const idxs = sampleIndices(n, sampleLimit, rand);
    for (const i of idxs) {
      const c = assignments[i];
      const cOff = c*dim;
      const dist = euDist(X, i*dim, centroids, cOff, dim);
      Si[c] += dist;
      denom[c] += 1;
    }
    for (let c=0;c<k;c++) Si[c] = denom[c] ? (Si[c]/denom[c]) : 0;

    const RijMax = new Float64Array(k).fill(0);
    for (let i=0;i<k;i++){
      for (let j=0;j<k;j++){
        if (i===j) continue;
        const dij = euDist(centroids, i*dim, centroids, j*dim, dim);
        if (dij === 0) continue;
        const Rij = (Si[i] + Si[j]) / dij;
        if (Rij > RijMax[i]) RijMax[i] = Rij;
      }
    }
    let sum=0, valid=0;
    for (let i=0;i<k;i++){
      if (isFinite(RijMax[i])) { sum += RijMax[i]; valid++; }
    }
    return valid ? (sum/valid) : Infinity;
  }

  function computeSilhouette(X, n, dim, assignments, k, sampleLimit=1500, rand=Math.random) {
    const idxs = sampleIndices(n, sampleLimit, rand);
    const byCluster = Array.from({length:k}, ()=>[]);
    for (const i of idxs) byCluster[assignments[i]].push(i);

    let sumS = 0, countS = 0;
    for (const i of idxs) {
      const ci = assignments[i];
      const same = byCluster[ci];
      let a=0, na=0;
      for (const j of same) {
        if (j === i) continue;
        a += euDist(X, i*dim, X, j*dim, dim);
        na++;
      }
      a = na ? (a/na) : 0;

      let b = Infinity;
      for (let c=0;c<k;c++) {
        if (c === ci) continue;
        const others = byCluster[c];
        if (!others.length) continue;
        let sum=0;
        for (const j of others) sum += euDist(X, i*dim, X, j*dim, dim);
        const mean = sum / others.length;
        if (mean < b) b = mean;
      }
      if (!isFinite(b)) continue;
      const s = (b - a) / Math.max(a, b, 1e-12);
      sumS += s;
      countS++;
    }
    return countS ? (sumS / countS) : 0;
  }

  async function runRange(Xflat, nRows, dim, options) {
    const Kmin = Math.max(2, options && options.Kmin || 2);
    const Kmax = Math.max(Kmin, options && options.Kmax || 8);
    const nInit = Math.max(1, options && options.nInit || 5);
    const maxIter = options && options.maxIter || 200;
    const tol = options && options.tol || 1e-4;
    const silhouetteSample = options && options.silhouetteSample || 1500;
    const seed = (options && options.randomSeed != null) ? (options.randomSeed>>>0) : null;

    const results = [];
    const rand = seed != null ? rng(seed) : Math.random;

    for (let K=Kmin; K<=Kmax; K++) {
      let best = null;
      for (let it=0; it<nInit; it++) {
        const r = lloydKMeans(Xflat, nRows, dim, K, { maxIter, tol, rand, init:'kmeans++' });
        if (!best || r.inertia < best.inertia) best = r;
      }
      const silhouette = computeSilhouette(Xflat, nRows, dim, best.assignments, K, silhouetteSample, rand);
      const ch = computeCH(Xflat, nRows, dim, best.centroids, best.assignments, best.counts);
      const db = computeDB(Xflat, nRows, dim, best.centroids, best.assignments, best.counts, Math.min(2000, nRows), rand);

      results.push({
        K,
        inertia: best.inertia,
        silhouette,
        ch,
        db,
        centroids: best.centroids,
        sizes: new Int32Array(best.counts)
      });

      await new Promise(r=>setTimeout(r,0));
    }
    return results;
  }

  window.kmeansEvaluator = { runRange };
})();