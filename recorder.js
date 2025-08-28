// recorder.js — HiDPI, offscreen scaling do espectrograma, tenta carregar worker externo (fallback inline)
// Cole este arquivo no lugar do seu recorder.js atual.

let mediaRecorder;
let audioChunks = [];
let recordings = [];
let currentIdx = -1;

const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const statusText = document.getElementById('status');
const audioPlayer = document.getElementById('audio-player');
const waveform = document.getElementById('waveform');
const spectrogramCanvas = document.getElementById('spectrogram');

const processingIndicator = document.getElementById('processing-indicator');
const processingProgress = document.getElementById('processing-progress');

let audioCtx, analyser, sourceNode, animationId, liveStream;
let spectrogramWorker = null;

window.processingOptions = {
  agc: {
    targetRMS: 0.08,
    maxGain: 8,
    limiterThreshold: 0.99
  },
  spectrogram: {
    fftSize: 2048,
    hopSize: 512,
    nMels: 64,
    windowType: 'hann',
    colormap: 'viridis'
  }
};

// Vendor FFT (used for inline fallback)
const _vendorFFT = `(function(){class FFT{constructor(n){if(!Number.isInteger(Math.log2(n)))throw new Error('FFT size must be power of 2');this.n=n;this._buildReverseTable();this._buildTwiddles();}_buildReverseTable(){const n=this.n;const bits=Math.log2(n);this.rev=new Uint32Array(n);for(let i=0;i<n;i++){let x=i;let y=0;for(let j=0;j<bits;j++){y=(y<<1)|(x&1);x>>=1;}this.rev[i]=y;}}_buildTwiddles(){const n=this.n;this.cos=new Float32Array(n/2);this.sin=new Float32Array(n/2);for(let i=0;i<n/2;i++){const angle=-2*Math.PI*i/n;this.cos[i]=Math.cos(angle);this.sin[i]=Math.sin(angle);}}transform(real,imag){const n=this.n;const rev=this.rev;for(let i=0;i<n;i++){const j=rev[i];if(j>i){const tr=real[i];real[i]=real[j];real[j]=tr;const ti=imag[i];imag[i]=imag[j];imag[j]=ti;}}for(let size=2;size<=n;size<<=1){const half=size>>>1;const step=this.n/size;for(let i=0;i<n;i+=size){let k=0;for(let j=i;j<i+half;j++){const cos=this.cos[k];const sin=this.sin[k];const l=j+half;const tre=cos*real[l]-sin*imag[l];const tim=cos*imag[l]+sin*real[l];real[l]=real[j]-tre;imag[l]=imag[j]-tim;real[j]+=tre;imag[j]+=tim;k+=step;}}}}}if(typeof self!=='undefined')self.FFT=FFT;if(typeof window!=='undefined')window.FFT=FFT;})();`;

