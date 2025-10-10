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
    safetyPaddingMs: 10,

    // NOVO: integração com segmentador e pré/pós-roll configuráveis
    // Etapa 1: segmentador ligado, pré/pós-roll = 0 (ajuste depois)
    useSegmenter: true,
    preRollFraction: 0.0,   // depois ajuste para 0.05 (5%) se quiser “um pouquinho” antes
    postRollFraction: 0.0,  // pode ajustar para 0.02 por ex., se desejar
    minPreRollMs: 0,        // mínimo absoluto para pré-roll, em ms
    minPostRollMs: 0        // mínimo absoluto para pós-roll, em ms
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
  window.appConfig.pca = {
    components: 8,
    learningRate: 0.05,
    maxEpochs: 1,
    reorthogonalizeEvery: 3000,

    // Filtragem de silêncio (incremental)
    silenceFilterEnabled: true,
    silenceRmsRatio: 0.05,
    minSilenceFrames: 5,
    minSpeechFrames: 3,
    keepSilenceFraction: 0.10,

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