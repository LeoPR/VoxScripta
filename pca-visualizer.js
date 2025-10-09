// pca-visualizer.js
// Visualizador de projeções PC1 x PC2 com cache por assinatura do modelo PCA.
// Mudanças principais:
//  - calcula assinatura simples do modelo (modelSignature)
//  - armazena pontos/projeções + bbox (min/max dos eixos) em window._pcaVisualizerCache[signature]
//  - reutiliza cache ao reabrir modal para manter o gráfico idêntico enquanto o modelo não muda
//
// Dependências esperadas (já existentes no seu projeto):
// - window._pcaModel (após rodar o PCA)
// - window.analyzer.extractFeatures (para obter features das gravações)
// - window.getWorkspaceRecordings()
// - window.segmentSilence (ou window.analyzerOverlay.segmentSilence) para filtragem de silêncio
// - window.appConfig.getMergedProcessingOptions() (para configs pca/analyzer)
//
// Uso: incluir <script src="pca-visualizer.js"></script> (já feito)

(function(){
  'use strict';

  const VIS_MODAL_ID = 'pca-vis-modal';
  const VIS_BTN_ID = 'pca-vis-open-btn';
  const PCA_MODAL_ID = 'pca-modal';

  function getCfg() {
    try {
      if (window.appConfig && typeof window.appConfig.getMergedProcessingOptions === 'function') {
        return window.appConfig.getMergedProcessingOptions();
      }
    } catch (_) {}
    return { pca:{}, analyzer:{} };
  }

  // Normalização igual ao treino do PCA incremental
  function normalizeFeatureVector(vec, nMels, sampleRate){
    for (let m = 0; m < nMels; m++) {
      vec[m] = Math.log1p(vec[m]);
    }
    if (!sampleRate) sampleRate = 16000;
    const centroidIdx = nMels+1;
    vec[centroidIdx] = vec[centroidIdx] / (sampleRate/2);
    return vec;
  }

  async function ensureFeatures(rec){
    if (!rec) return null;
    if (rec.__featuresCache) return rec.__featuresCache;
    if (!window.analyzer || typeof window.analyzer.extractFeatures !== 'function')
      throw new Error('analyzer.extractFeatures indisponível');
    const source = rec.blob || rec.url;
    const result = await window.analyzer.extractFeatures(source, {});
    rec.__featuresCache = result;
    return result;
  }

  function getSegmentSilenceFn(){
    return (window.segmentSilence || (window.analyzerOverlay && window.analyzerOverlay.segmentSilence));
  }

  // Gera uma assinatura simples (hash numérico) do modelo PCA para identificar mudanças.
  // Não é criptográfico, mas é determinístico para o mesmo modelo.
  function modelSignature(model) {
    if (!model || !model.components) return 'no-model';
    // combine components and mean into a running hash (DJB2-like)
    let h = 5381;
    const comps = model.components;
    const mean = model.mean || new Float32Array(model.d || 0);
    // incluir dimensões e k para robustez
    h = ((h << 5) + h) ^ (model.d || 0);
    h = ((h << 5) + h) ^ (model.k || 0);
    // Somente uma amostragem dos componentes (para performance) se muito grande
    const step = Math.max(1, Math.floor(comps.length / 1000)); // amostra até 1000 valores
    for (let i = 0; i < comps.length; i += step) {
      // quantizar para reduzir variações minúsculas (6 decimais)
      const v = Math.round((comps[i] || 0) * 1e6);
      h = ((h << 5) + h) ^ (v & 0xFFFFFFFF);
      // mix with mean position
      const mi = mean[i % mean.length] || 0;
      const mv = Math.round(mi * 1e6);
      h = ((h << 5) + h) ^ (mv & 0xFFFFFFFF);
    }
    // garantir string
    return 'm' + (h >>> 0).toString(16);
  }

  // Computa projeções PC1×PC2 para as gravações do workspace, respeitando normalização e filtro de silêncio
  async function computeProjectionsPC12() {
    if (!window._pcaModel) throw new Error('Modelo PCA não encontrado. Execute o PCA primeiro.');
    const model = window._pcaModel;
    const cfg = getCfg();
    const pcaCfg = cfg.pca || {};
    const silenceEnabled = !!pcaCfg.silenceFilterEnabled;
    const silenceRmsRatio = pcaCfg.silenceRmsRatio || 0.05;
    const minSilenceFrames = pcaCfg.minSilenceFrames || 5;
    const minSpeechFrames = pcaCfg.minSpeechFrames || 3;

    const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
    if (!recs || !recs.length) throw new Error('Sem gravações no workspace.');

    // Coletar features e achar RMS máximo global (para segmentação)
    const loaded = [];
    let dims = null;
    let globalMaxRms = 0;
    let sampleRate = 16000;

    for (const rec of recs) {
      const fr = await ensureFeatures(rec);
      if (!fr || !fr.shape || !fr.meta) continue;
      if (dims == null) dims = fr.shape.dims;
      if (fr.shape.dims !== dims) {
        console.warn('Dimensão inconsistente; pulando rec id=', rec.id);
        continue;
      }
      if (!sampleRate && fr.meta && fr.meta.sampleRate) sampleRate = fr.meta.sampleRate;
      const flat = fr.features;
      const frames = fr.shape.frames;
      const rmsIndex = fr.meta.nMels;
      for (let f=0; f<frames; f++){
        const rms = flat[f*dims + rmsIndex];
        if (rms > globalMaxRms) globalMaxRms = rms;
      }
      loaded.push({ rec, fr });
    }
    if (!loaded.length) throw new Error('Nenhuma feature válida carregada para visualização.');
    if (!dims) throw new Error('Dims inválida.');

    const segFn = getSegmentSilenceFn();
    const useSeg = silenceEnabled && typeof segFn === 'function';

    const allPoints = []; // [{x,y,recId,recName,frame,timeSec}]
    const perRecCounts = new Map();

    for (const { rec, fr } of loaded) {
      const flat = fr.features;
      const frames = fr.shape.frames;
      const nMels = fr.meta.nMels;
      const rmsIdx = nMels;

      let speechIdxs = [];
      if (useSeg) {
        const rmsArr = new Float32Array(frames);
        for (let f=0; f<frames; f++) rmsArr[f] = flat[f*dims + rmsIdx];
        const segs = segFn(rmsArr, globalMaxRms, { silenceRmsRatio, minSilenceFrames, minSpeechFrames }) || [];
        for (const seg of segs) {
          if (seg.type === 'speech') {
            for (let f=seg.startFrame; f<=seg.endFrame; f++) speechIdxs.push(f);
          }
        }
      } else {
        for (let f=0; f<frames; f++) speechIdxs.push(f);
      }

      for (const f of speechIdxs) {
        const base = f*dims;
        let vec = new Float32Array(flat.subarray(base, base + dims));
        vec = normalizeFeatureVector(vec, nMels, sampleRate);

        const proj = model.project(vec);
        const x = proj[0] || 0;
        const y = proj[1] || 0;

        const t = (fr.timestamps && fr.timestamps[f] !== undefined) ? fr.timestamps[f] : f;
        allPoints.push({
          x, y,
          recId: rec.id,
          recName: rec.name || String(rec.id),
          frame: f,
          timeSec: t
        });
      }
      perRecCounts.set(rec.id, (perRecCounts.get(rec.id) || 0) + speechIdxs.length);
    }

    return { points: allPoints, perRecCounts };
  }

  // Desenha scatter PC1×PC2 em canvas simples — aceita bbox opcional para escala fixa
  function drawScatter(canvas, points, colorForRec, bbox) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    if (!points || !points.length) return;

    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    if (bbox && typeof bbox === 'object') {
      minX = bbox.minX; maxX = bbox.maxX; minY = bbox.minY; maxY = bbox.maxY;
    } else {
      for (const p of points) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX) || !isFinite(maxX) || minX===maxX) { minX-=1; maxX+=1; }
    if (!isFinite(minY) || !isFinite(maxY) || minY===maxY) { minY-=1; maxY+=1; }

    const plotL = 50, plotT = 20, plotR = w - 20, plotB = h - 40;
    const plotW = plotR - plotL;
    const plotH = plotB - plotT;

    function sx(x){ return plotL + ((x - minX) / (maxX - minX)) * plotW; }
    function sy(y){ return plotB - ((y - minY) / (maxY - minY)) * plotH; }

    // Eixos
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotL, plotB); ctx.lineTo(plotR, plotB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(plotL, plotT); ctx.lineTo(plotL, plotB); ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.font = '11px sans-serif';
    const ticks = 4;
    for (let i=0;i<=ticks;i++){
      const tx = minX + i*(maxX-minX)/ticks;
      const px = sx(tx);
      ctx.fillText(tx.toFixed(1), px-10, plotB+14);
      const ty = minY + i*(maxY-minY)/ticks;
      const py = sy(ty);
      ctx.fillText(ty.toFixed(1), plotL-40, py+4);
    }

    for (const p of points) {
      const cx = sx(p.x);
      const cy = sy(p.y);
      ctx.beginPath();
      ctx.arc(cx, cy, 2.2, 0, Math.PI*2);
      ctx.fillStyle = colorForRec(p.recId);
      ctx.fill();
    }

    ctx.fillStyle = '#222';
    ctx.font = '12px sans-serif';
    ctx.fillText('PC1', (plotL+plotR)/2 - 10, h - 8);
    ctx.save();
    ctx.translate(14, (plotT+plotB)/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillText('PC2', 0, 0);
    ctx.restore();
  }

  function colorPalette() {
    return [
      '#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00',
      '#ffff33','#a65628','#f781bf','#999999',
      '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
      '#9467bd', '#8c564b', '#e377c2', '#7f7f7f'
    ];
  }

  function buildLegend(container, recsOrder, colorForRec, countsMap){
    container.innerHTML = '';
    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';
    ul.style.margin = '8px 0 0 0';
    ul.style.padding = '0';
    ul.style.display = 'flex';
    ul.style.flexWrap = 'wrap';
    ul.style.gap = '10px';
    for (const {id, name} of recsOrder){
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.style.display = 'inline-block';
      sw.style.width = '12px';
      sw.style.height = '12px';
      sw.style.borderRadius = '3px';
      sw.style.background = colorForRec(id);
      sw.style.marginRight = '6px';
      const label = document.createElement('span');
      label.textContent = `${name || id} (${countsMap.get(id)||0})`;
      li.appendChild(sw);
      li.appendChild(label);
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  function createVisModal() {
    const old = document.getElementById(VIS_MODAL_ID);
    if (old) old.remove();

    const m = document.createElement('div');
    m.id = VIS_MODAL_ID;
    m.className = 'analyzer-modal';
    m.style.zIndex = '2200';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('div');
    title.textContent = 'Projeções PCA (PC1 × PC2)';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'small';
    closeBtn.textContent = '✖';
    closeBtn.onclick = () => m.remove();
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.maxHeight = '60vh';
    body.style.overflow = 'auto';

    const canvas = document.createElement('canvas');
    canvas.width = 680;
    canvas.height = 420;
    canvas.style.border = '1px solid #eee';
    canvas.style.borderRadius = '6px';
    canvas.style.display = 'block';
    canvas.style.margin = '4px 0 8px 0';

    const legend = document.createElement('div');
    legend.id = 'pca-vis-legend';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'small';
    exportBtn.textContent = 'Exportar CSV';
    exportBtn.onclick = () => exportCSVFromLast();

    const close2 = document.createElement('button');
    close2.className = 'small';
    close2.textContent = 'Fechar';
    close2.onclick = () => m.remove();

    actions.appendChild(exportBtn);
    actions.appendChild(close2);

    body.appendChild(canvas);
    body.appendChild(legend);

    m.appendChild(header);
    m.appendChild(body);
    m.appendChild(actions);
    document.body.appendChild(m);

    return { modal: m, canvas, legend };
  }

  let _lastPoints = null;
  let _lastRecsOrder = null;

  function exportCSVFromLast(){
    if (!_lastPoints || !_lastPoints.length) {
      alert('Sem dados para exportar. Gere a visualização primeiro.');
      return;
    }
    const rows = [['recordingId','recordingName','frameIndex','timeSec','PC1','PC2']];
    for (const p of _lastPoints) {
      rows.push([p.recId, p.recName, p.frame, p.timeSec, p.x, p.y]);
    }
    const csv = rows.map(r => r.map(v => String(v).replace(/"/g,'""')).map(v=>`"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pca-projecoes-${Date.now()}.csv`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 5000);
  }

  // Cache global (persistirá enquanto a página estiver aberta)
  window._pcaVisualizerCache = window._pcaVisualizerCache || {};

  async function openVisualizer(){
    try {
      if (!window._pcaModel) {
        alert('Modelo PCA não encontrado. Execute o PCA primeiro.');
        return;
      }

      const signature = modelSignature(window._pcaModel);
      // Verifica cache
      let cached = window._pcaVisualizerCache[signature];

      if (!cached) {
        // calcular projeções e bbox
        const { points, perRecCounts } = await computeProjectionsPC12();
        // determinar bbox
        let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
        for (const p of points) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        if (!isFinite(minX) || !isFinite(maxX)) { minX=-1; maxX=1; }
        if (!isFinite(minY) || !isFinite(maxY)) { minY=-1; maxY=1; }

        // Ordem das gravações (workspace)
        const recs = (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings() : (window.recordings || []);
        const palette = colorPalette();
        const recsOrder = recs.map((r,i)=>({ id:r.id, name:r.name || String(r.id), color: palette[i % palette.length] }));

        cached = {
          points,
          perRecCounts,
          bbox: { minX, maxX, minY, maxY },
          recsOrder
        };
        window._pcaVisualizerCache[signature] = cached;
      }

      const { modal, canvas, legend } = createVisModal();

      // Preparar cores por gravação (usar recsOrder do cache para consistência)
      const recsOrder = cached.recsOrder || ((typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings().map((r,i)=>({id:r.id,name:r.name||String(r.id),color:colorPalette()[i%16]})) : []);
      const colorForRec = (id) => {
        const idx = recsOrder.findIndex(rr => String(rr.id) === String(id));
        return (idx>=0) ? recsOrder[idx].color : '#888';
      };

      // Mensagem de carregamento simples
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.fillText('Gerando visualização...', 20, 28);

      _lastPoints = cached.points;
      _lastRecsOrder = recsOrder;

      drawScatter(canvas, cached.points, colorForRec, cached.bbox);
      buildLegend(legend, recsOrder, colorForRec, cached.perRecCounts || new Map());

    } catch (err) {
      console.error('pca-visualizer: erro ao abrir visualização:', err);
      alert('Falha ao gerar visualização. Veja o console para detalhes.');
    }
  }

  // Injeta botão no modal PCA assim que ele aparecer
  function injectButtonIfNeeded(root){
    try {
      let modal = null;
      if (root && root.id === PCA_MODAL_ID) {
        modal = root;
      } else if (root && typeof root.querySelector === 'function') {
        modal = root.querySelector('#' + PCA_MODAL_ID);
      } else {
        modal = document.getElementById(PCA_MODAL_ID);
      }
      if (!modal) return;
      if (modal.__pca_vis_btn_injected) return;
      const actions = modal.querySelector('.modal-actions') || modal;
      const btn = document.createElement('button');
      btn.id = VIS_BTN_ID;
      btn.className = 'small';
      btn.textContent = 'Visualizar projeções (PC1 × PC2)';
      btn.style.marginRight = 'auto';
      btn.onclick = openVisualizer;
      if (actions.firstChild) actions.insertBefore(btn, actions.firstChild);
      else actions.appendChild(btn);
      modal.__pca_vis_btn_injected = true;
    } catch (e) {
      // silencioso
    }
  }

  // Observer para detectar criação do modal PCA
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.id === PCA_MODAL_ID || (node.querySelector && node.querySelector('#'+PCA_MODAL_ID))) {
          injectButtonIfNeeded(node);
        }
      }
    }
  });
  try {
    mo.observe(document.body, { childList: true, subtree: true });
  } catch (_) {}

  // Tenta injetar imediatamente caso o modal já exista
  try { injectButtonIfNeeded(document); } catch (_) {}

  // Expor API pública
  window.pcaVisualizer = {
    open: openVisualizer
  };

})();