# VoxScripta

VoxScripta é um projeto acadêmico simples de captura de áudio, visualização (waveform + espectrograma) e organização em sessões, feito com HTML + JavaScript puro (sem frameworks pesados).

Principais recursos:
- Gravação via MediaRecorder
- Processamento básico (AGC, fade-in curto)
- Visualização de waveform e espectrograma (Mel) via Web Worker
- Trim de silêncio inicial (configurável via config.js)
- Persistência local em IndexedDB (gravações e sessões por referência)
- Importação e exportação de sessões (JSON)
- Backup geral (exporta/importa todas as gravações e sessões)
- Importação de arquivos de áudio avulsos

---

## Como usar (demonstração rápida)

- Clique no botão ● para gravar.
- Clique ■ para parar e a gravação aparece na lista (painel esquerdo).
- Selecione uma gravação para reproduzir e visualizar waveform + espectrograma.
- Para aplicar trim de silêncio inicial, selecione a gravação e clique em ✂️; confirme para criar uma nova gravação trimada.
- Clique “Salvar sessão” para gravar o conjunto atual de gravações como uma sessão (IndexedDB).
- Exporte/importe sessões (JSON) e faça backup geral (gravações + sessões).

---

## Arquitetura (arquivos principais)

- index.html
  - Estrutura da página e botões (gravação, navegação, salvar/exportar/importar sessão, importar áudio, backup geral).
- style.css
  - Estilos do layout, painel lateral e componentes (sem estilos inline; melhorias de acessibilidade).
- config.js
  - Fonte única de configurações (AGC, espectrograma, waveform, trim, gravação, UI, telemetria).
  - Função getMergedProcessingOptions() para mesclar com window.processingOptions (compatibilidade).
- audio.js
  - Utilitários de áudio (AGC, fade-in, encoder WAV unificado) e criação do worker (ensureWorker).
  - processAndPlayBlob: decodifica, aplica AGC/fade-in e envia para o worker gerar o espectrograma.
- spectrogram.worker.js
  - Worker com FFT e pipeline para gerar espectrograma em escala Mel e retornar os pixels prontos ao UI.
- waveform.js
  - Desenho da waveform (estático e ao vivo).
  - Trim de silêncio inicial: análise + recorte usando encodeWAV de audio.js.
  - Agora utiliza as configurações centralizadas em config.js (appConfig.trim).
- recorder.js
  - Controla a gravação, reprodução, e mantém o “workspace” de gravações em memória.
  - Delegação para waveform.js (desenho live/estático) e integração com o worker (mensagens tratadas aqui).
  - Persistência de gravações (IndexedDB) e ações da lista.
- sessions.js
  - Lista, salva, exporta e importa sessões.
  - Backup geral (exporta/importa todas as gravações e sessões).
- db.js
  - IndexedDB v2: stores recordings (blobs) e sessions (referenciam gravações por ID).
  - Migração em runtime do schema antigo (sessões com blobs embutidos).

Arquivos legados (podem ser removidos se não usados):
- spectrogram.js (espectrograma síncrono, sem worker)
- history.js (UI de histórico antiga)

---

## Configurações (config.js)

As principais opções ficam em `window.appConfig` e podem ser mescladas por `getMergedProcessingOptions()` com `window.processingOptions` (para compatibilidade).

- AGC (`appConfig.agc`)
  - targetRMS, maxGain, limiterThreshold, fadeMs

- Espectrograma (`appConfig.spectrogram`)
  - fftSize, hopSize, nMels, windowType, colormap, logScale, dynamicRange, fmin, fmax
  - preserveNativeResolution, outputScale

- Waveform (`appConfig.waveform`)
  - visualHeight, samplesPerPixel, imageSmoothing

- Trim de silêncio (`appConfig.trim`) [NOVO, centralizado]
  - threshold: limiar RMS por chunk (padrão 0.01)
  - chunkSizeMs: duração do chunk (padrão 10 ms)
  - minNonSilenceMs: quantidade mínima de “som contínuo” após o silêncio para confirmar início da voz (padrão 50 ms)
  - safetyPaddingMs: “sobrinha” de silêncio mantida antes do primeiro som para não cortar o ataque (padrão 10 ms)

Exemplo (no DevTools, antes de gravar/trimar):
```js
window.processingOptions = window.processingOptions || {};
window.processingOptions.trim = Object.assign({}, window.processingOptions.trim, {
  threshold: 0.008,
  chunkSizeMs: 10,
  minNonSilenceMs: 60,
  safetyPaddingMs: 15
});
```

---

## Qualidade do espectrograma

Se a imagem parecer “pixelada”:
- Aumente `nMels` (ex.: 128) para mais resolução vertical.
- Use `preserveNativeResolution: true` para 1 coluna por frame.
- `outputScale: 2` para supersampling no worker e downscale suave no UI.
- Ajuste `imageSmoothingEnabled` (UI) conforme preferência.

Cuidado: valores altos aumentam custo de CPU/memória.

---

## Sobre o Trim de silêncio

- A análise percorre o áudio em chunks (`chunkSizeMs`) medindo RMS e considera silêncio quando ≤ `threshold`.
- Quando encontra um chunk acima do limiar e confirma os próximos `minNonSilenceMs` (como “voz contínua”), marca o fim do silêncio no início desse chunk (aplicando `safetyPaddingMs` para não cortar o ataque).
- Correção aplicada: para silêncios longos, a marcação do fim do silêncio agora é feita no início do primeiro trecho não-silencioso confirmado, evitando falhas em que o recorte não acontecia.

Se o trim parecer conservador ou agressivo:
- Ajuste `threshold` (mais baixo = mais sensível; mais alto = considera mais coisas como som).
- Ajuste `minNonSilenceMs` (aumente para evitar “sparks”; reduza para acelerar início).
- Ajuste `safetyPaddingMs` (aumente para preservar mais do início do som).

---

## Como rodar localmente

Sirva via HTTP (permite microfone):
- Node:
  ```bash
  npx http-server -p 8080
  # ou
  npx serve .
  ```
- Python:
  ```bash
  python -m http.server 8080
  ```

Abra http://localhost:8080/ (Chrome/Edge recentes).

Permissões:
- Aceite o uso do microfone quando solicitado.

---

## Solução de problemas

- Espectrograma vazio: verifique se `spectrogram.worker.js` carrega (audio.js tenta primeiro o arquivo, depois fallback inline).
- Nada no IndexedDB: confira permissões e ordem de scripts (db.js antes de recorder.js/sessions.js).
- Acessibilidade: removidos estilos inline e corrigidos atributos ARIA; listas com role adequado.
- Erro intermitente “message channel closed”: normalmente causado por extensões do navegador; mitigação futura opcional.

---

## Licença

Uso acadêmico/didático. Ajuste conforme a necessidade do seu projeto.