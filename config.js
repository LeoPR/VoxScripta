// Configuração central do VoxScripta
// Carregue este arquivo ANTES de audio.js e recorder.js no index.html.
// Expõe window.appConfig e getMergedProcessingOptions() para mesclar com window.processingOptions.

(function(){
  window.appConfig = window.appConfig || {};

  // AGC / processamento de áudio
  window.appConfig.agc = {
    targetRMS: 0.08,
    maxGain: 8,
    limiterThreshold: 0.99,
    fadeMs: 20
  };

  // Espectrograma (worker e visualização)
  window.appConfig.spectrogram = {
    fftSize: 2048,
    hopSize: 512,
    nMels: 64,
    windowType: 'hann',
    colormap: 'viridis',
    preserveNativeResolution: false,
    outputScale: 1,
    logScale: true,
    dynamicRange: 80,
    fmin: 0,
    fmax: null
  };

  // Waveform (visual)
  window.appConfig.waveform = {
    visualHeight: 180,
    samplesPerPixel: 512,
    imageSmoothing: false
  };

  // Trim de silêncio
  window.appConfig.trim = {
    threshold: 0.01,
    chunkSizeMs: 10,
    minNonSilenceMs: 50,
    safetyPaddingMs: 10
  };

  // Gravação
  window.appConfig.recording = {
    mimeType: 'audio/webm',
    maxSilenceMs: 60000
  };

  // UI
  window.appConfig.ui = {
    showProcessingIndicator: true,
    imageSmoothingEnabled: false
  };

  // Telemetria
  window.appConfig.telemetry = {
    enabled: true,
    sendToConsole: true
  };

  // Analyzer (segmentação / RMS)
  window.appConfig.analyzer = {
    silenceRmsRatio: 0.12,
    smoothingFrames: 3,
    minSilenceFrames: 5,
    minSpeechFrames: 3
  };

  // PCA Incremental
  // Novos campos para filtragem de silêncio inicial
  window.appConfig.pca = {
    components: 8,
    learningRate: 0.05,
    maxEpochs: 1,
    reorthogonalizeEvery: 3000,

    // Filtragem de silêncio (primeiro passo incremental)
    silenceFilterEnabled: true,
    silenceRmsRatio: 0.05,       // frame é silêncio se RMS < maxRMSGlobal * ratio
    minSilenceFrames: 5,         // funde micro-segmentos de silêncio muito curtos em fala
    minSpeechFrames: 3,          // funde micro-segmentos de fala muito curtos em silêncio
    keepSilenceFraction: 0.10,   // fração máxima de silêncio a manter após filtragem (0.10 = 10%)

    // (Próximas etapas futuras: logMel, centroid normalization, z-score etc.)
    logMel: false,
    normalizeCentroid: false,
    applyZScore: false
  };

  // Mescla
  window.appConfig.getMergedProcessingOptions = function() {
    const proc = window.processingOptions || {};
    return {
      agc: Object.assign({}, window.appConfig.agc, proc.agc || {}),
      spectrogram: Object.assign({}, window.appConfig.spectrogram, proc.spectrogram || {}),
      waveform: Object.assign({}, window.appConfig.waveform, proc.waveform || {}),
      trim: Object.assign({}, window.appConfig.trim, proc.trim || {}),
      ui: Object.assign({}, window.appConfig.ui, proc.ui || {}),
      recording: Object.assign({}, window.appConfig.recording, proc.recording || {}),
      telemetry: Object.assign({}, window.appConfig.telemetry, proc.telemetry || {}),
      analyzer: Object.assign({}, window.appConfig.analyzer, proc.analyzer || {}),
      pca: Object.assign({}, window.appConfig.pca, proc.pca || {})
    };
  };

})();