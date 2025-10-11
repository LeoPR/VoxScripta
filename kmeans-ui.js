// kmeans-ui.js
// Integra um botão "KMeans (incremental)" no modal do PCA e mostra um resumo textual.

(function(){
  'use strict';

  const PCA_MODAL_ID = 'pca-modal';

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
      if (modal.__kmeans_btn_injected) return;
      const actions = modal.querySelector('.modal-actions') || modal;
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = 'KMeans (incremental)';
      btn.style.marginRight = 'auto';
      btn.onclick = runKMeansHandler;
      if (actions.firstChild) actions.insertBefore(btn, actions.firstChild);
      else actions.appendChild(btn);
      modal.__kmeans_btn_injected = true;
    } catch (_) {}
  }

  async function runKMeansHandler(){
    try {
      if (!window.kmeans || typeof window.kmeans.runIncrementalKMeansOnTrainPool !== 'function') {
        alert('kmeans-incremental.js não carregado.');
        return;
      }
      const modal = document.getElementById(PCA_MODAL_ID);
      if (!modal) { alert('Abra o modal do PCA primeiro.'); return; }
      const body = modal.querySelector('.pca-body') || modal.querySelector('.modal-body') || modal;

      const sectionId = 'kmeans-section';
      let section = document.getElementById(sectionId);
      if (!section) {
        section = document.createElement('div');
        section.id = sectionId;
        section.style.marginTop = '12px';
        section.style.borderTop = '1px solid #eee';
        section.style.paddingTop = '10px';
        body.appendChild(section);
      }
      section.innerHTML = '<div>Executando K-Means incremental...</div>';

      const model = await window.kmeans.runIncrementalKMeansOnTrainPool({
        k: 3,
        pcaDims: 2,
        batchSize: 256,
        epochs: 3,
        seed: null,
        normalizeZ: false,
        maxPointsForPreview: 1500
      }, (prog) => {
        const pct = Math.round((prog || 0) * 100);
        const el = document.getElementById(sectionId);
        if (el) el.firstChild.textContent = `Executando K-Means incremental... ${pct}%`;
      });

      const sizes = Array.from(model.clusterSizes || []);
      const inertia = model.inertia || 0;
      const perRec = model.perRecordingClusterCounts || {};
      const recs = (typeof window.getWorkspaceRecordings === 'function') ? (window.getWorkspaceRecordings() || []) : (window.recordings || []);
      const nameOf = (id) => {
        const r = recs.find(rr => rr && String(rr.id) === String(id));
        return r ? (r.name || String(id)) : String(id);
      };

      const perRecList = Object.keys(perRec).map(id => {
        const arr = Array.from(perRec[id]).map((v,i)=>`C${i}:${v}`).join(', ');
        return `<li style="margin:2px 0;"><b>${nameOf(id)}</b> — ${arr}</li>`;
      }).join('');

      section.innerHTML = `
        <div><b>K-Means (incremental)</b> — Resultado</div>
        <div style="font-size:12px; line-height:1.5; margin-top:6px;">
          <div><b>k:</b> ${model.k} &nbsp; <b>dim (PCA usadas):</b> ${model.dim} &nbsp; <b>inércia:</b> ${inertia.toFixed(3)}</div>
          <div><b>Tamanho dos clusters:</b> [ ${sizes.map((v,i)=>`C${i}:${v}`).join(', ')} ]</div>
        </div>
        ${perRecList ? `
          <div style="margin-top:8px;">
            <b>Distribuição por gravação:</b>
            <ul style="margin:4px 0 0 16px;padding:0;">
              ${perRecList}
            </ul>
          </div>` : ''}
        <div style="margin-top:8px;font-size:12px;color:#666;">
          Modelo salvo em <code>window._kmeansModel</code>. Abra "Visualizar projeções" para ver os clusters coloridos.
        </div>
      `;

      console.log('[kmeans] modelo em window._kmeansModel:', model);
    } catch (err) {
      console.error('KMeans erro:', err);
      alert('Erro ao executar K-Means. Veja o console para detalhes.');
    }
  }

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
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  try { injectButtonIfNeeded(document); } catch (_) {}

})();