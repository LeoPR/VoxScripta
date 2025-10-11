# VoxScripta — Resumo das alterações recentes (Auto‑K, PCA/KMeans e overlay)

Este README resume as mudanças feitas no projeto para suportar busca automática de K no KMeans, integração com o PCA ativo, melhorias na visualização do overlay e configurações ajustáveis.

O que foi adicionado
- kmeans-evaluator.js
  - Executa KMeans para um intervalo Kmin..Kmax com inicialização kmeans++ e múltiplas reinicializações (n_init).
  - Calcula métricas: inertia (SSE), silhouette (amostrado), Calinski‑Harabasz (CH) e Davies‑Bouldin (DB).
  - API: `window.kmeansEvaluator.runRange(Xflat, nRows, dim, options)` → Promise<results>.

- kmeans-auto-ui.js
  - Painel "Auto K (KMeans)" adicionado ao Train Pool (UI).
  - Coleta features projetadas pelo PCA do Train Pool (frames de fala), executa avaliação por K, plota Inertia × K e Silhouette × K e lista resultados.
  - Permite "Selecionar" um K: aplica o modelo (cria `window._kmeansModel`) e dispara `training-changed`.
  - Usa mais componentes do PCA (até 8) para clustering — evita reduzir para 2 dimensões antes de clusterizar.

- spectrogram-cluster-overlay.js
  - Overlay de clusters (barras no rodapé) — já ajustado para desenhar no rodapé, usar configuração de `window.appConfig.clusterOverlay` (barHeight/barAlpha/drawBaseLine) e paleta de alto contraste.
  - Botões foram movidos para fora do wrapper para não cobrir o espectrograma.

- config.js
  - Nova seção `window.appConfig.clusterOverlay` com `barHeight`, `barAlpha`, `clusterPalette`, `drawBaseLine`.
  - Colormap do espectrograma alterado para `magma` para reduzir conflito com paleta de clusters.

Como usar (fluxo)
1. Abra gravações e clique em "Analisar (features)" para gerar `rec.__featuresCache`.
2. Monte o Train Pool com gravações representativas.
3. Rode PCA incremental e selecione/ative o PCA salvo (deve gerar `window._pcaModel`).
4. Abra o painel "Train Pool" → "Auto K (KMeans)":
   - Ajuste Kmin/Kmax/nInit, clique em Executar.
   - Analise os gráficos (Inertia e Silhouette) e a tabela de resultados.
   - Clique em "Selecionar" no K desejado para aplicar o `window._kmeansModel`.
5. Abra o overlay do espectrograma e clique/visualize os clusters.

Notas de calibração (recomendadas)
- Para detectar diferenças finas (ex.: “oi” vs subunidades “o” e “i”):
  - Use mais componentes do PCA (4–8) para clustering (o código já usa até 8).
  - Aumente resolução temporal (hopSize menor) ou inclua contexto temporal (concatenar frames) se necessário.
  - Ajuste segmentação de fala (`appConfig.analyzer`) para não eliminar pequenos fragmentos.
- Métrica recomendada para escolher K: use a silhouette média (valores mais altos indicam clusters mais coerentes). Compare com inertia (elbow) como verificação.

Próximos passos (sugestões, após testes)
- Mover a execução do Auto‑K para WebWorker para grandes datasets.
- Implementar opção de concatenar contexto temporal (delta frames) antes do PCA.
- Persistência: salvar snapshot do K selecionado no model-store.

---

Se preferir, eu adapto os defaults (por exemplo Kmax=12, ou dimCluster=10) — me diga e eu atualizo os arquivos mínimos que entreguei.  