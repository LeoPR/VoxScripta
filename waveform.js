// waveform.js - desenha a forma de onda (waveform)
// expõe window.showWaveform(audioUrl)

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
      const rawData = audioBuffer.getChannelData(0); // Canal 0
      const samples = waveform.width; // um ponto por pixel de largura
      const blockSize = Math.floor(rawData.length / samples) || 1;
      const filteredData = [];
      for (let i = 0; i < samples; i++) {
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum += Math.abs(rawData[(i * blockSize) + j] || 0);
        }
        filteredData.push(sum / blockSize);
      }
      const max = Math.max(...filteredData) || 1;
      ctx.beginPath();
      const height = waveform.height;
      filteredData.forEach((val, i) => {
        const x = i;
        const y = height - (val / max * height);
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