// waveform.js - desenha espectro/forma de onda de uma URL de áudio
// expõe window.showWaveform(audioUrl) que desenha no canvas #waveform

window.showWaveform = function(audioUrl) {
  const waveform = document.getElementById('waveform');
  if (!audioUrl) {
    waveform.style.display = 'none';
    return;
  }
  waveform.style.display = 'block';
  const ctx = waveform.getContext('2d');
  ctx.clearRect(0, 0, waveform.width, waveform.height);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  fetch(audioUrl)
    .then(res => res.arrayBuffer())
    .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      const rawData = audioBuffer.getChannelData(0); // canal esquerdo/0
      const samples = Math.min(800, rawData.length); // pontos máximos (limitar)
      const blockSize = Math.floor(rawData.length / samples) || 1;
      const filteredData = [];
      for (let i = 0; i < samples; i++) {
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum += Math.abs(rawData[i * blockSize + j] || 0);
        }
        filteredData.push(sum / blockSize);
      }
      // normaliza
      const max = Math.max(...filteredData) || 1;
      const width = waveform.width;
      const height = waveform.height;
      ctx.clearRect(0, 0, width, height);
      ctx.beginPath();
      filteredData.forEach((val, i) => {
        const x = Math.floor(i * width / filteredData.length);
        const y = height - Math.round((val / max) * height);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#0077cc";
      ctx.lineWidth = 2;
      ctx.stroke();
    })
    .catch(err => {
      console.error('Erro ao desenhar waveform:', err);
      waveform.style.display = 'none';
    });
};