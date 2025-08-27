function showWaveform(audioUrl) {
  const waveform = document.getElementById('waveform');
  waveform.style.display = "block";
  const ctx = waveform.getContext('2d');
  ctx.clearRect(0, 0, waveform.width, waveform.height);

  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  fetch(audioUrl)
    .then(res => res.arrayBuffer())
    .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      const rawData = audioBuffer.getChannelData(0); // Canal 0
      const samples = 400; // Quantidade de pontos para desenhar
      const blockSize = Math.floor(rawData.length / samples);
      const filteredData = [];
      for (let i = 0; i < samples; i++) {
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum += Math.abs(rawData[(i * blockSize) + j]);
        }
        filteredData.push(sum / blockSize);
      }
      // Normalizar para altura do canvas
      const max = Math.max(...filteredData);
      ctx.beginPath();
      filteredData.forEach((val, i) => {
        const x = i;
        const y = waveform.height - (val / max * waveform.height);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#0077cc";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
}