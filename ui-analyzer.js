// ui-analyzer.js — Passo 1 UI integration for analyzer.extractFeatures
// - Binda o botão #analyze-btn para analisar a gravação visível/selecionada
// - Mostra um modal com resumo das features extraídas
// - Permite "Adicionar ao conjunto de treino" (train pool) à direita
// - Gerencia a lista local de train-pool (em memória)
// Nota: não faz PCA nem KMeans ainda; apenas integração e seleção.

(function () {
  'use strict';

  // train pool state (apenas ids / referências)
  const trainPool = [];

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function formatSeconds(s) {
    if (!isFinite(s)) return '0.000s';
    return s.toFixed(3) + 's';
  }

  function createModal() {
    // remove existing
    const existing = document.getElementById('analyzer-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'analyzer-modal';
    modal.className = 'analyzer-modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('div');
    title.textContent = 'Resumo da Análise (features)';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✖';
    closeBtn.className = 'small';
    closeBtn.onclick = () => modal.remove();
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = '<div id="analyzer-modal-content">Extraindo features...</div>';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const addBtn = document.createElement('button');
    addBtn.id = 'analyzer-add-to-train';
    addBtn.className = 'small btn';
    addBtn.textContent = 'Adicionar ao conjunto de treino';
    addBtn.disabled = true;

    const close2 = document.createElement('button');
    close2.className = 'small';
    close2.textContent = 'Fechar';
    close2.onclick = () => modal.remove();

    actions.appendChild(addBtn);
    actions.appendChild(close2);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(actions);

    document.body.appendChild(modal);
    return modal;
  }

  function renderTrainList() {
    const container = document.getElementById('train-list');
    container.innerHTML = '';
    const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
    trainPool.forEach((rid, idx) => {
      const rec = recs.find(r => r && String(r.id) === String(rid));
      const item = document.createElement('div');
      item.className = 'train-item';
      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      const name = document.createElement('div');
      name.textContent = rec ? (rec.name || `Gravação ${rid}`) : String(rid);
      name.style.fontSize = '13px';
      left.appendChild(name);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = rec ? formatSeconds(new Date(rec.date).getTime() / 1000 % 60) : '';
      left.appendChild(meta);
      item.appendChild(left);

      const right = document.createElement('div');
      const rem = document.createElement('button');
      rem.className = 'small';
      rem.textContent = 'Rem';
      rem.title = 'Remover da lista de treino';
      rem.onclick = () => {
        const i = trainPool.indexOf(rid);
        if (i >= 0) trainPool.splice(i, 1);
        renderTrainList();
      };
      right.appendChild(rem);
      item.appendChild(right);

      container.appendChild(item);
    });
    if (trainPool.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma gravação no conjunto de treino</div>';
    }
  }

  function showModalSummary(result, rec) {
    const modal = createModal();
    const content = modal.querySelector('#analyzer-modal-content');
    const addBtn = modal.querySelector('#analyzer-add-to-train');

    if (!result || !result.meta) {
      content.innerHTML = '<div>Extração falhou ou retornou vazio.</div>';
      addBtn.disabled = true;
      return;
    }

    const meta = result.meta;
    const frames = meta.frames;
    const dims = meta.dims;
    const sampleRate = meta.sampleRate;

    // compute simple stats: mean energy (mel sum) and mean RMS
    let meanMelSum = 0;
    let meanRMS = 0;
    const dimsNmel = meta.nMels || (dims - 3);
    for (let f = 0; f < frames; f++) {
      let idx = f * dims;
      let melSum = 0;
      for (let m = 0; m < dimsNmel; m++) melSum += result.features[idx + m];
      meanMelSum += melSum;
      meanRMS += result.features[idx + dimsNmel];
    }
    if (frames > 0) {
      meanMelSum /= frames;
      meanRMS /= frames;
    }

    const tpls = [];
    tpls.push(`<div><b>Nome:</b> ${rec ? (rec.name || '') : ''}</div>`);
    tpls.push(`<div><b>Duração aprox.:</b> ${formatSeconds((result.timestamps[frames-1] || 0) + (meta.fftSize || 0) / (sampleRate || 1))}</div>`);
    tpls.push(`<div><b>Frames:</b> ${frames} &nbsp; <b>Dims:</b> ${dims} &nbsp; <b>nMels:</b> ${dimsNmel}</div>`);
    tpls.push(`<div><b>SampleRate:</b> ${sampleRate} Hz</div>`);
    tpls.push(`<div style="margin-top:8px;"><b>Estatísticas (médias):</b></div>`);
    tpls.push(`<div>Mean mel energy sum: ${meanMelSum.toFixed(3)}</div>`);
    tpls.push(`<div>Mean RMS: ${meanRMS.toFixed(6)}</div>`);
    tpls.push(`<div style="margin-top:8px;"><b>Timestamps (primeiros frames):</b></div>`);
    const nShow = Math.min(6, frames);
    const ts = [];
    for (let i = 0; i < nShow; i++) ts.push(result.timestamps[i].toFixed(3) + 's');
    tpls.push(`<div>${ts.join(' , ')}</div>`);

    content.innerHTML = tpls.join('\n');

    // enable add button (it will add rec.id or timestamp-based id if missing)
    addBtn.disabled = false;
    addBtn.onclick = () => {
      const idToAdd = rec && rec.id ? rec.id : (`TMP__${Date.now()}`);
      if (trainPool.indexOf(idToAdd) === -1) {
        trainPool.push(idToAdd);
      }
      renderTrainList();
      modal.remove();
    };
  }

  // get current recording visible in player (by matching audio-player.src with rec.url)
  function getCurrentRecording() {
    try {
      const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
      const audioEl = document.getElementById('audio-player');
      const src = audioEl && audioEl.src ? audioEl.src : null;
      if (!src) return null;
      // find by url
      for (const r of recs) {
        if (!r) continue;
        if (r.url && r.url === src) return r;
        // sometimes objectURLs may differ; try to match by blob reference (not reliable)
      }
      // fallback: return selected by class 'selected' in recordings-list
      const selEl = document.querySelector('#recordings-list .recording-item.selected');
      if (selEl) {
        const titleEl = selEl.querySelector('.recording-name');
        const name = titleEl ? titleEl.textContent.trim() : null;
        if (name) {
          const found = recs.find(rr => rr && (rr.name === name));
          if (found) return found;
        }
      }
      return null;
    } catch (e) {
      console.warn('getCurrentRecording error:', e);
      return null;
    }
  }

  async function onAnalyzeClicked() {
    try {
      const rec = getCurrentRecording();
      if (!rec) { alert('Nenhuma gravação selecionada/visível para analisar. Selecione uma gravação primeiro.'); return; }
      if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function') {
        alert('Módulo analyzer (analyzer.js) não encontrado. Coloque analyzer.js antes de ui-analyzer.js e recarregue a página.');
        return;
      }

      // modal
      const modal = createModal();
      const content = modal.querySelector('#analyzer-modal-content');
      content.innerHTML = 'Extraindo features...';
      const source = rec.blob || rec.url;
      try {
        const opts = {}; // default; you may expose UI later to change fftSize/hop/nMels
        const result = await window.analyzer.extractFeatures(source, opts);
        showModalSummary(result, rec);
      } catch (err) {
        console.error('extractFeatures error:', err);
        content.innerHTML = `<div style="color:red;">Erro extraindo features: ${String(err && err.message ? err.message : err)}</div>`;
      }
    } catch (err) {
      console.error('onAnalyzeClicked error:', err);
      alert('Erro ao iniciar análise. Veja console para detalhes.');
    }
  }

  function attachHandlers() {
    const analyzeBtn = document.getElementById('analyze-btn');
    if (analyzeBtn && !analyzeBtn.__analyze_bound) {
      analyzeBtn.addEventListener('click', onAnalyzeClicked);
      analyzeBtn.__analyze_bound = true;
    }

    const clearBtn = document.getElementById('clear-train-btn');
    if (clearBtn && !clearBtn.__clear_bound) {
      clearBtn.addEventListener('click', () => {
        if (!confirm('Limpar todas as gravações do conjunto de treino?')) return;
        trainPool.length = 0;
        renderTrainList();
      });
      clearBtn.__clear_bound = true;
    }

    // initial render
    renderTrainList();
  }

  // init on DOM ready (safe if scripts loaded at end)
  try {
    attachHandlers();
  } catch (err) {
    console.warn('ui-analyzer init error:', err);
  }

  // expose small API to interact from console if needed
  window.uiAnalyzer = window.uiAnalyzer || {};
  window.uiAnalyzer.getTrainPool = () => Array.from(trainPool);
  window.uiAnalyzer.addToTrainPool = (id) => { if (id && trainPool.indexOf(id) === -1) { trainPool.push(id); renderTrainList(); } };
  window.uiAnalyzer.removeFromTrainPool = (id) => { const i = trainPool.indexOf(id); if (i >= 0) { trainPool.splice(i, 1); renderTrainList(); } };

})();