// ui-analyzer.js — versão instrumentada com diagnóstico pré e pós PCA.
// Principais adições:
//  - Expondo window.uiAnalyzer.setTrainPool(ids) para restaurar train pool de uma sessão
//  - Substituição do botão "Rem" por ícone de lixeira (🗑️) na lista do Train Pool
// OBS: alterações intencionais e mínimas; lógica original preservada.

(function () {
  'use strict';

  const trainPool = [];
  function $(sel) { return document.querySelector(sel); }

  function formatSeconds(s) {
    if (!isFinite(s)) return '0.000s';
    return s.toFixed(3) + 's';
  }

  /* ========== MODAL FEATURES (já existente) ========== */
  function createModal() {
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
    trainPool.forEach((rid) => {
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
      meta.textContent = rec ? formatSeconds((new Date(rec.date).getTime()/1000)%60) : '';
      left.appendChild(meta);
      item.appendChild(left);
      const right = document.createElement('div');
      // substituir botão "Rem" por ícone lixeira (mínima mudança visual)
      const rem = document.createElement('button');
      rem.className = 'small';
      rem.innerHTML = '🗑️';
      rem.title = 'Remover';
      rem.onclick = () => {
        const i = trainPool.indexOf(rid);
        if (i>=0) trainPool.splice(i,1);
        renderTrainList();
      };
      right.appendChild(rem);
      item.appendChild(right);
      container.appendChild(item);
    });
    if (!trainPool.length) {
      container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma gravação no conjunto de treino</div>';
    }
  }

  function showModalSummary(result, rec) {
    const modal = createModal();
    const content = modal.querySelector('#analyzer-modal-content');
    const addBtn = modal.querySelector('#analyzer-add-to-train');
    if (!result || !result.meta) {
      content.innerHTML = '<div>Extração falhou ou vazia.</div>';
      addBtn.disabled = true;
      return;
    }
    const meta = result.meta;
    const frames = meta.frames;
    const dims = meta.dims;
    let meanMelSum = 0;
    let meanRMS = 0;
    const dimsNmel = meta.nMels || (dims - 3);
    for (let f = 0; f < frames; f++) {
      let idx = f * dims;
      let melSum = 0;
      for (let m=0;m<dimsNmel;m++) melSum += result.features[idx+m];
      meanMelSum += melSum;
      meanRMS += result.features[idx + dimsNmel];
    }
    if (frames>0){
      meanMelSum /= frames;
      meanRMS /= frames;
    }
    const ts = [];
    const nShow = Math.min(6, frames);
    for (let i=0;i<nShow;i++) ts.push(result.timestamps[i].toFixed(3)+'s');

    content.innerHTML = `
      <div><b>Nome:</b> ${rec ? (rec.name||'') : ''}</div>
      <div><b>Frames:</b> ${frames} &nbsp; <b>Dims:</b> ${dims} &nbsp; <b>nMels:</b> ${dimsNmel}</div>
      <div><b>Média mel energy sum:</b> ${meanMelSum.toFixed(3)}</div>
      <div><b>Média RMS:</b> ${meanRMS.toFixed(6)}</div>
      <div style="margin-top:6px;"><b>Timestamps iniciais:</b> ${ts.join(', ')}</div>
    `;

    addBtn.disabled = false;
    addBtn.onclick = () => {
      const idToAdd = rec && rec.id ? rec.id : ('TMP__'+Date.now());
      if (trainPool.indexOf(idToAdd) === -1) {
        trainPool.push(idToAdd);
        renderTrainList();
      }
      modal.remove();
    };
  }

  function getCurrentRecording() {
    try {
      const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings||[]);
      const audioEl = document.getElementById('audio-player');
      const src = audioEl && audioEl.src ? audioEl.src : null;
      if (src){
        for (const r of recs) if (r && r.url === src) return r;
      }
      const sel = document.querySelector('#recordings-list .recording-item.selected .recording-name');
      if (sel){
        const name = sel.textContent.trim();
        const found = recs.find(r => r && r.name === name);
        if (found) return found;
      }
      return null;
    } catch(e){
      return null;
    }
  }

  async function onAnalyzeClicked() {
    try {
      const rec = getCurrentRecording();
      if (!rec) { alert('Nenhuma gravação selecionada.'); return; }
      if (!window.analyzer || !window.analyzer.extractFeatures) {
        alert('analyzer.js não carregado.');
        return;
      }
      const modal = createModal();
      const content = modal.querySelector('#analyzer-modal-content');
      content.textContent = 'Extraindo features...';
      try {
        const result = await window.analyzer.extractFeatures(rec.blob || rec.url, {});
        rec.__featuresCache = result;
        showModalSummary(result, rec);
      } catch(err) {
        console.error(err);
        content.innerHTML = `<div style="color:red;">Erro: ${err&&err.message?err.message:err}</div>`;
      }
    } catch(err){
      console.error('onAnalyzeClicked erro:', err);
    }
  }

  /* ========== PCA HANDLER COM DIAGNÓSTICO ========== */

  async function runPCAHandler() {
    if (!window.runIncrementalPCAOnTrainPool) {
      alert('pca-incremental.js não carregado.');
      return;
    }
    if (!trainPool.length) {
      alert('Train Pool vazio.');
      return;
    }

    const modal = document.getElementById('pca-modal') || createPCAModal();
    modal.querySelector('.pca-body').innerHTML = 'Preparando diagnóstico pré-PCA...';
    modal.style.display = 'block';

    let preDiag = null;
    try {
      if (!window.pcaDiagnostics || !window.pcaDiagnostics.collectPre){
        modal.querySelector('.pca-body').innerHTML = '<span style="color:#c00;">pca-diagnostics.js não carregado.</span>';
        return;
      }
      preDiag = await window.pcaDiagnostics.collectPre(trainPool);
    } catch (errPre){
      console.warn('Diagnóstico pré-PCA falhou:', errPre);
      modal.querySelector('.pca-body').innerHTML =
        `<div style="color:#c00;">Falha ao coletar diagnóstico pré-PCA: ${errPre.message||errPre}</div>`;
      return;
    }

    // Render bloco pré-PCA + placeholder de progresso
    modal.querySelector('.pca-body').innerHTML = renderPreDiagHTML(preDiag) +
      `<div id="pca-train-progress" style="margin-top:10px;">Treinando PCA incremental...</div>`;

    // Agora treina
    let model = null;
    try {
      model = await window.runIncrementalPCAOnTrainPool((prog)=>{
        const pct = Math.min(100, Math.round(prog*100));
        const el = document.getElementById('pca-train-progress');
        if (el) el.textContent = `Treinando PCA incremental... ${pct}%`;
      });
    } catch (errTrain){
      console.error('Erro durante treino PCA:', errTrain);
      const el = document.getElementById('pca-train-progress');
      if (el) el.innerHTML = `<span style="color:red;">Erro no treino: ${errTrain.message||errTrain}</span>`;
      return;
    }

    // Render seção de resultados PCA (já existente) + diag pós
    try {
      const ev = Array.from(model.explainedVariance).map(v=> Number.isFinite(v)?(v*100).toFixed(2)+'%':'0.00%');
      const cum = Array.from(model.cumulativeVariance).map(v=> Number.isFinite(v)?(v*100).toFixed(2)+'%':'0.00%');

      const resultHTML = `
        <div style="margin-top:14px;border-top:1px solid #eee;padding-top:10px;">
          <div><b>Componentes:</b> ${model.k}</div>
          <div><b>Dimensão original:</b> ${model.d}</div>
          <div><b>Frames usados:</b> ${model.framesUsed} &nbsp; <b>Ignorados (silêncio):</b> ${model.framesSkipped}</div>
          <div style="margin-top:6px;"><b>Variância explicada (%):</b></div>
          <div style="font-size:12px;">${ev.join(' | ')}</div>
          <div style="margin-top:6px;"><b>Acumulada (%):</b></div>
          <div style="font-size:12px;">${cum.join(' | ')}</div>
          <canvas id="pca-variance-chart" width="480" height="140" style="margin-top:10px;border:1px solid #eee;border-radius:6px;"></canvas>
        </div>
      `;

      const progressEl = document.getElementById('pca-train-progress');
      if (progressEl) {
        progressEl.insertAdjacentHTML('afterend', resultHTML);
        progressEl.remove();
      } else {
        modal.querySelector('.pca-body').insertAdjacentHTML('beforeend', resultHTML);
      }

      drawVarianceChart(
        document.getElementById('pca-variance-chart'),
        model.explainedVariance,
        model.cumulativeVariance
      );

      // Pós diag
      let postDiag = null;
      try {
        postDiag = window.pcaDiagnostics.collectPost(model, preDiag);
      } catch (errPost){
        console.warn('Diagnóstico pós-PCA falhou:', errPost);
      }

      if (postDiag){
        modal.querySelector('.pca-body').insertAdjacentHTML(
          'beforeend',
          renderPostDiagHTML(postDiag)
        );
      }

      // Rodapé com instruções
      modal.querySelector('.pca-body').insertAdjacentHTML(
        'beforeend',
        `<div style="margin-top:10px;font-size:12px;">
           Modelo em <code>window._pcaModel</code> | Diagnósticos em <code>window._pcaDiagnostics</code><br/>
           Projete: <code>window.pcaModel.transformFeaturesFlat(flat, frames, dims)</code>
         </div>`
      );

    } catch (errRender){
      console.error('Erro ao renderizar pós PCA:', errRender);
    }
  }

  /* ---------- Render Helpers para diagnóstico ---------- */

  function renderPreDiagHTML(pre){
    if (!pre) return '<div style="color:#c00;">Sem dados pré-PCA.</div>';
    const r = pre.rms;
    const ms = pre.melSum;
    const ds = pre.dimStats;

    function warnList(arr){
      if (!arr || !arr.length) return '<em>(nenhum)</em>';
      return '<ul style="margin:4px 0 0 16px;padding:0;">' +
        arr.map(w=>`<li style="font-size:11px;color:#a33;">${escapeHTML(w)}</li>`).join('') +
        '</ul>';
    }

    return `
      <div style="margin-bottom:10px;">
        <h4 style="margin:0 0 6px 0;font-size:14px;">Diagnóstico (pré-PCA)</h4>
        <div style="font-size:12px;line-height:1.4;">
          <b>Gravações:</b> ${pre.recordings} &nbsp; <b>Frames totais:</b> ${pre.framesTotal}<br/>
          <b>Dims:</b> ${pre.dims} &nbsp; <b>nMels:</b> ${pre.nMels}<br/>
          <b>RMS</b> (min/max/mean): ${r.min.toExponential(3)} / ${r.max.toExponential(3)} / ${r.mean.toExponential(3)}<br/>
          <b>RMS%</b> &lt;0.001:${r.pctBelow['0.001']}% &nbsp; &lt;0.005:${r.pctBelow['0.005']}% &nbsp;
          &lt;0.01:${r.pctBelow['0.01']}% &nbsp; &lt;0.02:${r.pctBelow['0.02']}%<br/>
          <b>melSum</b> (min/max/mean): ${ms.min.toExponential(3)} / ${ms.max.toExponential(3)} / ${ms.mean.toExponential(3)}<br/>
          <b>Variância dims:</b> zero=${ds.zeroVarCount} &nbsp; meanVar=${ds.meanVar.toExponential(3)}<br/>
          <b>Top var</b>: ${ds.topVar.map(t=>`${t.dim}:${t.var}`).join(', ') || '(vazio)'}<br/>
          <b>Low var (&gt;0)</b>: ${ds.lowVar.map(t=>`${t.dim}:${t.var}`).join(', ') || '(vazio)'}<br/>
          <b>Avisos:</b> ${warnList(pre.warnings)}
        </div>
      </div>
    `;
  }

  function renderPostDiagHTML(post){
    const cn = post.componentNorms;
    function warnList(arr){
      if (!arr || !arr.length) return '<em>(nenhum)</em>';
      return '<ul style="margin:4px 0 0 16px;padding:0;">' +
        arr.map(w=>`<li style="font-size:11px;color:#a33;">${escapeHTML(w)}</li>`).join('') +
      '</ul>';
    }
    const projHTML = post.projections.frames.map(fr => {
      const vals = Array.from(fr.values).slice(0, Math.min(8, fr.values.length))
        .map(v=>v.toExponential(2)).join(', ');
      return `<div style="font-size:11px;">Frame ${fr.index}: [${vals}${fr.values.length>8?', ...':''}]</div>`;
    }).join('');

    return `
      <div style="margin-top:14px;border-top:1px solid #eee;padding-top:10px;">
        <h4 style="margin:0 0 6px 0;font-size:14px;">Diagnóstico (pós-PCA)</h4>
        <div style="font-size:12px;line-height:1.4;">
          <b>Normas comp.</b> (min/max/mean): ${cn.min.toExponential(3)} / ${cn.max.toExponential(3)} / ${cn.mean.toExponential(3)}<br/>
          <b>Degeneradas:</b> ${cn.degenerate}<br/>
          <b>Soma variância explicada:</b> ${(post.sumExplained*100).toFixed(2)}%<br/>
          <b>Projeções (amostras):</b><br/>${projHTML || '(sem amostras)'}<br/>
          <b>Avisos:</b> ${warnList(post.warnings)}
        </div>
      </div>
    `;
  }

  function escapeHTML(s){
    return String(s).replace(/[&<>"']/g, c=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  /* ---------- Variance Chart (já existia) ---------- */
  function drawVarianceChart(canvas, explained, cumulative){
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h=canvas.height;
    ctx.clearRect(0,0,w,h);
    const k = explained.length;
    const maxVal = Math.max(...explained, 0.0001);
    const barW = Math.max(8, Math.floor((w-40)/k) - 4);

    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(30,10);
    ctx.lineTo(30,h-25);
    ctx.lineTo(w-10,h-25);
    ctx.stroke();

    for (let i=0;i<k;i++){
      const val = explained[i];
      const bh = (val / maxVal) * (h - 50);
      const x = 30 + i*(barW+4);
      const y = (h-25) - bh;
      ctx.fillStyle = 'rgba(123,63,228,0.55)';
      ctx.fillRect(x,y,barW,bh);
    }

    ctx.beginPath();
    for (let i=0;i<k;i++){
      const val = cumulative[i];
      const xCenter = 30 + i*(barW+4) + barW/2;
      const y = (h-25) - val*(h-50);
      if (i===0) ctx.moveTo(xCenter,y); else ctx.lineTo(xCenter,y);
    }
    ctx.strokeStyle = '#ff5555';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#222';
    ctx.font = '10px sans-serif';
    for (let i=0;i<k;i++){
      const valPct = (explained[i]*100).toFixed(1)+'%';
      const val = explained[i];
      const bh = (val / maxVal) * (h - 50);
      const x = 30 + i*(barW+4);
      const y = (h-25) - bh - 4;
      if (bh > 12) {
        ctx.save();
        ctx.fillStyle='#fff';
        ctx.fillText(valPct, x+2, y+10);
        ctx.restore();
      } else {
        ctx.fillText(valPct, x, y);
      }
    }
  }

  function createPCAModal() {
    const existing = document.getElementById('pca-modal');
    if (existing) existing.remove();
    const m = document.createElement('div');
    m.id = 'pca-modal';
    m.className = 'analyzer-modal';
    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('div');
    title.textContent = 'PCA Incremental';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'small';
    closeBtn.textContent = '✖';
    closeBtn.onclick = () => m.remove();
    header.appendChild(title);
    header.appendChild(closeBtn);
    const body = document.createElement('div');
    body.className = 'modal-body pca-body';
    body.textContent = '...';
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const close2 = document.createElement('button');
    close2.className = 'small';
    close2.textContent = 'Fechar';
    close2.onclick = () => m.remove();
    actions.appendChild(close2);
    m.appendChild(header);
    m.appendChild(body);
    m.appendChild(actions);
    document.body.appendChild(m);
    return m;
  }

  /* ---------- Handlers / Inicialização ---------- */

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
    const pcaBtn = document.getElementById('run-pca-btn');
    if (pcaBtn && !pcaBtn.__pca_bound) {
      pcaBtn.addEventListener('click', runPCAHandler);
      pcaBtn.__pca_bound = true;
    }
    renderTrainList();
  }

  window.uiAnalyzer = window.uiAnalyzer || {};
  // expor API mínima: getTrainPool e setTrainPool (para persistência/recuperação)
  window.uiAnalyzer.getTrainPool = () => Array.from(trainPool);
  window.uiAnalyzer.addToTrainPool = (id) => { if (id && trainPool.indexOf(id) === -1) { trainPool.push(id); renderTrainList(); } };
  window.uiAnalyzer.removeFromTrainPool = (id) => { const i = trainPool.indexOf(id); if (i >= 0) { trainPool.splice(i, 1); renderTrainList(); } };
  window.uiAnalyzer.setTrainPool = (ids) => {
    try {
      if (!Array.isArray(ids)) return;
      trainPool.length = 0;
      for (const id of ids) {
        if (id === undefined || id === null) continue;
        if (trainPool.indexOf(id) === -1) trainPool.push(id);
      }
      renderTrainList();
    } catch (e) {
      console.warn('uiAnalyzer.setTrainPool falhou:', e);
    }
  };

  try { attachHandlers(); } catch(e){ console.warn('ui-analyzer init error:', e); }

})();