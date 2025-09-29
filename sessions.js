// sessions.js — gerencia Sessões (load, render, save, export, import)
// Versão atualizada: usa a API do recorder quando disponível:
// - window.getWorkspaceRecordings()
// - window.setWorkspaceRecordings(arr)
// - window.appendWorkspaceRecording(rec)

// Expor selectedSessionId globalmente (compatibilidade)
window.selectedSessionId = null;

// util: formata data no estilo 24h (DD/MM/YYYY HH:mm:ss)
function formatDate24(dateLike) {
  try {
    const d = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
    if (isNaN(d.getTime())) return String(dateLike || '');
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch (e) {
    return String(dateLike || '');
  }
}

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
  sessionsCache.forEach((s, index) => {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === window.selectedSessionId ? ' selected' : '');
    // tooltip com nome + data completa
    item.title = `${s.name || ''}\n${formatDate24(s.date)}`;

    // Left area: título (uma linha truncada) + meta (data, sempre visível)
    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.flexDirection = 'column';
    left.style.flex = '1 1 auto';
    left.style.minWidth = '0'; // importante para permitir truncamento no filho

    const title = document.createElement('div');
    title.className = 'session-title';
    // fallback para nomes vazios: Sessão N
    title.textContent = s.name || `Sessão ${index + 1}`;
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.whiteSpace = 'nowrap';
    left.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta session-meta';
    meta.textContent = formatDate24(s.date);
    left.appendChild(meta);

    item.appendChild(left);

    // Right area: actions (ícones)
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';
    right.style.alignItems = 'center';

    // Editar (renomear)
    const editBtn = document.createElement('button');
    editBtn.className = 'rename-btn';
    editBtn.innerHTML = '✏️';
    editBtn.title = 'Editar sessão';
    editBtn.setAttribute('aria-label', 'Editar sessão');
    editBtn.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        const currentName = s.name || `Sessão ${index + 1}`;
        const newName = prompt('Renomear sessão:', currentName);
        if (newName === null) return;
        const trimmed = String(newName).trim();
        if (!trimmed) { alert('Nome inválido.'); return; }
        if (trimmed === currentName) return;

        let sessObj = null;
        if (typeof window.getSessionById === 'function') {
          try { sessObj = await window.getSessionById(s.id); } catch (e) { console.warn('getSessionById falhou durante renomeação:', e); }
        } else {
          try { sessObj = await getSessionById(s.id); } catch (e) { console.warn('getSessionById (fallback) falhou durante renomeação:', e); }
        }
        if (!sessObj) { alert('Sessão não encontrada no banco. Atualize a lista e tente novamente.'); return; }
        sessObj.name = trimmed;

        if (typeof window.updateSessionInDb === 'function') await window.updateSessionInDb(sessObj);
        else await updateSessionInDb(sessObj);

        await loadSessions();
      } catch (err) {
        console.error('Erro ao renomear sessão:', err);
        alert('Erro ao renomear sessão. Veja o console para mais detalhes.');
      }
    };
    right.appendChild(editBtn);

    // Exportar sessão
    const expBtn = document.createElement('button');
    expBtn.className = 'small';
    expBtn.innerHTML = '⤓';
    expBtn.title = 'Exportar sessão';
    expBtn.setAttribute('aria-label', 'Exportar sessão');
    expBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (typeof window.exportSessionById === 'function') {
        await window.exportSessionById(s.id);
      } else {
        await exportSessionById(s.id);
      }
    };
    right.appendChild(expBtn);

    // Apagar sessão
    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.innerHTML = '🗑️';
    del.title = 'Apagar sessão';
    del.setAttribute('aria-label', 'Apagar sessão');
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm('Apagar sessão "' + (s.name || '') + '"?')) return;
      try {
        if (typeof window.deleteSessionFromDb === 'function') await window.deleteSessionFromDb(s.id);
        else await deleteSessionFromDb(s.id);
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

  const newWorkspace = recObjs.map(r => ({ id: r.id, name: r.name, date: r.date, blob: r.blob, url: r.url, persisted: !!r.persisted }));
  if (typeof window.setWorkspaceRecordings === 'function') {
    window.setWorkspaceRecordings(newWorkspace);
  } else {
    window.recordings = newWorkspace;
    if (typeof window.renderRecordingsList === 'function') window.renderRecordingsList(window.recordings);
  }
  renderSessionsList();
}

