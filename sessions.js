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

    // Right area: actions
    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.gap = '6px';
    right.style.alignItems = 'center';

    // === EDIT button (adicionado): renomear sessão (ação mínima) ===
    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Editar';
    editBtn.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        const currentName = s.name || `Sessão ${index + 1}`;
        const newName = prompt('Renomear sessão:', currentName);
        if (newName === null) return; // usuário cancelou
        const trimmed = String(newName).trim();
        if (!trimmed) {
          alert('Nome inválido.');
          return;
        }
        if (trimmed === currentName) {
          // sem alterações
          return;
        }
        // obter sessão atual do DB para garantir consistência
        let sessObj = null;
        if (typeof window.getSessionById === 'function') {
          try {
            sessObj = await window.getSessionById(s.id);
          } catch (e) {
            console.warn('getSessionById falhou durante renomeação:', e);
          }
        } else {
          try {
            sessObj = await getSessionById(s.id);
          } catch (e) {
            console.warn('getSessionById (fallback) falhou durante renomeação:', e);
          }
        }
        if (!sessObj) {
          alert('Sessão não encontrada no banco. Atualize a lista e tente novamente.');
          return;
        }
        sessObj.name = trimmed;
        // persistir alteração
        if (typeof window.updateSessionInDb === 'function') {
          await window.updateSessionInDb(sessObj);
        } else {
          await updateSessionInDb(sessObj);
        }
        // recarregar a lista para refletir a mudança
        await loadSessions();
      } catch (err) {
        console.error('Erro ao renomear sessão:', err);
        alert('Erro ao renomear sessão. Veja o console para mais detalhes.');
      }
    };
    right.appendChild(editBtn);

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

    // --- alteração do Passo B: sugestão de nome padrão "Sessão N" ---
    // calcular N a partir de sessões carregadas (window._sessionsCache) se disponível
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

// util local para converter base64 -> Blob (independente de outras implementações)
function _base64ToBlob_local(base64, mime = 'audio/webm') {
  try {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mime });
  } catch (err) {
    console.warn('base64->Blob falhou:', err);
    return null;
  }
}

// util: converte blob -> base64 (usado para comparar gravações)
// retorna string base64 (sem data: prefix)
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
      } catch (e) {
        // ignore individual failures
      }
    }
    return null;
  } catch (err) {
    console.warn('Erro em _findExistingRecordingByBase64:', err);
    return null;
  }
}

// Gera fingerprint de uma lista de gravações (recebe array de objetos: { name, date, blobBase64 } ou ids)
// Retorna string (ordenada) para comparar sessões
async function _computeSessionFingerprint(recordingEntries) {
  const parts = [];
  for (const r of recordingEntries) {
    if (!r) continue;
    if (typeof r === 'number' || typeof r === 'string') {
      // buscar no DB
      if (typeof window.getRecordingById === 'function') {
        try {
          const rec = await window.getRecordingById(r);
          if (rec) {
            const b64 = rec.blob ? await _blobToBase64_local(rec.blob).catch(()=>'') : '';
            parts.push([rec.name || '', rec.date || '', b64].join('|'));
          }
        } catch (e) {
          parts.push(String(r));
        }
      } else {
        parts.push(String(r));
      }
    } else if (r && r.blobBase64) {
      parts.push([r.name || '', r.date || '', r.blobBase64].join('|'));
    } else if (r && r.blob) {
      try {
        const b64 = await _blobToBase64_local(r.blob).catch(()=>'');
        parts.push([r.name || '', r.date || '', b64].join('|'));
      } catch (e) {
        parts.push([r.name || '', r.date || ''].join('|'));
      }
    } else {
      // generic object
      parts.push([r.name || '', r.date || '', JSON.stringify(r.id || '')].join('|'));
    }
  }
  parts.sort();
  return parts.join('||');
}

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

// ------------------------------
// NOVO: listener para o botão global 'Exportar sessão' (topo)
// ------------------------------
(function attachExportSessionBtn() {
  try {
    const btn = document.getElementById('export-session-btn');
    if (!btn) return;
    if (btn.__sessions_export_bound) return;
    btn.addEventListener('click', async () => {
      if (!window.selectedSessionId) {
        alert('Nenhuma sessão selecionada para exportar.');
        return;
      }
      try {
        if (typeof window.exportSessionById === 'function') {
          await window.exportSessionById(window.selectedSessionId);
        } else {
          await exportSessionById(window.selectedSessionId);
        }
      } catch (err) {
        console.error('Erro ao exportar sessão (global):', err);
        alert('Erro ao exportar sessão. Veja o console para mais detalhes.');
      }
    });
    btn.__sessions_export_bound = true;
  } catch (err) {
    console.warn('attachExportSessionBtn error:', err);
  }
})();

