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

  // Gravação / MediaRecorder defaults
  window.appConfig.recording = {
    mimeType: 'audio/webm',
    maxSilenceMs: 60000
  };

  // UI / processamento indicator / telemetria
  window.appConfig.ui = {
    showProcessingIndicator: true,
    imageSmoothingEnabled: false
  };

  // Telemetria / debug
  window.appConfig.telemetry = {
    enabled: true,
    sendToConsole: true
  };

  // Mescla com window.processingOptions (se existir) para compatibilidade
  window.appConfig.getMergedProcessingOptions = function() {
    const proc = window.processingOptions || {};
    return {
      agc: Object.assign({}, window.appConfig.agc, proc.agc || {}),
      spectrogram: Object.assign({}, window.appConfig.spectrogram, proc.spectrogram || {}),
      waveform: Object.assign({}, window.appConfig.waveform, proc.waveform || {}),
      ui: Object.assign({}, window.appConfig.ui, proc.ui || {}),
      recording: Object.assign({}, window.appConfig.recording, proc.recording || {}),
      telemetry: Object.assign({}, window.appConfig.telemetry, proc.telemetry || {})
    };
  };

})();