// Worker core (inline fallback)
const _workerCode = `(function(){
  function hannWindow(size){const w=new Float32Array(size);if(size===1){w[0]=1.0;return w;}for(let i=0;i<size;i++){w[i]=0.5*(1-Math.cos((2*Math.PI*i)/(size-1)));}return w;}
  function hzToMel(f){return 2595*Math.log10(1+f/700);}
  function melToHz(m){return 700*(Math.pow(10,m/2595)-1);}
  function createMelFilterbank(nMels,fftSize,sampleRate,fmin,fmax){
    fmax=fmax||sampleRate/2;if(fmin<0)fmin=0;
    const melMin=hzToMel(fmin);const melMax=hzToMel(fmax);
    const meltabs=new Float32Array(nMels+2);
    for(let i=0;i<meltabs.length;i++){meltabs[i]=melToHz(melMin+(i/(nMels+1))*(melMax-melMin));}
    const binFreqs=new Float32Array(fftSize/2+1);
    for(let i=0;i<binFreqs.length;i++)binFreqs[i]=i*(sampleRate/fftSize);
    const fb=[];for(let m=0;m<nMels;m++){const lower=meltabs[m];const center=meltabs[m+1];const upper=meltabs[m+2];const filter=new Float32Array(binFreqs.length);const leftDen=(center-lower)||1e-9;const rightDen=(upper-center)||1e-9;for(let k=0;k<binFreqs.length;k++){const f=binFreqs[k];if(f>=lower&&f<=center){filter[k]=(f-lower)/leftDen;}else if(f>=center&&f<=upper){filter[k]=(upper-f)/rightDen;}else{filter[k]=0;}}fb.push(filter);}return fb;
  }
  function applyMelFilterbank(magSpectrum,melFilters){const nMels=melFilters.length;const out=new Float32Array(nMels);for(let m=0;m<nMels;m++){let sum=0;const filter=melFilters[m];for(let k=0;k<filter.length;k++){const f=filter[k];if(f){const v=magSpectrum[k];if(isFinite(v))sum+=v*f;}}out[m]=sum;}return out;}
  function toDb(array,ref=1.0){const out=new Float32Array(array.length);const amin=1e-10;for(let i=0;i<array.length;i++){const val=Math.max(array[i],amin);out[i]=20*Math.log10(val/ref);}return out;}
  function colorMap(v){if(!isFinite(v))v=0;if(v<0)v=0;if(v>1)v=1;const stops=[[68,1,84],[59,82,139],[33,144,140],[94,201,98],[253,231,37]];const t=v*(stops.length-1);const i=Math.floor(t);const frac=t-i;const a=stops[Math.max(0,Math.min(stops.length-1,i))];const b=stops[Math.max(0,Math.min(stops.length-1,i+1))];const r=Math.round(a[0]+(b[0]-a[0])*frac);const g=Math.round(a[1]+(b[1]-a[1])*frac);const bl=Math.round(a[2]+(b[2]-a[2])*frac);return[r,g,bl,255];}
  const fftCache=new Map();
  self.addEventListener('message',function(e){
    const data=e.data;
    if(!data||data.cmd!=='process')return;
    const samples=new Float32Array(data.audioBuffer);
    const sampleRate=data.sampleRate;
    const opts=data.options||{};
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
      if((x%Math.max(1,Math.floor(imgW/30)))===0){self.postMessage({type:'progress',value:0.95+0.05*(x/imgW)});}
    }
    self.postMessage({type:'done',width:imgW,height:imgH,pixels:pixels.buffer},[pixels.buffer]);
  });
})();`;

// Setup message handler from worker
function setupWorkerHandlers(worker) {
  if (!worker) return;
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'progress') {
      const p = Math.round((msg.value || 0) * 100);
      showProcessing(true, p);
    } else if (msg.type === 'done') {
      const pixels = new Uint8ClampedArray(msg.pixels);
      drawSpectrogramPixels(msg.width, msg.height, pixels);
      showProcessing(false, 100);
    } else if (msg.type === 'error') {
      console.warn('Worker error:', msg.message);
      showProcessing(false, 0);
    }
  };
}

// Try to load external worker first; fallback inline if not possible
async function ensureWorker() {
  if (spectrogramWorker) return spectrogramWorker;
  try {
    spectrogramWorker = new Worker('spectrogram.worker.js');
    setupWorkerHandlers(spectrogramWorker);
    console.log('spectrogram: external worker loaded (spectrogram.worker.js).');
    return spectrogramWorker;
  } catch (err) {
    console.warn('spectrogram: external worker load failed, using inline fallback.', err);
    const full = _vendorFFT + "\n" + _workerCode;
    const blob = new Blob([full], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    spectrogramWorker = new Worker(blobUrl);
    setupWorkerHandlers(spectrogramWorker);
    console.log('spectrogram: inline worker created (fallback).');
    return spectrogramWorker;
  }
}

// UI helpers
function showProcessing(show, percent = 0) {
  if (show) {
    processingIndicator.style.display = 'flex';
    processingProgress.textContent = `Processando: ${percent}%`;
  } else {
    processingIndicator.style.display = 'none';
    processingProgress.textContent = 'Processando: 0%';
  }
}

// HiDPI: render em offscreen e escalar para canvas visível (mantém nitidez e ocupa espaço do layout)
function drawSpectrogramPixels(srcWidth, srcHeight, pixels) {
  const dpr = window.devicePixelRatio || 1;

  // escolha a largura visual baseada no container do canvas (mantém layout)
  const container = spectrogramCanvas.parentElement || document.body;
  const containerStyleWidth = container.clientWidth || 940;
  const visualMaxWidth = Math.min(940, containerStyleWidth);
  const visualWidth = visualMaxWidth;
  const aspect = srcHeight / srcWidth;
  const visualHeight = Math.max(80, Math.round(visualWidth * aspect));

  // offscreen no tamanho fonte
  const off = document.createElement('canvas');
  off.width = srcWidth;
  off.height = srcHeight;
  const offCtx = off.getContext('2d');
  offCtx.putImageData(new ImageData(pixels, srcWidth, srcHeight), 0, 0);

  // visible canvas HiDPI
  spectrogramCanvas.width = Math.round(visualWidth * dpr);
  spectrogramCanvas.height = Math.round(visualHeight * dpr);
  spectrogramCanvas.style.width = visualWidth + 'px';
  spectrogramCanvas.style.height = visualHeight + 'px';

  const ctx = spectrogramCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.clearRect(0, 0, visualWidth, visualHeight);
  ctx.drawImage(off, 0, 0, srcWidth, srcHeight, 0, 0, visualWidth, visualHeight);
  spectrogramCanvas.style.display = 'block';
}

// Draw waveform live — use container width (não fixo)
function drawLiveWaveform() {
  if (!analyser) return;
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

    animationId = requestAnimationFrame(draw);
  }
  draw();
}

