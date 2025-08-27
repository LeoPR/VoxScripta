// recorder.js - lógica principal de gravação, navegação e seleção
// não redeclare variáveis que possam existir em outros arquivos; apenas use getElementById quando necessário.

let mediaRecorder;
let audioChunks = [];
let recordings = []; // histórico de gravações {url, blob, date}
let currentIdx = -1;

const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const statusText = document.getElementById('status');
const audioPlayer = document.getElementById('audio-player');
const waveform = document.getElementById('waveform');
const spectrogramCanvas = document.getElementById('spectrogram');

let audioCtx, analyser, sourceNode, animationId, liveStream;

// Função que o history.js chamará quando clicar num item
window.onSelectRecording = function(idx) {
  if (idx < 0 || idx >= recordings.length) return;
  currentIdx = idx;
  const rec = recordings[idx];
  // atualiza player
  audioPlayer.src = rec.url;
  audioPlayer.style.display = 'block';
  audioPlayer.load();
  statusText.textContent = `Selecionado: ${new Date(rec.date).toLocaleString()}`;
  // mostra waveform automaticamente
  if (typeof window.showWaveform === 'function') {
    window.showWaveform(rec.url);
  }
  // mostra spectrogram automaticamente (padrões podem ser ajustados via window.spectrogramOptions)
  if (typeof window.showSpectrogram === 'function') {
    window.showSpectrogram(rec.url);
  }
  // atualiza destaque visual do histórico
  if (typeof window.renderHistory === 'function') {
    window.renderHistory(recordings, currentIdx);
  }
};

// navegação anterior/próximo
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

// gravação
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

  // mostra canvas enquanto grava
  waveform.style.display = 'block';
  spectrogramCanvas.style.display = 'block';
  drawLiveWaveform();

  mediaRecorder = new MediaRecorder(liveStream);
  mediaRecorder.ondataavailable = e => {
    audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    recordings.push({ url, blob, date: new Date() });
    // seleciona automaticamente a gravação nova
    currentIdx = recordings.length - 1;
    if (typeof window.renderHistory === 'function') window.renderHistory(recordings, currentIdx);
    // seleciona e mostra
    window.onSelectRecording(currentIdx);

    statusText.textContent = "Gravação salva!";
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.classList.remove('active');

    // limpa/pára o audio context e stream
    if (audioCtx) {
      audioCtx.close().catch(()=>{});
      audioCtx = null;
    }
    if (liveStream) {
      liveStream.getTracks().forEach(t => t.stop());
      liveStream = null;
    }
    cancelAnimationFrame(animationId);
  };

  mediaRecorder.start();
});

// parar
stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    statusText.textContent = "Parando...";
  }
});

// quando clicar no player, exibe a onda e espectrograma também (caso existente)
audioPlayer.addEventListener('play', () => {
  if (audioPlayer.src) {
    if (typeof window.showWaveform === 'function') window.showWaveform(audioPlayer.src);
    if (typeof window.showSpectrogram === 'function') window.showSpectrogram(audioPlayer.src);
  }
});

// desenha waveform em tempo real durante gravação
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
      const v = dataArray[idx] / 128.0; // centered around 1
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

// inicializa renderHistory vazio (apenas para preencher interface)
if (typeof window.renderHistory === 'function') {
  window.renderHistory(recordings, currentIdx);
}