// Adicione no início:
const recordIndicator = document.createElement('div');
recordIndicator.id = "record-indicator";
recordIndicator.style.display = "none";
recordIndicator.style.width = "20px";
recordIndicator.style.height = "20px";
recordIndicator.style.borderRadius = "50%";
recordIndicator.style.background = "red";
recordIndicator.style.marginBottom = "10px";
recordIndicator.style.animation = "blink 1s infinite";
document.getElementById('main-section').insertBefore(recordIndicator, recordBtn);

const style = document.createElement('style');
style.textContent = `
@keyframes blink {
  0%, 100% { opacity: 1;}
  50% {opacity: 0.3;}
}
`;
document.head.appendChild(style);

// Ao iniciar gravação:
recordIndicator.style.display = "block";

// Ao parar gravação:
recordIndicator.style.display = "none";

let mediaRecorder;
let audioChunks = [];
let recordings = []; // Array para histórico

const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status');
const audioPlayer = document.getElementById('audio-player');
const playWaveBtn = document.getElementById('play-wave-btn');

recordBtn.addEventListener('click', async () => {
  audioChunks = [];
  statusText.textContent = "Gravando...";
  recordBtn.disabled = true;
  stopBtn.disabled = false;

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = e => {
    audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const url = URL.createObjectURL(blob);
    recordings.push({ url, blob, date: new Date() });
    updateHistory();
    statusText.textContent = "Gravação salva!";
    audioPlayer.src = url;
    audioPlayer.style.display = "block";
    playWaveBtn.disabled = false;
    audioPlayer.load();
  };

  mediaRecorder.start();
});

stopBtn.addEventListener('click', () => {
  mediaRecorder.stop();
  recordBtn.disabled = false;
  stopBtn.disabled = true;
  statusText.textContent = "Parado.";
});

playWaveBtn.addEventListener('click', () => {
  showWaveform(audioPlayer.src);
});

function updateHistory() {
  window.renderHistory(recordings);
}