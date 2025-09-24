# VoxScripta

VoxScripta é um projeto acadêmico simples de captura de áudio, visualização (waveform + espectrograma) e organização em sessões, feito com HTML + JavaScript puro (sem frameworks pesados).

O foco principal é ser didático, leve e fácil de modificar, incluindo:
- Gravação via MediaRecorder
- Processamento básico (AGC, fade-in curto)
- Visualização de waveform e espectrograma (Mel) via Web Worker
- Persistência local em IndexedDB (gravações e sessões por referência)
- Importação e exportação de sessões (JSON)
- Importação de arquivos de áudio avulsos

---

## Demonstração rápida

- Clique no botão ● para gravar.
- Clique ■ para parar e a gravação aparece na lista (painel esquerdo).
- Selecione uma gravação para reproduzir e visualizar waveform + espectrograma.
- Clique “Salvar sessão” para gravar o conjunto atual de gravações como uma sessão persistente (IndexedDB).
- Você pode exportar/impotar sessões (JSON) e importar um arquivo de áudio externo.

---

## Arquitetura (arquivos principais)

- index.html
  - Estrutura da página e botões (gravação, navegação, salvar/exportar/importar sessão, importar áudio).
- style.css
  - Estilos do layout, painel lateral e componentes.
- recorder.js
  - Controla a gravação, waveform ao vivo, reprodução, e mantém o “workspace” de gravações em memória.
  - Expõe uma API mínima para o módulo de sessões (get/set/append do workspace).
  - Registra o listener do worker para desenhar o espectrograma (mensagens do worker).
- sessions.js
  - Responsável por listar sessões, salvar sessão atual, exportar/importar sessão, selecionar sessão.
  - Interage com recorder.js através da API mínima de workspace.
- audio.js
  - Utilitários de áudio (AGC, fade-in, encoder WAV) e criação do worker (ensureWorker).
  - processAndPlayBlob: decodifica, aplica AGC/fade-in e envia os dados para o worker gerar o espectrograma.
- spectrogram.worker.js
  - Worker com FFT e pipeline para gerar espectrograma em escala Mel e retornar os pixels prontos ao UI.
- db.js
  - IndexedDB v2: stores “recordings” (pool de blobs) e “sessions” (com IDs das gravações).
  - Migração em runtime do schema antigo (sessões com blobs embutidos) para referenciar por IDs.
- spectrogram.js (opcional/legado)
  - Gera espectrograma sem worker (sincrônico) e desenha direto no canvas.
  - Hoje o fluxo principal usa o worker de audio.js; este arquivo pode ser removido futuramente.
- history.js (legado)
  - Renderização de uma barra de histórico antiga (#history-bar). Não é utilizada pelo index atual.

---

## Como rodar localmente

Por questões de permissões de microfone, sirva via HTTP:

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

Abra http://localhost:8080/ no navegador (Chrome/Edge recentes recomendados).

Permissões:
- Aceite o uso do microfone quando solicitado.

---

## Persistência (IndexedDB)

- “recordings” (gravações) guardam { id autoIncrement, name, date, blob }.
- “sessions” guardam { id autoIncrement, name, date, recordings }, onde `recordings` é uma lista de IDs numéricos (persistidos) e, se necessário, objetos embutidos (schema antigo ou gravações ainda não persistidas). A migração em runtime move blobs embutidos para “recordings” e substitui por IDs.

Importação/Exportação:
- Exporta sessões para JSON (com blobs base64).
- Importa JSON de sessão (recria gravações no pool e restaura sessão).

---

## Opções de processamento

Use `window.processingOptions` (definida em recorder.js e audio.js) para ajustar:
- AGC (targetRMS, maxGain, limiterThreshold)
- Espectrograma (fftSize, hopSize, nMels, colormap, etc.)

Novas opções no worker (ver “Qualidade do espectrograma”):
- preserveNativeResolution (boolean)
- outputScale (number)

Exemplo (no DevTools, antes de gravar):
```js
window.processingOptions = window.processingOptions || {};
window.processingOptions.spectrogram = Object.assign({}, window.processingOptions.spectrogram, {
  nMels: 128,
  preserveNativeResolution: true,
  outputScale: 2
});
```

---

## Qualidade do espectrograma

Se a imagem parecer “pixelada” ou com “blocos” grandes, ajuste:
- nMels (por ex. 128) para aumentar resolução vertical.
- preserveNativeResolution: true para gerar 1 coluna por frame (sem forçar largura mínima).
- outputScale: 2 (ou 1.5) para supersampling no worker e downscale suave no UI.
- Opcional: desative smoothing ao desenhar, se preferir “pixels nítidos”.

Cuidado: valores muito altos aumentam custo de CPU/memória.

---

## Solução de problemas

- Spectrograma “preto” ou vazio: certifique-se de que `spectrogram.worker.js` está acessível (audio.js primeiro tenta Worker('spectrogram.worker.js'); o fallback inline é simplificado).
- Nada salva no IndexedDB: verifique permissões, e que `db.js` é carregado antes de `recorder.js/sessions.js`. A migração runtime foi corrigida para evitar deadlock (não chama openDb recursivamente).
- Prompt "Salvar sessão" aparecendo duas vezes: evite listeners duplicados (somente sessions.js deve cuidar do clique).

---

## Roadmap sugerido (mudanças progressivas, com testes)

1) Remoção de scripts legados (após teste):
   - Remover `spectrogram.js` e `history.js` se confirmarmos que não são usados. Testes:
     - Gravar, parar, ver waveform e espectrograma; salvar sessão, exportar e importar.
     - Verificar Console (sem erros de referência a #history-bar/showSpectrogram).

2) Refinos de UI/UX:
   - Badge de “persistido” já existe; adicionar spinner pequeno até persistir (opcional).
   - Botão de “Inspecionar DB” (debug) exibindo counts e itens (apenas dev).

3) Refino de espectrograma (opcional):
   - Tornar `preserveNativeResolution` e `outputScale` configuráveis via UI (pequeno painel avançado).
   - Ajustar defaults após medição de desempenho.

4) Organização do código:
   - Manter `recorder.js` focado em gravação/play/visual.
   - Manter `sessions.js` para sessões e `db.js` para IndexedDB.
   - `audio.js` lida com processamento e worker.

Cada passo deve ser testado isoladamente (gravar/reproduzir/salvar sessão/export/import).

---

## Licença

Uso acadêmico/didático. Ajuste conforme a necessidade do seu projeto.