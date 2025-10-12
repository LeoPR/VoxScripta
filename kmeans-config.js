// kmeans-config.js
// Pequeno arquivo opcional para definir defaults do Auto K sem alterar config.js original.
// Incluir após config.js no index.html (opcional).

(function(){
  window.appConfig = window.appConfig || {};
  window.appConfig.kmeans = window.appConfig.kmeans || {};
  window.appConfig.kmeans.autoK = Object.assign({
    minRmsQuantile: 0.15,
    defaultKmin: 3,
    defaultKmax: 10,
    defaultNInit: 10
  }, window.appConfig.kmeans.autoK || {});
})();