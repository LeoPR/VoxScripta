// sessions.js — gerencia Sessões (load, render, save, export, import)
// Versão atualizada: usa a API do recorder quando disponível:
// - window.getWorkspaceRecordings()
// - window.setWorkspaceRecordings(arr)
// - window.appendWorkspaceRecording(rec)

// Expor selectedSessionId globalmente (compatibilidade)
window.selectedSessionId = null;

async function loadSessions() {
  try {
    if (typeof window.getAllSessionsFromDb === 'function') {
      const sessions = await window.getAllSessionsFromDb();
      window._sessionsCache = sessions || [];
    } else if (typeof getAllSessionsFromDb === 'function') {
      window._sessionsCache = await getAllSessionsFromDb();
    } else {
      window._sessionsCache = [];
    }
    renderSessionsList();
  } catch (err) {
    console.warn('loadSessions: erro ao carregar sessões:', err);
    window._sessionsCache = [];
    renderSessionsList();
  }
}

function renderSessionsList() {
  const container = document.getElementById('sessions-list');
  if (!container) return;
  container.innerHTML = '';
  const sessionsCache = window._sessionsCache || [];
  sessionsCache.sort((a,b) => b.date - a.date);
  sessionsCache.forEach(s => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === window.selectedSessionId ? ' selected' : '');
    const title = document.createElement('div');
    title.textContent = s.name || `Sessão ${new Date(s.date).toLocaleString()}`;
    item.appendChild(title);
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';

    const expBtn = document.createElement('button');
    expBtn.className = 'small';
    expBtn.textContent = 'Exportar';
    expBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (typeof window.exportSessionById === 'function') {
        await window.exportSessionById(s.id);
      } else {
        await exportSessionById(s.id);
      }
    };
    right.appendChild(expBtn);

    const del = document.createElement('button');
    del.className = 'small';
    del.textContent = 'Apagar';
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('Apagar sessão "' + (s.name || '') + '"?')) return;
      try {
        if (typeof window.deleteSessionFromDb === 'function') {
          await window.deleteSessionFromDb(s.id);
        } else {
          await deleteSessionFromDb(s.id);
        }
      } catch (err) {
        console.warn('Erro ao apagar sessão:', err);
      }
      await loadSessions().catch(err => console.warn('loadSessions erro após apagar:', err));
    };
    right.appendChild(del);
    item.appendChild(right);
    item.onclick = () => selectSession(s.id);
    container.appendChild(item);
  });
  if ((window._sessionsCache || []).length === 0) {
    container.innerHTML = '<div style="color:#666;font-size:13px;">Nenhuma sessão salva</div>';
  }
}

async function selectSession(id) {
  window.selectedSessionId = id;
  let sess = null;
  try {
    if (typeof window.getSessionById === 'function') {
      sess = await window.getSessionById(id);
    } else {
      sess = await getSessionById(id);
    }
  } catch (err) {
    console.warn('selectSession: erro ao obter sessão:', err);
    sess = null;
  }

  const recObjs = [];
  const refs = (sess && sess.recordings) ? sess.recordings : [];
  for (const r of refs) {
    if (!r) continue;
    // r might be id (number or string) or object with blob
    if (typeof r === 'number' || typeof r === 'string') {
      if (typeof window.getRecordingById === 'function') {
        try {
          const rec = await window.getRecordingById(r);
          if (rec) recObjs.push({ id: r, name: rec.name, date: rec.date, blob: rec.blob, url: URL.createObjectURL(rec.blob), persisted: true });
        } catch (err) {
          console.warn('selectSession: getRecordingById falhou para id', r, err);
        }
      }
    } else if (r && r.blob) {
      // embedded old-schema object
      const idGuess = r.id || (Date.now() + Math.floor(Math.random() * 1000));
      recObjs.push({ id: idGuess, name: r.name, date: r.date, blob: r.blob, url: URL.createObjectURL(r.blob), persisted: false });
    } else if (r && r.id) {
      if (typeof window.getRecordingById === 'function') {
        try {
          const rec = await window.getRecordingById(r.id);
          if (rec) recObjs.push({ id: r.id, name: rec.name, date: rec.date, blob: rec.blob, url: URL.createObjectURL(rec.blob), persisted: true });
        } catch (err) {
          console.warn('selectSession: getRecordingById falhou para objeto id', r.id, err);
        }
      }
    }
  }

  // update recorder's workspace: prefer usar as funções expostas pelo recorder
  const newWorkspace = recObjs.map(r => ({ id: r.id, name: r.name, date: r.date, blob: r.blob, url: r.url, persisted: !!r.persisted }));
  if (typeof window.setWorkspaceRecordings === 'function') {
    window.setWorkspaceRecordings(newWorkspace);
  } else {
    // fallback: set global var (menos ideal, mas compatível)
    window.recordings = newWorkspace;
    // tentar disparar render se existir
    if (typeof window.renderRecordingsList === 'function') window.renderRecordingsList(window.recordings);
  }

  // update sessions list visual selection
  renderSessionsList();
}

