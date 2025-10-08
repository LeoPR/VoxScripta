// db.js
// IndexedDB helpers: stores 'recordings' (pool) e 'sessions' (apontando por ids).
// Versão DB = 2 (v2). Inclui rotina de migração em runtime para sessões que
// ainda tenham gravações embutidas (schema antigo).
// Correção: migrateEmbeddedRecordings agora recebe a instância db em vez de chamar openDb()
// para evitar espera circular / deadlock durante openDb().

const DB_NAME = 'vox_db';
const DB_VERSION = 2;
const STORE_SESSIONS = 'sessions';
const STORE_RECORDINGS = 'recordings';

let _dbPromise = null;
let _dbInstance = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      // criar recordings store se não existir
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        const s = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date', { unique: false });
      }
      // criar sessions se não existir
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const s = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = (ev) => {
      _dbInstance = ev.target.result;
      // realizar migração em runtime (se necessário) usando a instância já aberta
      migrateEmbeddedRecordings(_dbInstance).then(() => resolve(_dbInstance)).catch((err) => {
        console.warn('Migration warning:', err);
        resolve(_dbInstance);
      });
    };
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// Migrações em runtime:
// Procura sessões que ainda contenham objetos de gravação com blob embutido
// (estrutura antiga), salva blobs no store 'recordings' e substitui por IDs.
// Agora recebe a instância db para evitar chamar openDb() novamente.
async function migrateEmbeddedRecordings(db) {
  if (!db) return true;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_SESSIONS, STORE_RECORDINGS], 'readwrite');
      const sessStore = tx.objectStore(STORE_SESSIONS);
      const recStore = tx.objectStore(STORE_RECORDINGS);

      const cursorReq = sessStore.openCursor();
      cursorReq.onsuccess = async (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          // wait for transaction complete before resolving to ensure writes are finished
          tx.oncomplete = () => resolve(true);
          tx.onerror = (ev) => {
            console.warn('Transaction erro during migration:', ev);
            resolve(true); // best-effort
          };
          return;
        }
        const sess = cursor.value;
        if (Array.isArray(sess.recordings) && sess.recordings.length > 0) {
          // detectar gravações embutidas (obj com blob)
          let needsUpdate = false;
          const newRefs = [];
          // We will collect add requests and wait for them before updating the session.
          const pendingAdds = [];
          for (const r of sess.recordings) {
            if (r && r.blob) {
              // salvar blob no recStore e coletar id (assíncrono)
              try {
                const addReq = recStore.add({ name: r.name || '', date: r.date || Date.now(), blob: r.blob });
                const p = requestToPromise(addReq).then((rid) => {
                  newRefs.push(rid);
                }).catch(err => {
                  console.warn('Erro salvando gravação durante migração (add):', err);
                });
                pendingAdds.push(p);
                needsUpdate = true;
              } catch (err) {
                console.warn('Erro salvando gravação durante migração (sync):', err);
              }
            } else if (r && (typeof r === 'number' || typeof r === 'string')) {
              newRefs.push(r);
            } else if (r && r.id) {
              newRefs.push(r.id);
            }
          }
          // Wait for all adds to resolve, then update the session record
          try {
            await Promise.all(pendingAdds);
            if (needsUpdate) {
              sess.recordings = newRefs;
              const updReq = cursor.update(sess);
              await requestToPromise(updReq);
            }
          } catch (err) {
            console.warn('Erro ao aguardar adds durante migração:', err);
            // continue anyway
          }
        }
        cursor.continue();
      };
      cursorReq.onerror = (ev) => {
        console.warn('Cursor migration erro:', ev);
        // resolve as a best-effort — don't block openDb
        resolve(true);
      };
    } catch (err) {
      console.warn('Migration exception:', err);
      resolve(true);
    }
  });
}

// util para transformar IDBRequest em Promise
function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// recordings helpers
async function saveRecordingToDbObj(obj) {
  // obj: { name, date, blob }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_RECORDINGS], 'readwrite');
      const store = tx.objectStore(STORE_RECORDINGS);
      const req = store.add(obj);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function getRecordingById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_RECORDINGS], 'readonly');
      const store = tx.objectStore(STORE_RECORDINGS);
      const req = store.get(Number(id));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function updateRecordingInDb(obj) {
  // obj: { id, name?, date?, blob? } - deve conter id para atualizar
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_RECORDINGS], 'readwrite');
      const store = tx.objectStore(STORE_RECORDINGS);
      const req = store.put(obj);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function deleteRecordingById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_RECORDINGS], 'readwrite');
      const store = tx.objectStore(STORE_RECORDINGS);
      const req = store.delete(Number(id));
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function getAllRecordingsFromDb() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_RECORDINGS], 'readonly');
      const store = tx.objectStore(STORE_RECORDINGS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

// sessions helpers (sessions.store contains array of recordingIds)
async function saveSessionToDb(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_SESSIONS], 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.add(session);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function updateSessionInDb(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_SESSIONS], 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.put(session);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function getAllSessionsFromDb() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_SESSIONS], 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function getSessionById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_SESSIONS], 'readonly');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.get(Number(id));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}
async function deleteSessionFromDb(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_SESSIONS], 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const req = store.delete(Number(id));
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

// Expor funções globalmente (para uso por recorder.js e outros)
window.openDb = openDb;
window.saveRecordingToDbObj = saveRecordingToDbObj;
window.getRecordingById = getRecordingById;
window.updateRecordingInDb = updateRecordingInDb;
window.deleteRecordingById = deleteRecordingById;
window.getAllRecordingsFromDb = getAllRecordingsFromDb;
window.saveSessionToDb = saveSessionToDb;
window.updateSessionInDb = updateSessionInDb;
window.getAllSessionsFromDb = getAllSessionsFromDb;
window.getSessionById = getSessionById;
window.deleteSessionFromDb = deleteSessionFromDb;