// AGC, WAV encoder, processAndPlayBlob and rest
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
  return new Blob([view, pcmBytes.buffer], { type: 'audio/wav' });
}

async function processAndPlayBlob(blob) {
  await ensureWorker();
  showProcessing(true, 0);
  try {
    const aCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await aCtx.decodeAudioData(arrayBuffer);
    const sampleRate = audioBuffer.sampleRate;
    const raw = audioBuffer.getChannelData(0);

    const agcOpts = window.processingOptions.agc || {};
    const { processed, gain } = applyAGC(raw, agcOpts.targetRMS, agcOpts.maxGain, agcOpts.limiterThreshold);

    const wavBlob = encodeWAV(processed, sampleRate);
    const url = URL.createObjectURL(wavBlob);
    audioPlayer.src = url;
    audioPlayer.load();

    spectrogramWorker.postMessage({
      cmd: 'process',
      audioBuffer: processed.buffer,
      sampleRate: sampleRate,
      options: window.processingOptions.spectrogram
    }, [processed.buffer]);

    return { url, gain };
  } catch (err) {
    console.error('Erro no processamento do blob:', err);
    showProcessing(false, 0);
    return null;
  }
}

// history and UI interactions
window.onSelectRecording = function(idx) {
  if (idx < 0 || idx >= recordings.length) return;
  currentIdx = idx;
  const rec = recordings[idx];
  audioPlayer.src = rec.url;
  audioPlayer.style.display = 'block';
  audioPlayer.load();
  statusText.textContent = `Selecionado: ${new Date(rec.date).toLocaleString()}`;
  if (typeof window.showWaveform === 'function') window.showWaveform(rec.url);
  processAndPlayBlob(rec.blob);
  if (typeof window.renderHistory === 'function') window.renderHistory(recordings, currentIdx);
};

prevBtn.addEventListener('click', () => {
  if (recordings.length === 0) return;
  const next = currentIdx <= 0 ? 0 : currentIdx - 1;
  window.onSelectRecording(next);
});
nextBtn.addEventListener('click', () => {
  if (recordings.length === 0) return;
  const next = currentIdx >= recordings.length - 1 ? recordings.length - 1 : (currentIdx === -1 ? recordings.length - 1 : currentIdx + 1);
  window.onSelectRecording(next);
});

recordBtn.addEventListener('click', async () => {
  audioChunks = [];
  statusText.textContent = "Gravando...";
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  recordBtn.classList.add('active');

  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusText.textContent = "Permissão de microfone negada.";
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.classList.remove('active');
    console.error(err);
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(liveStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  sourceNode.connect(analyser);

  waveform.style.display = 'block';
  spectrogramCanvas.style.display = 'block';
  drawLiveWaveform();

  mediaRecorder = new MediaRecorder(liveStream);
  mediaRecorder.ondataavailable = e => {
    audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    recordings.push({ url, blob, date: new Date() });
    currentIdx = recordings.length - 1;
    if (typeof window.renderHistory === 'function') window.renderHistory(recordings, currentIdx);

    await processAndPlayBlob(blob);

    statusText.textContent = "Gravação salva!";
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.classList.remove('active');

    if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx = null; }
    if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
    cancelAnimationFrame(animationId);
  };

  mediaRecorder.start();
});

stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    statusText.textContent = "Parando...";
  }
});

audioPlayer.addEventListener('play', () => {
  if (audioPlayer.src) {
    if (typeof window.showWaveform === 'function') window.showWaveform(audioPlayer.src);
  }
});

if (typeof window.renderHistory === 'function') {
  window.renderHistory(recordings, currentIdx);
}