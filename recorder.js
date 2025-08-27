// recorder.js (modificado) - integra AGC + worker de espectrograma + indicador de progresso
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

function ensureWorker() {
  if (spectrogramWorker) return;
  try {
    spectrogramWorker = new Worker('spectrogram.worker.js');
    spectrogramWorker.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'progress') {
        const p = Math.round((msg.value || 0) * 100);
        showProcessing(true, p);
      } else if (msg.type === 'done') {
        const pixels = new Uint8ClampedArray(msg.pixels);
        drawSpectrogramPixels(msg.width, msg.height, pixels);
        showProcessing(false, 100);
      }
    };
  } catch (err) {
    console.warn('Não foi possível criar worker:', err);
    spectrogramWorker = null;
  }
}

function showProcessing(show, percent = 0) {
  if (show) {
    processingIndicator.style.display = 'flex';
    processingProgress.textContent = `Processando: ${percent}%`;
  } else {
    processingIndicator.style.display = 'none';
    processingProgress.textContent = 'Processando: 0%';
  }
}

function drawSpectrogramPixels(width, height, pixels) {
  spectrogramCanvas.width = width;
  spectrogramCanvas.height = height;
  const ctx = spectrogramCanvas.getContext('2d');
  const imageData = new ImageData(pixels, width, height);
  ctx.putImageData(imageData, 0, 0);
  spectrogramCanvas.style.display = 'block';
}

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
  ensureWorker();
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

    if (spectrogramWorker) {
      const transferable = processed.buffer.slice(0);
      spectrogramWorker.postMessage({
        cmd: 'process',
        audioBuffer: transferable,
        sampleRate: sampleRate,
        options: window.processingOptions.spectrogram
      }, [transferable]);
    } else {
      const tmpUrl = URL.createObjectURL(wavBlob);
      if (typeof window.showSpectrogram === 'function') window.showSpectrogram(tmpUrl, window.processingOptions.spectrogram);
    }

    return { url, gain };
  } catch (err) {
    console.error('Erro no processamento do blob:', err);
    showProcessing(false, 0);
    return null;
  }
}

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

function drawLiveWaveform() {
  if (!analyser) return;
  const bufferLength = analyser.fftSize;
  const dataArray = new Uint8Array(bufferLength);
  const width = waveform.width;
  const height = waveform.height;
  const ctx = waveform.getContext('2d');

  function draw() {
    analyser.getByteTimeDomainData(dataArray);
    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const idx = Math.floor(i * bufferLength / width);
      const v = dataArray[idx] / 128.0;
      const y = (v * 0.5) * height;
      const drawY = height / 2 + (y - height / 4);
      if (i === 0) ctx.moveTo(i, drawY);
      else ctx.lineTo(i, drawY);
    }
    ctx.strokeStyle = "#ff3333";
    ctx.lineWidth = 2;
    ctx.stroke();

    animationId = requestAnimationFrame(draw);
  }
  draw();
}

if (typeof window.renderHistory === 'function') {
  window.renderHistory(recordings, currentIdx);
}