// core/core-audio.js
// Etapa 3: Unificado de audio.js + waveform.js (em ordem).
// Conteúdo original preservado, apenas concatenado.

// ========== Início: audio.js ==========
let spectrogramWorker = null;

// função util para obter opções mescladas
function _getProcessingOptions() {
  if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
    return window.appConfig.getMergedProcessingOptions();
  }
  // fallback para compatibilidade
  return window.processingOptions || {
    agc: { targetRMS: 0.08, maxGain: 8, limiterThreshold: 0.99 },
    spectrogram: { fftSize: 2048, hopSize: 512, nMels: 64, windowType: 'hann', colormap: 'viridis' }
  };
}

// ---------- AGC ----------
function applyAGC(signal, targetRMS = 0.08, maxGain = 8, limiterThreshold = 0.99) {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    sum += v * v;
  }
  const rms = Math.sqrt(sum / Math.max(1, signal.length));
  const eps = 1e-8;
  let gain = targetRMS / (rms + eps);
  if (!isFinite(gain) || gain <= 0) gain = 1;
  if (gain > maxGain) gain = maxGain;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    let v = signal[i] * gain;
    const thr = limiterThreshold;
    if (v > thr) {
      v = thr + (1 - Math.exp(-(v - thr)));
    } else if (v < -thr) {
      v = -thr - (1 - Math.exp(-(-v - thr)));
    }
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    out[i] = v;
  }
  return { processed: out, gain };
}

// ---------- Fade-in ----------
function applyFadeIn(samples, sampleRate, fadeMs = 20) {
  const fadeSamples = Math.max(0, Math.floor((fadeMs / 1000) * sampleRate));
  for (let i = 0; i < fadeSamples && i < samples.length; i++) {
    const gain = i / Math.max(1, fadeSamples);
    samples[i] = samples[i] * gain;
  }
}

// ---------- WAV encoder ----------
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}
function floatTo16BitPCM(float32Array) {
  const l = float32Array.length;
  const buffer = new ArrayBuffer(l * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < l; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s, true);
  }
  return new Uint8Array(buffer);
}
function encodeWAV(samples, sampleRate) {
  const pcmBytes = floatTo16BitPCM(samples);
  const buffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, pcmBytes.length, true);
  const wavBytes = new Uint8Array(buffer, 44);
  wavBytes.set(pcmBytes);
  return new Blob([buffer], { type: 'audio/wav' });
}

// ---------- Spectrogram worker setup (inline fallback) ----------
const _vendorFFT = `(function(){class FFT{constructor(n){if(!Number.isInteger(Math.log2(n)))throw new Error('FFT size must be power of 2');this.n=n;this._buildReverseTable();this._buildTwiddles();}_buildReverseTable(){const n=this.n;const bits=Math.log2(n);this.rev=new Uint32Array(n);for(let i=0;i<n;i++){let x=i;let y=0;for(let j=0;j<bits;j++){y=(y<<1)|(x&1);x>>=1;}this.rev[i]=y;}}_buildTwiddles(){const n=this.n;this.cos=new Float32Array(n/2);this.sin=new Float32Array(n/2);for(let i=0;i<n/2;i++){const angle=-2*Math.PI*i/n;this.cos[i]=Math.cos(angle);this.sin[i]=Math.sin(angle);}}transform(real,imag){const n=this.n;const rev=this.rev;for(let i=0;i<n;i++){const j=rev[i];if(j>i){const tr=real[i];real[i]=real[j];real[j]=tr;const ti=imag[i];imag[i]=imag[j];imag[j]=ti;}}for(let size=2;size<=n;size<<=1){const half=size>>>1;const step=this.n/size;for(let i=0;i<n;i+=size){let k=0;for(let j=i;j<i+half;j++){const cos=this.cos[k];const sin=this.sin[k];const l=j+half;const tre=cos*real[l]-sin*imag[l];const tim=cos*imag[l]+sin*real[l];real[l]=real[j]-tre;imag[l]=imag[j]-tim;real[j]+=tre;imag[j]+=tim;k+=step;}}}}}if(typeof self!=='undefined')self.FFT=FFT;if(typeof window!=='undefined')window.FFT=FFT;})();`;

