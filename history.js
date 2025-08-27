// history.js - renderiza a barra de histórico (topo).
// NÃO declare elementos globais compartilhados aqui.
// A função renderHistory cria itens clicáveis que chamam window.onSelectRecording(index).

window.renderHistory = function(recordings, currentIdx = -1) {
  const bar = document.getElementById('history-bar');
  bar.innerHTML = '';
  recordings.forEach((rec, idx) => {
    const item = document.createElement('div');
    item.className = 'history-item' + (idx === currentIdx ? ' selected' : '');
    item.dataset.idx = idx;
    const timeLabel = new Date(rec.date).toLocaleTimeString();
    item.textContent = `${timeLabel}`;
    item.addEventListener('click', () => {
      if (typeof window.onSelectRecording === 'function') {
        window.onSelectRecording(idx);
      } else {
        console.warn('onSelectRecording não definida ainda.');
      }
    });
    bar.appendChild(item);
  });
};