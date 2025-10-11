// pca-model-manager-ui.js
// UI mínima para gerenciar treinamentos (salvar, listar, selecionar, renomear, excluir, exportar).
// Injeta uma seção "Treinamentos" no modal PCA (id='pca-modal').
// Depende de window.modelStore (model-store.js) estar carregado.

(function(){
  'use strict';

  const PCA_MODAL_ID = 'pca-modal';
  const SECTION_ID = 'pca-model-manager-section';

  function fmtDate(ms) {
    try {
      const d = new Date(ms);
      return d.toLocaleString();
    } catch (e) { return String(ms); }
  }

  function createSection() {
    const modal = document.getElementById(PCA_MODAL_ID);
    if (!modal) return null;
    let sec = modal.querySelector('#' + SECTION_ID);
    if (sec) return sec;

    sec = document.createElement('div');
    sec.id = SECTION_ID;
    sec.style.marginTop = '12px';
    sec.style.borderTop = '1px solid #eee';
    sec.style.paddingTop = '10px';
    sec.style.fontSize = '13px';

    sec.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px;">Treinamentos (PCA + KMeans)</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <input id="training-name-input" placeholder="Nome do treinamento (opcional)" style="flex:1;padding:6px;border:1px solid #ccc;border-radius:4px;" />
        <button id="save-training-btn" class="small btn">Salvar treino</button>
      </div>
      <div id="training-list-container" style="max-height:240px;overflow:auto;"></div>
    `;
    // inserir antes das ações (se existir)
    const actions = modal.querySelector('.modal-actions') || modal;
    modal.insertBefore(sec, actions);
    attachHandlers(sec);
    renderList();
    return sec;
  }

  function renderList() {
    const sec = createSection();
    if (!sec) return;
    const container = sec.querySelector('#training-list-container');
    container.innerHTML = '<div style="color:#666;">Carregando...</div>';
    try {
      const list = (window.modelStore && typeof window.modelStore.listTrainings === 'function') ? window.modelStore.listTrainings() : [];
      if (!list || !list.length) {
        container.innerHTML = '<div style="color:#666;">Nenhum treinamento salvo.</div>';
        return;
      }
      const activeId = (window.modelStore && typeof window.modelStore.getActiveTrainingId === 'function') ? window.modelStore.getActiveTrainingId() : null;
      container.innerHTML = '';
      for (const t of list) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.justifyContent = 'space-between';
        row.style.padding = '6px 4px';
        row.style.borderBottom = '1px solid #f0f0f0';

        const left = document.createElement('div');
        left.style.flex = '1';
        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.textContent = t.name || t.id;
        const meta = document.createElement('div');
        meta.style.fontSize = '12px';
        meta.style.color = '#666';
        meta.textContent = `Criado: ${fmtDate(t.createdAt)} — PCA? ${t.hasPCA ? '✓' : '–'} KMeans? ${t.hasKMeans ? '✓' : '–'}`;
        left.appendChild(title);
        left.appendChild(meta);

        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.gap = '6px';
        right.style.alignItems = 'center';

        if (activeId === t.id) {
          const badge = document.createElement('span');
          badge.textContent = 'Ativo';
          badge.style.background = '#2a9d8f';
          badge.style.color = '#fff';
          badge.style.padding = '3px 6px';
          badge.style.borderRadius = '12px';
          badge.style.fontSize = '12px';
          right.appendChild(badge);
        } else {
          const sel = document.createElement('button');
          sel.className = 'small';
          sel.textContent = 'Selecionar';
          sel.onclick = async () => {
            try {
              await window.modelStore.setActiveTraining(t.id);
              renderList();
              alert('Treinamento selecionado e aplicado como ativo.');
            } catch (e) {
              console.error(e);
              alert('Falha ao selecionar: ' + (e && e.message ? e.message : e));
            }
          };
          right.appendChild(sel);
        }

        const exp = document.createElement('button');
        exp.className = 'small';
        exp.textContent = 'Exportar';
        exp.onclick = () => {
          try {
            const json = window.modelStore.exportTraining(t.id);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${t.name || t.id}.json`;
            a.click();
            setTimeout(()=>URL.revokeObjectURL(url), 5000);
          } catch (e) {
            console.error(e);
            alert('Falha ao exportar.');
          }
        };
        right.appendChild(exp);

        const ren = document.createElement('button');
        ren.className = 'small';
        ren.textContent = 'Renomear';
        ren.onclick = async () => {
          const name = prompt('Novo nome do treinamento:', t.name || '');
          if (!name) return;
          try {
            await window.modelStore.renameTraining(t.id, name);
            renderList();
          } catch (e) {
            console.error(e);
            alert('Falha ao renomear.');
          }
        };
        right.appendChild(ren);

        const del = document.createElement('button');
        del.className = 'small';
        del.textContent = 'Excluir';
        del.onclick = () => {
          if (!confirm('Excluir este treinamento?')) return;
          try {
            window.modelStore.deleteTraining(t.id);
            renderList();
          } catch (e) {
            console.error(e);
            alert('Falha ao excluir.');
          }
        };
        right.appendChild(del);

        row.appendChild(left);
        row.appendChild(right);
        container.appendChild(row);
      }
    } catch (e) {
      console.error('Erro ao renderizar lista de treinamentos', e);
      container.innerHTML = '<div style="color:#c00;">Erro ao carregar treinamentos.</div>';
    }
  }

  function attachHandlers(sec) {
    try {
      const saveBtn = sec.querySelector('#save-training-btn');
      const nameInput = sec.querySelector('#training-name-input');
      saveBtn.onclick = () => {
        const name = (nameInput && nameInput.value) ? nameInput.value.trim() : null;
        try {
          const res = window.modelStore.saveTraining(name);
          nameInput.value = '';
          renderList();
          alert('Treinamento salvo: ' + (res && res.name ? res.name : res.id));
        } catch (e) {
          console.error(e);
          alert('Falha ao salvar treinamento: ' + (e && e.message ? e.message : e));
        }
      };

      // atualizar lista quando houver evento global
      document.addEventListener('training-changed', () => {
        renderList();
      });
    } catch (e) {
      console.warn('attachHandlers erro', e);
    }
  }

  // Injetar seção assim que o modal PCA aparecer
  function injectIfNeeded(root) {
    try {
      let modal = null;
      if (root && root.id === PCA_MODAL_ID) modal = root;
      else if (root && typeof root.querySelector === 'function') modal = root.querySelector('#' + PCA_MODAL_ID);
      else modal = document.getElementById(PCA_MODAL_ID);
      if (!modal) return;
      if (modal.__pca_model_manager_injected) return;
      createSection();
      modal.__pca_model_manager_injected = true;
    } catch (e) {
      // silencioso
    }
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.id === PCA_MODAL_ID || (node.querySelector && node.querySelector('#'+PCA_MODAL_ID))) {
          injectIfNeeded(node);
        }
      }
    }
  });

  try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
  try { injectIfNeeded(document); } catch (_) {}

})();