const _workerCode = `(function(){
  // simplified worker - computes mel spectrogram and posts pixels
  function hannWindow(size){const w=new Float32Array(size);if(size===1){w[0]=1;return w;}for(let i=0;i<size;i++)w[i]=0.5*(1-Math.cos((2*Math.PI*i)/(size-1)));return w;}
  function hzToMel(f){return 2595*Math.log10(1+f/700);}function melToHz(m){return 700*(Math.pow(10,m/2595)-1);}
  function createMelFilterbank(nMels,fftSize,sampleRate,fmin,fmax){fmax=fmax||sampleRate/2;if(fmin<0)fmin=0;const melMin=hzToMel(fmin);const melMax=hzToMel(fmax);const meltabs=new Float32Array(nMels+2);for(let i=0;i<meltabs.length;i++)meltabs[i]=melToHz(melMin+(i/(nMels+1))*(melMax-melMin));const binFreqs=new Float32Array(fftSize/2+1);for(let k=0;k<binFreqs.length;k++)binFreqs[k]=k*(sampleRate/fftSize);const filters=[];for(let m=0;m<nMels;m++){const lower=meltabs[m];const center=meltabs[m+1];const upper=meltabs[m+2];const filter=new Float32Array(binFreqs.length);const leftDen=(center-lower)||1e-9;const rightDen=(upper-center)||1e-9;for(let k=0;k<binFreqs.length;k++){const f=binFreqs[k];if(f>=lower&&f<=center)filter[k]=(f-lower)/leftDen;else if(f>=center&&f<=upper)filter[k]=(upper-f)/rightDen;else filter[k]=0;}filters.push(filter);}return filters;}
  function applyMelFilterbank(magSpectrum,melFilters){const nMels=melFilters.length;const out=new Float32Array(nMels);for(let m=0;m<nMels;m++){let sum=0;const filter=melFilters[m];for(let k=0;k<filter.length;k++){const f=filter[k];if(f){const v=magSpectrum[k];if(isFinite(v))sum+=v*f;}}out[m]=sum;}return out;}
  function toDb(array,ref=1.0){const out=new Float32Array(array.length);const amin=1e-10;for(let i=0;i<array.length;i++){const val=Math.max(array[i],amin);out[i]=20*Math.log10(val/ref);}return out;}
  function colorMap(v){if(!isFinite(v))v=0;if(v<0)v=0;if(v>1)v=1;const stops=[[68,1,84],[59,82,139],[33,144,140],[94,201,98],[253,231,37]];const t=v*(stops.length-1);const i=Math.floor(t);const frac=t-i;const a=stops[Math.max(0,Math.min(stops.length-1,i))];const b=stops[Math.max(0,Math.min(stops.length-1,i+1))];const r=Math.round(a[0]+(b[0]-a[0])*frac);const g=Math.round(a[1]+(b[1]-a[1])*frac);const bl=Math.round(a[2]+(b[2]-a[2])*frac);return[r,g,bl,255];}
  const fftCache=new Map();
  self.addEventListener('message',function(e){
    const data=e.data; if(!data||data.cmd!=='process')return;
    const samples=new Float32Array(data.audioBuffer); const sampleRate=data.sampleRate; const opts=data.options||{};
    const fftSize=opts.fftSize||2048;
    const hopSize=opts.hopSize||512;
    const nMels=Math.max(1,opts.nMels||64);
    const fmin=Math.max(0,opts.fmin||0);
    const fmax=opts.fmax||(sampleRate/2);
    const logScale=(opts.logScale!==undefined)?opts.logScale:true;
    const dynamicRange=opts.dynamicRange||80;
    const windowFunc=hannWindow(fftSize);
    const melFilters=createMelFilterbank(nMels,fftSize,sampleRate,fmin,fmax);
    let frames=Math.max(0,Math.floor((samples.length-fftSize)/hopSize)+1);
    if(frames<=0)frames=1;
    const width=Math.max(1,frames);
    const height=nMels;
    const imgW=Math.min(1200,Math.max(200,width));
    const imgH=Math.min(512,Math.max(100,height));
    const pixels=new Uint8ClampedArray(imgW*imgH*4);
    let fftInstance=null;
    if(typeof self.FFT==='function'){
      fftInstance=fftCache.get(fftSize);
      if(!fftInstance){fftInstance=new self.FFT(fftSize);fftCache.set(fftSize,fftInstance);}
    }
    const re=new Float32Array(fftSize);
    const im=new Float32Array(fftSize);
    const melSpec=new Float32Array(frames*nMels);
    const progressStep=Math.max(1,Math.floor(frames/20));
    for(let f=0;f<frames;f++){
      const offset=f*hopSize;
      for(let i=0;i<fftSize;i++){re[i]=(samples[offset+i]||0)*windowFunc[i];im[i]=0;}
      if(fftInstance){fftInstance.transform(re,im);}else{
        try{
          const outRe=new Float32Array(fftSize);
          const outIm=new Float32Array(fftSize);
          for(let k=0;k<fftSize;k++){let sumRe=0,sumIm=0;for(let n=0;n<fftSize;n++){const angle=-2*Math.PI*k*n/fftSize;const cos=Math.cos(angle),sin=Math.sin(angle);sumRe+=re[n]*cos-im[n]*sin;sumIm+=re[n]*sin+im[n]*cos;}outRe[k]=sumRe;outIm[k]=sumIm;}
          re.set(outRe);im.set(outIm);
        }catch(err){
          for(let m=0;m<nMels;m++)melSpec[f*nMels+m]=0;
          continue;
        }
      }
      const half=Math.floor(fftSize/2)+1;
      const mag=new Float32Array(half);
      for(let k=0;k<half;k++){const rr=re[k],ii=im[k];const mVal=Math.sqrt((isFinite(rr)?rr*rr:0)+(isFinite(ii)?ii*ii:0));mag[k]=isFinite(mVal)?mVal:0;}
      const melFrame=applyMelFilterbank(mag,melFilters);
      for(let m=0;m<nMels;m++)melSpec[f*nMels+m]=isFinite(melFrame[m])?melFrame[m]:0;
      if((f%progressStep)===0){self.postMessage({type:'progress',value:f/frames});}
    }
    self.postMessage({type:'progress',value:0.95});
    let melDb;
    if(logScale){
      let maxVal=0;
      for(let i=0;i<melSpec.length;i++)if(melSpec[i]>maxVal)maxVal=melSpec[i];
      const ref=maxVal>0?maxVal:1.0;
      melDb=toDb(melSpec,ref);
    }else{melDb=new Float32Array(melSpec);}
    let minVal=Infinity,maxVal=-Infinity;
    for(let i=0;i<melDb.length;i++){const v=melDb[i];if(!isFinite(v))continue;if(v<minVal)minVal=v;if(v>maxVal)maxVal=v;}
    if(!isFinite(minVal)||!isFinite(maxVal)){for(let i=0;i<melDb.length;i++)melDb[i]=0;minVal=0;maxVal=1;}
    if(logScale){
      const top=maxVal;const bottom=Math.max(maxVal-dynamicRange,minVal);const denom=(top-bottom)||1e-6;
      for(let i=0;i<melDb.length;i++){let nv=(melDb[i]-bottom)/denom;if(!isFinite(nv))nv=0;if(nv<0)nv=0;if(nv>1)nv=1;melDb[i]=nv;}
    }else{
      const denom=(maxVal-minVal)||1e-6;
      for(let i=0;i<melDb.length;i++){let nv=(melDb[i]-minVal)/denom;if(!isFinite(nv))nv=0;if(nv<0)nv=0;if(nv>1)nv=1;melDb[i]=nv;}
    }
    for(let x=0;x<imgW;x++){
      const frameIdx=Math.min(frames-1,Math.max(0,Math.floor(x*(frames/imgW))));
      const base=frameIdx*nMels;
      for(let y=0;y<imgH;y++){
        const melIdx=Math.floor((1-y/imgH)*(nMels-1));
        const idx=base+melIdx;
        const v=(idx>=0&&idx<melDb.length)?melDb[idx]:0;
        const c=colorMap(v);
        const p=(y*imgW+x)*4;
        pixels[p]=c[0];pixels[p+1]=c[1];pixels[p+2]=c[2];pixels[p+3]=255;
      }
    }
    self.postMessage({type:'done',width:imgW,height:imgH,pixels:pixels.buffer},[pixels.buffer]);
  });
})();`;

