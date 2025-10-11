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
  // Observação: troquei o colormap de 'viridis' para 'magma' para evitar tons
  // azul/verde/amarelo que conflitam com algumas cores de cluster.
  window.appConfig.spectrogram = {
    fftSize: 2048,
    hopSize: 512,
    nMels: 64,
    windowType: 'hann',
    colormap: 'magma', // mudado de 'viridis' para 'magma' (menos azul)
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
    useSegmenter: true,
    preRollFraction: 0.0,
    postRollFraction: 0.0,
    minPreRollMs: 0,
    minPostRollMs: 0
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

  // PCA Incremental (novos parâmetros para estabilidade e alertas)
  window.appConfig.pca = {
    components: 8,
    learningRate: 0.05,            // base learning rate
    lrDecayFactor: 1.0,           // multiplicador adicional (1.0 = sem mudança)
    lrPower: 0.5,                 // lr = base / (nObs^lrPower), default sqrt -> 0.5
    maxEpochs: 1,
    reorthogonalizeEvery: 3000,

    // fallback / robustez
    minFramesForBatchFallback: 30, // se menos de N frames, usar PCA batch (determinístico) para inicializar/treinar
    minFramesForGood: 200,         // se menor, emitir alerta de poucas amostras
    degenerateThreshold: 1e-6,     // norma menor que isto => degenerada
    replaceDegenerateWithBatch: true, // se degeneradas, substituir componentes pelo PCA batch inteiro

    // seed para inicialização determinística (null ou número). Se definido, a inicialização das componentes é determinística
    initSeed: null,

    // quando true, em caso de poucos frames em uma gravação, registra aviso (e retorna no model.warnings)
    alertOnLowSamples: true,
    minSamplesPerRecordingToWarn: 4,

    // Filtragem de silêncio (pré-processamento)
    silenceFilterEnabled: true,
    silenceRmsRatio: 0.05,
    minSilenceFrames: 5,
    minSpeechFrames: 3,
    keepSilenceFraction: 0.0,

    logMel: false,
    normalizeCentroid: false,
    applyZScore: false
  };

  // NOVA SEÇÃO: configurações do overlay de cluster (ajustáveis aqui)
  window.appConfig.clusterOverlay = {
    // altura da barra (px) quando mode === 'bar'
    barHeight: 20,
    // opacidade da barra (0.0 - 1.0)
    barAlpha: 0.75,
    // paleta opcional; se null, o overlay usa sua paleta interna
    // Exemplo: ['#e41a1c','#ff7f00','#4daf4a', ...]
    clusterPalette: null,
    // se true, desenha a linha preta de separação na base da barra (melhora contraste)
    drawBaseLine: true
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
      pca: Object.assign({}, window.appConfig.pca, proc.pca || {}),
      clusterOverlay: Object.assign({}, window.appConfig.clusterOverlay, (proc.clusterOverlay || {}))
    };
  };

})();