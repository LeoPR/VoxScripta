// app-compat.js
// Etapa 1: camada leve de compatibilidade.
// - Cria namespaces: App.core, App.models, App.ui.
// - Fornece aliases (somente getters) para as globais já existentes.
// - Não altera comportamento. Seguro carregar em qualquer momento após os módulos.

(function(){
  'use strict';

  // cria árvore
  const App = (window.App = window.App || {});
  App.core   = App.core   || {};
  App.models = App.models || {};
  App.ui     = App.ui     || {};

  function defineAlias(target, prop, getter) {
    try {
      if (Object.prototype.hasOwnProperty.call(target, prop)) return;
      Object.defineProperty(target, prop, {
        enumerable: true,
        configurable: true,
        get: getter
      });
    } catch (_) { /* silencioso */ }
  }

  // Core
  defineAlias(App.core, 'appConfig', () => window.appConfig);
  defineAlias(App.core, 'ensureWorker', () => window.ensureWorker);
  defineAlias(App.core, 'applyAGC', () => window.applyAGC);
  defineAlias(App.core, 'encodeWAV', () => window.encodeWAV);
  defineAlias(App.core, 'processAndPlayBlob', () => window.processAndPlayBlob);

  defineAlias(App.core, 'db', () => ({
    openDb: window.openDb,
    saveRecordingToDbObj: window.saveRecordingToDbObj,
    getRecordingById: window.getRecordingById,
    updateRecordingInDb: window.updateRecordingInDb,
    deleteRecordingById: window.deleteRecordingById,
    getAllRecordingsFromDb: window.getAllRecordingsFromDb,
    saveSessionToDb: window.saveSessionToDb,
    updateSessionInDb: window.updateSessionInDb,
    getAllSessionsFromDb: window.getAllSessionsFromDb,
    getSessionById: window.getSessionById,
    deleteSessionFromDb: window.deleteSessionFromDb
  }));

  // Models - PCA
  defineAlias(App.models, 'pca', () => ({
    dataPrep: window.pcaDataPrep,
    batch: window.pcaBatch,
    diagnostics: window.pcaDiagnostics,
    // função incremental principal
    runIncrementalPCAOnTrainPool: window.runIncrementalPCAOnTrainPool
  }));

  // Models - KMeans
  defineAlias(App.models, 'kmeansEvaluator', () => window.kmeansEvaluator);
  defineAlias(App.models, 'kmeans', () => window.kmeans);

  // UI
  defineAlias(App.ui, 'pcaVisualizer', () => window.pcaVisualizer);
  defineAlias(App.ui, 'modelStore', () => window.modelStore);
  defineAlias(App.ui, 'analyzerOverlay', () => window.analyzerOverlay);
  defineAlias(App.ui, 'uiAnalyzer', () => window.uiAnalyzer);

  // Util: manter acesso ao Train Pool e gravações
  defineAlias(App.ui, 'workspace', () => ({
    getRecordings: (typeof window.getWorkspaceRecordings === 'function') ? window.getWorkspaceRecordings : () => window.recordings || [],
    setRecordings: (typeof window.setWorkspaceRecordings === 'function') ? window.setWorkspaceRecordings : (arr) => { window.recordings = Array.isArray(arr)?arr:[]; },
    addRecording: (typeof window.appendWorkspaceRecording === 'function') ? window.appendWorkspaceRecording : null
  }));

  // KMeans Auto K ensure (caso exista)
  defineAlias(App.ui, 'kmeansAutoEnsure', () => window.kmeansAutoEnsure);

  // OK
  try { console.debug('[app-compat] namespaces disponíveis em window.App'); } catch (_) {}
})();