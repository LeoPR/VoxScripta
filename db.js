// db.js
// IndexedDB helpers: stores 'recordings' (pool) e 'sessions' (apontando por ids).
// Versão DB = 2 (v2). Inclui rotina de migração em runtime para sessões que
// ainda tenham gravações embutidas (schema antigo).

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
      // realizar migração em runtime (se necessário)
      migrateEmbeddedRecordings().then(() => resolve(_dbInstance)).catch((err) => {
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
async function migrateEmbeddedRecordings() {
  const db = await openDb(); // garante instancia
  // abrir txn readonly -> readwrite para atualizar sessões e inserir gravações
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STORE_SESSIONS, STORE_RECORDINGS], 'readwrite');
      const sessStore = tx.objectStore(STORE_SESSIONS);
      const recStore = tx.objectStore(STORE_RECORDINGS);

      const cursorReq = sessStore.openCursor();
      cursorReq.onsuccess = async (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          resolve(true);
          return;
        }
        const sess = cursor.value;
        if (Array.isArray(sess.recordings) && sess.recordings.length > 0) {
          // detectar gravações embutidas (obj com blob)
          let needsUpdate = false;
          const newRefs = [];
          for (const r of sess.recordings) {
            if (r && r.blob) {
              // salvar blob no recStore e coletar id (assíncrono)
              try {
                const addReq = recStore.add({ name: r.name || '', date: r.date || Date.now(), blob: r.blob });
                // como addReq.onsuccess será chamado depois no mesmo txn, usamos um promise wrapper
                const rid = await requestToPromise(addReq);
                newRefs.push(rid);
                needsUpdate = true;
              } catch (err) {
                console.warn('Erro salvando gravação durante migração:', err);
              }
            } else if (r && (typeof r === 'number' || typeof r === 'string')) {
              newRefs.push(r);
            } else if (r && r.id) {
              newRefs.push(r.id);
            }
          }
          if (needsUpdate) {
            sess.recordings = newRefs;
            const updReq = cursor.update(sess);
            await requestToPromise(updReq);
          }
        }
        cursor.continue();
      };
      cursorReq.onerror = (ev) => {
        console.warn('Cursor migration erro:', ev);
        resolve(true); // best-effort
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
    const tx = db.transaction([STORE_RECORDINGS], 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.add(obj);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getRecordingById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS], 'readonly');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.get(Number(id));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function deleteRecordingById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS], 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.delete(Number(id));
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
async function getAllRecordingsFromDb() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_RECORDINGS], 'readonly');
    const store = tx.objectStore(STORE_RECORDINGS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// sessions helpers (sessions.store contains array of recordingIds)
async function saveSessionToDb(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.add(session);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function updateSessionInDb(session) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.put(session);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
async function getAllSessionsFromDb() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SESSIONS], 'readonly');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getSessionById(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SESSIONS], 'readonly');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.get(Number(id));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function deleteSessionFromDb(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const store = tx.objectStore(STORE_SESSIONS);
    const req = store.delete(Number(id));
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// Expor funções globalmente (para uso por recorder.js e outros)
window.openDb = openDb;
window.saveRecordingToDbObj = saveRecordingToDbObj;
window.getRecordingById = getRecordingById;
window.deleteRecordingById = deleteRecordingById;
window.getAllRecordingsFromDb = getAllRecordingsFromDb;
window.saveSessionToDb = saveSessionToDb;
window.updateSessionInDb = updateSessionInDb;
window.getAllSessionsFromDb = getAllSessionsFromDb;
window.getSessionById = getSessionById;
window.deleteSessionFromDb = deleteSessionFromDb;