// save session handler (sessions.js owns o fluxo de salvar sessão)
async function onSaveSessionClicked() {
  try {
    // obter gravações do recorder via getter se disponível
    let workspace = [];
    if (typeof window.getWorkspaceRecordings === 'function') {
      workspace = window.getWorkspaceRecordings() || [];
    } else if (Array.isArray(window.recordings)) {
      workspace = window.recordings;
    } else {
      // tentar acessar variável global 'recordings' (se recorder a exportou)
      workspace = window.recordings || [];
    }

    if (!workspace || workspace.length === 0) {
      alert('Nenhuma gravação para salvar nesta sessão.');
      return;
    }
    const name = prompt('Nome da sessão:', `Sessão ${new Date().toLocaleString()}`);
    if (!name) return;
    const recRefs = workspace.map((r, idx) => {
      if (r && typeof r.id === 'number') return r.id;
      // embed the object if not persisted
      return { id: r.id, name: r.name || `Gravação ${idx+1}`, date: r.date || new Date().toISOString(), blob: r.blob };
    });
    const session = { name, date: Date.now(), recordings: recRefs };
    if (typeof window.saveSessionToDb === 'function') {
      await window.saveSessionToDb(session);
    } else {
      await saveSessionToDb(session);
    }
    await loadSessions().catch(err => console.warn('loadSessions erro após salvar sessão:', err));
    alert('Sessão salva.');
  } catch (err) {
    console.error('Erro ao salvar sessão:', err);
    alert('Erro ao salvar sessão: ' + (err && err.message ? err.message : err));
  }
}

// Attach listener to button — but guard to avoid double-binding:
// sessions.js é carregado depois de recorder.js, então se recorder.js também bindou, não vamos duplicar.
(function attachSaveListener() {
  try {
    const btn = document.getElementById('save-session-btn');
    if (!btn) return;
    // evitar múltiplas anexações: usar um flag no elemento
    if (!btn.__sessions_save_bound) {
      btn.addEventListener('click', onSaveSessionClicked);
      btn.__sessions_save_bound = true;
    }
  } catch (err) {
    console.warn('attachSaveListener error:', err);
  }
})();

// export session helper (used by render)
async function exportSessionById(sessionId) {
  let sess = null;
  try {
    if (typeof window.getSessionById === 'function') sess = await window.getSessionById(sessionId);
    else sess = await getSessionById(sessionId);
  } catch (err) {
    console.warn('exportSessionById: erro ao obter sessão:', err);
    sess = null;
  }
  if (!sess) { alert('Sessão não encontrada.'); return; }
  const recs = [];
  for (const r of (sess.recordings || [])) {
    if (!r) continue;
    if (typeof r === 'number' || typeof r === 'string') {
      if (typeof window.getRecordingById === 'function') {
        try {
          const rr = await window.getRecordingById(r);
          if (rr && rr.blob) {
            const base64 = await blobToBase64(rr.blob);
            recs.push({ id: r, name: rr.name, date: rr.date, blobBase64: base64 });
          }
        } catch (err) {
          console.warn('exportSessionById: falha ao ler recording id', r, err);
        }
      }
    } else if (r.blob) {
      const base64 = await blobToBase64(r.blob);
      recs.push({ id: r.id, name: r.name, date: r.date, blobBase64: base64 });
    }
  }
  const out = { name: sess.name, date: sess.date, recordings: recs };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(sess.name||'session').replace(/\s+/g,'_')}-${sess.date}.json`;
  a.click();
}

// Expor funções e iniciar não-bloqueante
window.loadSessions = loadSessions;
window.renderSessionsList = renderSessionsList;
window.selectSession = selectSession;
window.exportSessionById = exportSessionById;

(function initSessions() {
  try {
    if (typeof window.openDb === 'function') {
      window.openDb().catch(err => console.warn('openDb falhou no sessions init:', err));
    }
    loadSessions().catch(err => console.warn('loadSessions no init falhou (não bloqueante):', err));
  } catch (err) {
    console.warn('Erro ao inicializar sessions (não fatal):', err);
  }
})();