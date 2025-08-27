let mediaRecorder;
let audioChunks = [];
let recordings = []; // Array para histórico

const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status');
const audioPlayer = document.getElementById('audio-player');
const playWaveBtn = document.getElementById('play-wave-btn');
const recordIndicator = document.getElementById('record-indicator');
const waveform = document.getElementById('waveform');

let audioCtx, analyser, sourceNode, animationId, liveStream;

recordBtn.addEventListener('click', async () => {
  audioChunks = [];
  statusText.textContent = "Gravando...";
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  recordIndicator.style.display = "block";
  waveform.style.display = "block";

  liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaStreamSource(liveStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  sourceNode.connect(analyser);

  drawLiveWaveform();

  mediaRecorder = new MediaRecorder(liveStream);

  mediaRecorder.ondataavailable = e => {
    audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    recordings.push({ url, blob, date: new Date() });
    if (typeof window.renderHistory === "function") {
      window.renderHistory(recordings);
    } else {
      console.error("window.renderHistory não está definida");
    }
    statusText.textContent = "Gravação salva!";
    audioPlayer.src = url;
    audioPlayer.style.display = "block";
    playWaveBtn.disabled = false;
    audioPlayer.load();

    recordIndicator.style.display = "none";
    waveform.style.display = "none";

    if (audioCtx) audioCtx.close();
    if (liveStream) {
      liveStream.getTracks().forEach(track => track.stop());
      liveStream = null;
    }
    cancelAnimationFrame(animationId);
  };

  mediaRecorder.start();
});

stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    statusText.textContent = "Parado.";
  }
});

playWaveBtn.addEventListener('click', () => {
  if (audioPlayer.src) {
    window.showWaveform(audioPlayer.src);
  }
});

function drawLiveWaveform() {
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
      const y = (dataArray[idx] / 255.0) * height;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.strokeStyle = "#ff3333";
    ctx.lineWidth = 2;
    ctx.stroke();
    animationId = requestAnimationFrame(draw);
  }
  draw();
}