// save session handler
async function onSaveSessionClicked() {
  try {
    let workspace = [];
    if (typeof window.getWorkspaceRecordings === 'function') {
      workspace = window.getWorkspaceRecordings() || [];
    } else if (Array.isArray(window.recordings)) {
      workspace = window.recordings;
    } else {
      workspace = window.recordings || [];
    }

    if (!workspace || workspace.length === 0) {
      alert('Nenhuma gravação para salvar nesta sessão.');
      return;
    }

    let defaultIndex = 1;
    try {
      if (Array.isArray(window._sessionsCache)) {
        defaultIndex = (window._sessionsCache.length || 0) + 1;
      }
    } catch (_) { defaultIndex = 1; }
    const name = prompt('Nome da sessão:', `Sessão ${defaultIndex}`);
    if (!name) return;

    const recRefs = workspace.map((r, idx) => {
      if (r && typeof r.id === 'number') return r.id;
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

// Attach listener para "Salvar sessão"
(function attachSaveListener() {
  try {
    const btn = document.getElementById('save-session-btn');
    if (!btn) return;
    if (!btn.__sessions_save_bound) {
      btn.addEventListener('click', onSaveSessionClicked);
      btn.__sessions_save_bound = true;
    }
  } catch (err) {
    console.warn('attachSaveListener error:', err);
  }
})();

// util local base64 -> Blob
function _base64ToBlob_local(base64, mime = 'audio/webm') {
  try {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mime });
  } catch (err) {
    console.warn('base64->Blob falhou:', err);
    return null;
  }
}

// util: Blob -> base64 (local)
function _blobToBase64_local(blob) {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => {
        const dataUrl = fr.result || '';
        const comma = dataUrl.indexOf(',');
        resolve(dataUrl.slice(comma + 1));
      };
      fr.onerror = (e) => reject(e);
      fr.readAsDataURL(blob);
    } catch (err) {
      reject(err);
    }
  });
}

// Verifica se já existe gravação com mesmo base64; retorna id ou null
async function _findExistingRecordingByBase64(base64) {
  try {
    if (typeof window.getAllRecordingsFromDb !== 'function') return null;
    const all = await window.getAllRecordingsFromDb();
    if (!Array.isArray(all)) return null;
    for (const r of all) {
      if (!r || !r.blob) continue;
      try {
        const rb64 = await _blobToBase64_local(r.blob);
        if (rb64 === base64) return r.id;
      } catch (_) {}
    }
    return null;
  } catch (err) {
    console.warn('Erro em _findExistingRecordingByBase64:', err);
    return null;
  }
}

// Fingerprint de sessão (já usado em import de sessão)
async function _computeSessionFingerprint(recordingEntries) {
  const parts = [];
  for (const r of recordingEntries) {
    if (!r) continue;
    if (typeof r === 'number' || typeof r === 'string') {
      if (typeof window.getRecordingById === 'function') {
        try {
          const rec = await window.getRecordingById(r);
          if (rec) {
            const b64 = rec.blob ? await _blobToBase64_local(rec.blob).catch(()=>'') : '';
            parts.push([rec.name || '', rec.date || '', b64].join('|'));
          }
        } catch (e) { parts.push(String(r)); }
      } else {
        parts.push(String(r));
      }
    } else if (r && r.blobBase64) {
      parts.push([r.name || '', r.date || '', r.blobBase64].join('|'));
    } else if (r && r.blob) {
      try {
        const b64 = await _blobToBase64_local(r.blob).catch(()=>'');
        parts.push([r.name || '', r.date || '', b64].join('|'));
      } catch (e) { parts.push([r.name || '', r.date || ''].join('|')); }
    } else {
      parts.push([r.name || '', r.date || '', JSON.stringify(r.id || '')].join('|'));
    }
  }
  parts.sort();
  return parts.join('||');
}

