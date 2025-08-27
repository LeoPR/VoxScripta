window.renderHistory = function(recordings) {
  const historyList = document.getElementById('history-list');
  historyList.innerHTML = '';
  recordings.forEach((rec, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${rec.date.toLocaleTimeString()}</span>
      <button data-idx="${idx}">Ouvir</button>
      <button data-wave="${idx}">Ver Onda</button>
    `;
    historyList.appendChild(li);

    li.querySelector('button[data-idx]').onclick = () => {
      const audioPlayer = document.getElementById('audio-player');
      const playWaveBtn = document.getElementById('play-wave-btn');
      audioPlayer.src = rec.url;
      audioPlayer.style.display = "block";
      playWaveBtn.disabled = false;
      document.getElementById('waveform').style.display = "none";
      audioPlayer.load();
    };
    li.querySelector('button[data-wave]').onclick = () => {
      window.showWaveform(rec.url);
    };
  });
};