// ------------------------------
// NOVO: listener para input 'Importar sessão' (topo) - import/session.json
// ------------------------------
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
        if (!parsed || !Array.isArray(parsed.recordings)) {
          alert('Arquivo de sessão inválido (formato esperado).');
          input.value = '';
          return;
        }

        // Preparar mapa de base64 existentes (para deduplicar gravações)
        const existingBase64ToId = new Map();
        if (typeof window.getAllRecordingsFromDb === 'function') {
          try {
            const allRecs = await window.getAllRecordingsFromDb();
            for (const er of (allRecs || [])) {
              if (er && er.blob) {
                try {
                  const eb64 = await _blobToBase64_local(er.blob).catch(()=>null);
                  if (eb64) existingBase64ToId.set(eb64, er.id);
                } catch (e) { /* ignore per-record */ }
              }
            }
          } catch (e) {
            console.warn('Falha ao carregar gravações existentes para deduplicação:', e);
          }
        }

        const recRefs = [];
        for (const r of parsed.recordings) {
          if (!r) continue;
          // Caso 1: gravação fornecida em base64 (export)
          if (r.blobBase64) {
            // se existir uma gravação idêntica no DB, reutilizar id
            const existingId = existingBase64ToId.get(r.blobBase64);
            if (existingId !== undefined && existingId !== null) {
              // reutiliza id existente (evita duplicação)
              recRefs.push(existingId);
              continue;
            }

            // se veio com id e esse id existe no DB, buscar e comparar
            if (r.id && typeof r.id !== 'object' && typeof window.getRecordingById === 'function') {
              try {
                const maybe = await window.getRecordingById(r.id);
                if (maybe && maybe.blob) {
                  const maybeB64 = await _blobToBase64_local(maybe.blob).catch(()=>null);
                  if (maybeB64 === r.blobBase64) {
                    // mesmo conteúdo, reutiliza id
                    recRefs.push(r.id);
                    continue;
                  } else {
                    // id igual mas conteúdo diferente -> perguntar ao usuário
                    const ok = confirm(`Gravação com id ${r.id} já existe com conteúdo diferente.\nClique OK para criar uma nova gravação (não sobrescrever), Cancel para ignorar esta gravação.`);
                    if (ok) {
                      // salvar como novo
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
                      // ignorar
                      continue;
                    }
                    continue;
                  }
                }
              } catch (e) {
                // não existe id no DB; seguirá para salvar normalmente
              }
            }

            // caso padrão: salvar gravação (se possível) ou embutir
            if (typeof window.saveRecordingToDbObj === 'function') {
              try {
                const blob = _base64ToBlob_local(r.blobBase64);
                const newId = await window.saveRecordingToDbObj({ name: r.name || '', date: r.date || Date.now(), blob });
                // atualizar mapa para evitar salvar duplicados subsequentes
                existingBase64ToId.set(r.blobBase64, newId);
                recRefs.push(newId);
              } catch (err) {
                console.warn('Falha ao salvar gravação importada no DB, mantendo embutida:', err);
                recRefs.push({ id: r.id || null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
              }
            } else {
              // fallback: embutir the object with blob
              recRefs.push({ id: r.id || null, name: r.name, date: r.date, blob: _base64ToBlob_local(r.blobBase64) });
            }
          } else if (r.id || typeof r === 'number' || typeof r === 'string') {
            // se vier apenas id referenciado, tentar reutilizar
            recRefs.push(r.id !== undefined ? r.id : r);
          } else {
            // objeto parcial: inserir como embutido
            recRefs.push(r);
          }
        }

        // Antes de salvar a sessão, checar duplicidade contra sessions existentes
        const importedFingerprint = await _computeSessionFingerprint(parsed.recordings);
        let duplicateFound = false;
        if (typeof window.getAllSessionsFromDb === 'function') {
          try {
            const allSess = await window.getAllSessionsFromDb();
            for (const s of (allSess || [])) {
              try {
                const sFingerprint = await _computeSessionFingerprint(s.recordings || []);
                if (sFingerprint === importedFingerprint) {
                  duplicateFound = true;
                  alert(`Sessão "${parsed.name || '(sem nome)'}" parece já existir (id ${s.id}). Importação ignorada.`);
                  break;
                }
              } catch (e) {
                // ignore per-session errors
              }
            }
          } catch (e) {
            console.warn('Falha ao verificar sessões existentes para duplicidade:', e);
          }
        }

        if (duplicateFound) {
          input.value = '';
          return;
        }

        // montar sessão final e salvar
        const session = { name: parsed.name || `Sessão importada ${Date.now()}`, date: parsed.date || Date.now(), recordings: recRefs };
        if (typeof window.saveSessionToDb === 'function') {
          await window.saveSessionToDb(session);
        } else {
          await saveSessionToDb(session);
        }
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