// cria worker inline (fallback) ou usa 'spectrogram.worker.js' se disponível
async function ensureWorker() {
  if (spectrogramWorker) return spectrogramWorker;
  try {
    spectrogramWorker = new Worker('spectrogram.worker.js');
    return spectrogramWorker;
  } catch (err) {
    const full = _vendorFFT + "\n" + _workerCode;
    const blob = new Blob([full], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    spectrogramWorker = new Worker(blobUrl);
    return spectrogramWorker;
  }
}

// processAndPlayBlob: aplica AGC, fade-in, gera WAV para player e envia ao worker para espectrograma
async function processAndPlayBlob(blob) {
  const merged = _getProcessingOptions();
  await ensureWorker();
  try {
    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await aCtx.decodeAudioData(arrayBuffer);
    const sampleRate = audioBuffer.sampleRate;
    const raw = audioBuffer.getChannelData(0);

    const agcOpts = merged.agc || {};
    const spectOpts = merged.spectrogram || {};

    const { processed, gain } = applyAGC(raw, agcOpts.targetRMS, agcOpts.maxGain, agcOpts.limiterThreshold);

    // fade-in curto para mitigar spike (usar config)
    applyFadeIn(processed, sampleRate, agcOpts.fadeMs || 20);

    const wavBlob = encodeWAV(processed, sampleRate);
    const url = URL.createObjectURL(wavBlob);

    // postar para worker (tenta transferir buffer)
    try {
      spectrogramWorker.postMessage({
        cmd: 'process',
        audioBuffer: processed.buffer,
        sampleRate: sampleRate,
        options: spectOpts
      }, [processed.buffer]);
    } catch (err) {
      try {
        spectrogramWorker.postMessage({
          cmd: 'process',
          audioBuffer: processed.slice().buffer,
          sampleRate: sampleRate,
          options: spectOpts
        }, [processed.slice().buffer]);
      } catch (e) {
        console.warn('Could not post message to worker:', e);
      }
    }

    aCtx.close().catch(()=>{});
    return { url, gain };
  } catch (err) {
    console.error('Erro processando blob:', err);
    return null;
  }
}

// Export functions globalmente
window.applyAGC = applyAGC;
window.applyFadeIn = applyFadeIn;
window.encodeWAV = encodeWAV;
window.processAndPlayBlob = processAndPlayBlob;
window.ensureWorker = ensureWorker;

// ========== Fim: audio.js ==========


// ========== Início: waveform.js ==========
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