// export session helper (usada por render)
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
            const base64 = await (window.blobToBase64 ? window.blobToBase64(rr.blob) : _blobToBase64_local(rr.blob));
            recs.push({ id: r, name: rr.name, date: rr.date, blobBase64: base64 });
          }
        } catch (err) { console.warn('exportSessionById: falha ao ler recording id', r, err); }
      }
    } else if (r.blob) {
      const base64 = await (window.blobToBase64 ? window.blobToBase64(r.blob) : _blobToBase64_local(r.blob));
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

// Botão global 'Exportar sessão' (topo)
(function attachExportSessionBtn() {
  try {
    const btn = document.getElementById('export-session-btn');
    if (!btn) return;
    if (btn.__sessions_export_bound) return;
    btn.addEventListener('click', async () => {
      if (!window.selectedSessionId) { alert('Nenhuma sessão selecionada para exportar.'); return; }
      try {
        if (typeof window.exportSessionById === 'function') await window.exportSessionById(window.selectedSessionId);
        else await exportSessionById(window.selectedSessionId);
      } catch (err) {
        console.error('Erro ao exportar sessão (global):', err);
        alert('Erro ao exportar sessão. Veja o console para mais detalhes.');
      }
    });
    btn.__sessions_export_bound = true;
  } catch (err) { console.warn('attachExportSessionBtn error:', err); }
})();

// Importar sessão (topo) - import/session.json
(function attachImportSessionInput() {
  try {
    const input = document.getElementById('import-session-input');
    if (!input) return;
    if (input.__sessions_import_bound) return;
    input.addEventListener('change', async (ev) => {
      const f = (ev.target && ev.target.files && ev.target.files[0]) ? ev.target.files[0] : null;
      if (!f) return;
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.recordings)) { alert('Arquivo de sessão inválido (formato esperado).'); input.value = ''; return; }

        // mapa base64->id existente
        const existingBase64ToId = new Map();
        if (typeof window.getAllRecordingsFromDb === 'function') {
          try {
            const allRecs = await window.getAllRecordingsFromDb();
            for (const er of (allRecs || [])) {
              if (er && er.blob) {
                const eb64 = await _blobToBase64_local(er.blob).catch(()=>null);
                if (eb64) existingBase64ToId.set(eb64, er.id);
              }
            }
          } catch (e) { console.warn('Falha ao carregar gravações existentes para deduplicação:', e); }
        }

        const recRefs = [];
        for (const r of parsed.recordings) {
          if (!r) continue;
          if (r.blobBase64) {
            const existingId = existingBase64ToId.get(r.blobBase64);
            if (existingId !== undefined && existingId !== null) { recRefs.push(existingId); continue; }

            if (r.id && typeof r.id !== 'object' && typeof window.getRecordingById === 'function') {
              try {
                const maybe = await window.getRecordingById(r.id);
                if (maybe && maybe.blob) {
                  const maybeB64 = await _blobToBase64_local(maybe.blob).catch(()=>null);
                  if (maybeB64 === r.blobBase64) { recRefs.push(r.id); continue; }
                  const ok = confirm(`Gravação com id ${r.id} já existe com conteúdo diferente.\nClique OK para criar uma nova gravação (não sobrescrever), Cancel para ignorar esta gravação.`);
                  if (ok) {
                    if (typeof window.saveRecordingToDbObj === 'function') {
                      try {
                        const newId = await window.saveRecordingToDbObj({ name: r.name || '', date: r.date || Date.now(), blob: _base64ToBlob_local(r.blobBase64) });
                        recRefs.push(newId);
                      } catch (err) {
                        console.warn('Falha ao salvar gravação importada no DB, mantendo-a embutida:', err);
                        recRefs.push({ id: null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
                      }
                    } else {
                      recRefs.push({ id: null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
                    }
                  } else {
                    continue;
                  }
                  continue;
                }
              } catch (e) { /* segue fluxo padrão */ }
            }

            if (typeof window.saveRecordingToDbObj === 'function') {
              try {
                const blob = _base64ToBlob_local(r.blobBase64);
                const newId = await window.saveRecordingToDbObj({ name: r.name || '', date: r.date || Date.now(), blob });
                existingBase64ToId.set(r.blobBase64, newId);
                recRefs.push(newId);
              } catch (err) {
                console.warn('Falha ao salvar gravação importada no DB, mantendo embutida:', err);
                recRefs.push({ id: r.id || null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
              }
            } else {
              recRefs.push({ id: r.id || null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
            }
          } else if (r.id || typeof r === 'number' || typeof r === 'string') {
            recRefs.push(r.id !== undefined ? r.id : r);
          } else {
            recRefs.push(r);
          }
        }

        const importedFingerprint = await _computeSessionFingerprint(parsed.recordings);
        let duplicateFound = false;
        if (typeof window.getAllSessionsFromDb === 'function') {
          try {
            const allSess = await window.getAllSessionsFromDb();
            for (const s of (allSess || [])) {
              const sFingerprint = await _computeSessionFingerprint(s.recordings || []);
              if (sFingerprint === importedFingerprint) {
                duplicateFound = true;
                alert(`Sessão "${parsed.name || '(sem nome)'}" parece já existir (id ${s.id}). Importação ignorada.`);
                break;
              }
            }
          } catch (e) { console.warn('Falha ao verificar sessões existentes para duplicidade:', e); }
        }

        if (duplicateFound) { input.value = ''; return; }

        const session = { name: parsed.name || `Sessão importada ${Date.now()}`, date: parsed.date || Date.now(), recordings: recRefs };
        if (typeof window.saveSessionToDb === 'function') await window.saveSessionToDb(session);
        else await saveSessionToDb(session);

        await loadSessions().catch(()=>{});
        alert('Sessão importada com sucesso.');
      } catch (err) {
        console.error('Erro ao importar sessão:', err);
        alert('Erro ao importar sessão. Veja o console para mais detalhes.');
      } finally {
        try { input.value = ''; } catch(_) {}
      }
    });
    input.__sessions_import_bound = true;
  } catch (err) {
    console.warn('attachImportSessionInput error:', err);
  }
})();

// ------------------------------
// BACKUP GERAL: Exportar tudo / Importar tudo
// ------------------------------

// Exportar tudo (recordings + sessions) em um único arquivo JSON
async function exportAllBackup() {
  try {
    if (typeof window.getAllRecordingsFromDb !== 'function' || typeof window.getAllSessionsFromDb !== 'function') {
      alert('API de banco indisponível para backup geral.');
      return;
    }

    const allRecs = await window.getAllRecordingsFromDb();
    const allSess = await window.getAllSessionsFromDb();

    const toBase64 = async (blob) => (window.blobToBase64 ? window.blobToBase64(blob) : _blobToBase64_local(blob));

    const outRecs = [];
    for (const r of (allRecs || [])) {
      if (!r || !r.blob) continue;
      try {
        const b64 = await toBase64(r.blob);
        outRecs.push({ id: r.id, name: r.name, date: r.date, blobBase64: b64 });
      } catch (e) {
        console.warn('Falha ao converter gravação para base64 (id=', r && r.id, '):', e);
      }
    }

    const out = {
      meta: { exportedAt: Date.now() },
      recordings: outRecs,
      sessions: (allSess || []).map(s => ({
        id: s.id,
        name: s.name,
        date: s.date,
        recordings: s.recordings || []
      }))
    };

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-voxscript-${Date.now()}.json`;
    a.click();
  } catch (err) {
    console.error('exportAllBackup: erro ao gerar backup:', err);
    alert('Erro ao exportar backup. Veja o console para detalhes.');
  }
}

// Importar backup geral (arquivo JSON com recordings + sessions)
async function importAllBackupFromFile(file) {
  try {
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.recordings) || !Array.isArray(parsed.sessions)) {
      alert('Arquivo de backup inválido.');
      return;
    }

    if (typeof window.getAllRecordingsFromDb !== 'function') {
      alert('API do banco indisponível (getAllRecordingsFromDb).');
      return;
    }

    // Construir mapa base64->id existente
    const existingBase64ToId = new Map();
    const existingRecs = await window.getAllRecordingsFromDb();
    for (const er of (existingRecs || [])) {
      if (er && er.blob) {
        const eb64 = await _blobToBase64_local(er.blob).catch(()=>null);
        if (eb64) existingBase64ToId.set(eb64, er.id);
      }
    }

    // Mapear id antigo -> id novo (ou existente)
    const oldIdToNewId = new Map();
    // Também criar mapa id->obj do backup para ajudar no fingerprint
    const backupIdToObj = new Map();
    for (const br of parsed.recordings) {
      if (br && (br.id !== undefined && br.id !== null)) backupIdToObj.set(br.id, br);
    }

    // Importar gravações (deduplicando)
    for (const br of parsed.recordings) {
      if (!br || !br.blobBase64) continue;
      const existingId = existingBase64ToId.get(br.blobBase64);
      if (existingId !== undefined && existingId !== null) {
        oldIdToNewId.set(br.id, existingId);
        continue;
      }
      if (typeof window.saveRecordingToDbObj === 'function') {
        try {
          const blob = _base64ToBlob_local(br.blobBase64);
          const newId = await window.saveRecordingToDbObj({ name: br.name || '', date: br.date || Date.now(), blob });
          existingBase64ToId.set(br.blobBase64, newId);
          oldIdToNewId.set(br.id, newId);
        } catch (e) {
          console.warn('Falha ao salvar gravação do backup; ignorando esta gravação:', e);
        }
      } else {
        // Sem DB: não há como persistir globalmente, então não mapeamos (ficaria só embed em sessões se fosse o caso)
      }
    }

    // Deduplicação de sessões por fingerprint (usando dados do próprio backup)
    const backupSessionFingerprint = async (sess) => {
      const entries = [];
      for (const r of (sess.recordings || [])) {
        if (typeof r === 'number' || typeof r === 'string') {
          const br = backupIdToObj.get(r);
          if (br && br.blobBase64) entries.push({ name: br.name, date: br.date, blobBase64: br.blobBase64 });
          else entries.push({ id: r });
        } else if (r && r.blobBase64) {
          entries.push({ name: r.name, date: r.date, blobBase64: r.blobBase64 });
        } else {
          entries.push(r);
        }
      }
      return _computeSessionFingerprint(entries);
    };

    let existingSessions = [];
    if (typeof window.getAllSessionsFromDb === 'function') {
      try { existingSessions = await window.getAllSessionsFromDb(); } catch (_) {}
    }

    const existingFingerprints = new Set();
    for (const s of (existingSessions || [])) {
      try {
        const fp = await _computeSessionFingerprint(s.recordings || []);
        existingFingerprints.add(fp);
      } catch (_) {}
    }

    // Importar sessões
    let importedCount = 0;
    for (const sess of parsed.sessions) {
      try {
        const fpBackup = await backupSessionFingerprint(sess);
        if (existingFingerprints.has(fpBackup)) {
          // Sessão idêntica já existe — ignora
          continue;
        }

        // Remapear referências de gravações para ids do DB
        const refs = [];
        for (const r of (sess.recordings || [])) {
          if (typeof r === 'number' || typeof r === 'string') {
            const mapped = oldIdToNewId.has(r) ? oldIdToNewId.get(r) : r;
            refs.push(mapped);
          } else if (r && r.blobBase64) {
            const existingId = existingBase64ToId.get(r.blobBase64);
            if (existingId !== undefined && existingId !== null) {
              refs.push(existingId);
            } else if (typeof window.saveRecordingToDbObj === 'function') {
              try {
                const blob = _base64ToBlob_local(r.blobBase64);
                const newId = await window.saveRecordingToDbObj({ name: r.name || '', date: r.date || Date.now(), blob });
                existingBase64ToId.set(r.blobBase64, newId);
                refs.push(newId);
              } catch (e) {
                console.warn('Falha ao importar gravação embutida na sessão; mantendo embutida:', e);
                refs.push({ id: r.id || null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
              }
            } else {
              refs.push({ id: r.id || null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
            }
          } else {
            refs.push(r);
          }
        }

        const newSession = { name: sess.name || `Sessão importada ${Date.now()}`, date: sess.date || Date.now(), recordings: refs };
        if (typeof window.saveSessionToDb === 'function') await window.saveSessionToDb(newSession);
        else await saveSessionToDb(newSession);

        existingFingerprints.add(fpBackup);
        importedCount++;
      } catch (e) {
        console.warn('Falha ao importar sessão do backup:', e);
      }
    }

    await loadSessions().catch(()=>{});
    alert(`Backup importado. Sessões novas: ${importedCount}.`);
  } catch (err) {
    console.error('Erro ao importar backup:', err);
    alert('Erro ao importar backup. Veja o console para detalhes.');
  }
}

// Listeners para os botões de "Exportar tudo" e "Importar tudo"
(function attachBackupButtons() {
  try {
    // Exportar tudo
    const expAll = document.getElementById('export-all-btn');
    if (expAll && !expAll.__backup_export_bound) {
      expAll.addEventListener('click', () => {
        exportAllBackup();
      });
      expAll.__backup_export_bound = true;
    }

    // Importar tudo
    const impAllBtn = document.getElementById('import-all-btn');
    const impAllInput = document.getElementById('import-all-input');
    if (impAllBtn && !impAllBtn.__backup_import_btn_bound) {
      impAllBtn.addEventListener('click', () => {
        if (impAllInput) impAllInput.click();
        else alert('Entrada de arquivo para importar backup não encontrada (import-all-input).');
      });
      impAllBtn.__backup_import_btn_bound = true;
    }
    if (impAllInput && !impAllInput.__backup_import_input_bound) {
      impAllInput.addEventListener('change', async (ev) => {
        const f = ev.target && ev.target.files && ev.target.files[0] ? ev.target.files[0] : null;
        if (!f) return;
        await importAllBackupFromFile(f);
        try { impAllInput.value = ''; } catch(_) {}
      });
      impAllInput.__backup_import_input_bound = true;
    }
  } catch (err) {
    console.warn('attachBackupButtons error:', err);
  }
})();

// Expor funções e iniciar não-bloqueante
window.loadSessions = loadSessions;
window.renderSessionsList = renderSessionsList;
window.selectSession = selectSession;
window.exportSessionById = exportSessionById;
window.exportAllBackup = exportAllBackup;

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