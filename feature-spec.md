# Feature Spec: Resource-Aware Streaming Pause + System Resource Monitor

## Contesto del Progetto

Questo progetto è un servizio web-terminal che gira su una VM **e2-2-micro** (Google Cloud), con risorse estremamente limitate (~2 vCPU condivise, ~1GB RAM). Attraverso il servizio, gli utenti aprono terminali interattivi (gestiti tramite **node-pty** e **tmux**) e possono eseguire operazioni pesanti come `npm install`, `tsc`, `vitest`, ecc., che facilmente esauriscono la RAM e la CPU, portando a crash OOM (Out Of Memory).

L'obiettivo è implementare **due feature**:

1. **Sistema di Pausa/Resume Streaming Adattivo** — Quando il carico CPU sale, il sistema riduce o interrompe il traffico WebSocket per liberare risorse alla VM, mantenendo il terminale attivo in background tramite tmux.
2. **Widget Monitor Risorse** — Un componente UI sempre visibile che mostra in tempo reale CPU, RAM e (se disponibile) GPU della VM, con indicatori cromatici che riflettono il livello di pressione.

---

## Prima di Iniziare: Esplora il Progetto

Prima di scrivere qualsiasi codice, leggi attentamente la struttura del progetto:
- Identifica dove si trovano i WebSocket server-side (probabilmente Express + ws/socket.io)
- Identifica dove viene gestito il PTY (node-pty) e tmux
- Identifica la struttura del frontend (React / Vue / Vanilla JS / ecc.)
- Identifica se esiste già un endpoint `/api/health` o simile
- Identifica il file di configurazione/impostazioni del sito (settings, config, ecc.)
- Leggi la documentazione esistente nel repository

Adatta l'implementazione all'architettura già esistente.

---

## Feature 1: Resource-Aware Streaming Pause

### Logica di Business

Il sistema monitora continuamente il carico CPU della VM e agisce in base a tre soglie configurabili:

| Soglia | Comportamento |
|---|---|
| CPU < soglia_low (default 80%) | Streaming normale |
| 80% ≤ CPU < soglia_high (default 90%) | **Approccio 1**: Pausa soft dello streaming |
| CPU ≥ soglia_high (default 90%) | **Approccio 3**: Chiusura drastica WebSocket + reconnect |

### Approccio 1 — Pausa Soft (80%-90% CPU)

**Descrizione**: Il server smette di inoltrare i dati dal PTY al WebSocket client, ma lascia girare il processo PTY e tmux indisturbati. I dati continuano ad accumularsi nel buffer tmux. Quando la pressione scende, il server usa `tmux capture-pane` per recuperare l'output perso e lo invia al client, poi riprende lo streaming normale.

**Implementazione server-side**:

```
Quando CPU entra in zona 80-90%:
1. Imposta flag isPaused = true per ogni sessione terminale attiva
2. Invia al client un messaggio JSON di controllo:
   { type: 'stream-pause', reason: 'high-cpu', cpu: <valore> }
3. Nel loop di forwarding PTY→WS: se isPaused === true, scarta i dati in arrivo dal PTY
   (non inviarli al WebSocket, ma lasciali scorrere nel buffer tmux)
4. Smetti di inviare heartbeat/keepalive pesanti

Quando CPU scende sotto soglia_low:
1. Imposta isPaused = false
2. Recupera output perso: esegui `tmux capture-pane -p -t <session>` 
3. Invia al client:
   { type: 'stream-resume', buffered: '<output catturato>' }
4. Riprendi il forwarding normale PTY→WS
```

**Implementazione client-side**:

```
On message { type: 'stream-pause' }:
- Mostra overlay/banner sul terminale: "⏸ Streaming in pausa – risorse VM in uso"
- Disabilita l'input utente (o mostralo grigio/disabilitato)
- Aggiorna il widget monitor risorse con stato WARN

On message { type: 'stream-resume', buffered }:
- Scrivi buffered nel terminale (xterm.js write)
- Rimuovi overlay
- Riabilita input
- Aggiorna widget con stato OK
```

### Approccio 3 — Chiusura Drastica (>90% CPU)

**Descrizione**: Il server chiude il WebSocket e termina il processo node-pty. La sessione tmux rimane viva. Quando il carico scende, il client riconnette e il server riapre un PTY agganciato alla sessione tmux esistente (`tmux attach-session`), recuperando tutto lo stato.

**Implementazione server-side**:

```
Quando CPU ≥ soglia_high:
1. Per ogni sessione attiva:
   a. Invia al client: { type: 'stream-kill', reason: 'critical-cpu', cpu: <valore> }
   b. Attendi 500ms (per dare tempo al client di ricevere il messaggio)
   c. Chiudi il WebSocket: ws.close()
   d. Killa il processo node-pty: pty.kill()
   e. La sessione tmux rimane attiva nella VM
   f. Salva in memoria/redis: { sessionId, tmuxSession, status: 'suspended' }

Quando CPU scende sotto soglia_low:
1. Non fare nulla lato server (attendi la riconnessione del client)
```

**Implementazione client-side**:

```
On message { type: 'stream-kill' }:
- Mostra overlay: "🔴 Connessione sospesa – VM sotto pressione critica"
- Avvia polling su /api/health ogni 3 secondi
- Quando /api/health risponde con cpu < soglia_low:
  - Tenta reconnect WebSocket
  - Alla connessione, invia: { type: 'resume-session', sessionId }
  - Server riapre PTY agganciato a tmux esistente
  - Server invia capture-pane dell'output perso
  - Rimuovi overlay
```

### Resource Governor (modulo server)

Crea un modulo dedicato `resourceGovernor.js` (o `.ts`) che:

- Campiona le metriche CPU ogni **2 secondi** usando `os.loadavg()` o leggendo `/proc/stat` per un valore più accurato
- Campiona la RAM usando `process.memoryUsage()` e `/proc/meminfo`
- Mantiene uno stato interno: `'ok' | 'warn' | 'critical'`
- Emette eventi (`EventEmitter`) quando lo stato cambia: `'state-change'`, `'metrics-update'`
- Espone le metriche correnti tramite un getter

```javascript
// Struttura suggerita
class ResourceGovernor extends EventEmitter {
  constructor(config) {
    // config.warnThreshold (default 0.80)
    // config.criticalThreshold (default 0.90)  
    // config.sampleIntervalMs (default 2000)
  }
  
  start() { /* avvia il polling */ }
  stop() { /* ferma il polling */ }
  
  getMetrics() {
    return {
      cpu: 0.0-1.0,      // utilizzo CPU normalizzato
      ram: 0.0-1.0,      // utilizzo RAM normalizzato
      ramUsedMb: number,
      ramTotalMb: number,
      state: 'ok'|'warn'|'critical'
    }
  }
  
  // Events: 'metrics-update', 'state-change'
}
```

Il governor deve essere un **singleton** condiviso da tutto il server, non istanziato per ogni sessione.

### Integrazione con il WebSocket Handler

Nel handler delle connessioni WebSocket terminale:

```javascript
governor.on('state-change', (newState, metrics) => {
  for (const session of activeSessions) {
    if (newState === 'warn' && session.streamState === 'active') {
      session.pauseStreaming(metrics);
    } else if (newState === 'critical' && session.streamState !== 'killed') {
      session.killStreaming(metrics);
    } else if (newState === 'ok') {
      session.resumeStreaming();
    }
  }
});
```

---

## Feature 2: Widget Monitor Risorse

### Architettura

Il frontend fa **polling su `/api/health`** ogni 5 secondi in condizioni normali, aumentando a ogni 2 secondi quando lo stato è `warn` o `critical` (polling adattivo).

### Endpoint `/api/health`

Se non esiste, crealo. Deve rispondere con:

```json
{
  "status": "ok" | "warn" | "critical",
  "cpu": 0.72,
  "ram": 0.61,
  "ramUsedMb": 620,
  "ramTotalMb": 1024,
  "gpu": null,
  "uptime": 3600,
  "streamingPaused": false,
  "timestamp": 1234567890
}
```

Per il campo `gpu`: usa `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits` se disponibile, altrimenti restituisci `null`.

### Componente UI: Resource Monitor Widget

Il widget deve essere **sempre visibile** nell'interfaccia, posizionato nell'header o in una barra fissa. Il design deve essere di alta qualità, professionale e non generico.

**Requisiti visivi**:

- Mostra tre metriche: **CPU**, **RAM**, **GPU** (GPU mostrata come `N/A` se non disponibile)
- Per ogni metrica: una barra di progresso orizzontale o un indicatore circolare + valore percentuale
- **Cambio colore dinamico** basato sulla soglia:
  - `ok` (< 80%): Verde / teal (es. `#22c55e` o simile)
  - `warn` (80-90%): Giallo/arancio (es. `#f59e0b`)
  - `critical` (>90%): Rosso con **animazione pulsante** (es. `#ef4444` + pulse CSS)
- Transizioni CSS fluide tra i colori (non cambi bruschi)
- Quando lo streaming è in pausa (`streamingPaused: true`): mostra un'icona di pausa ⏸ e una scritta "Streaming Paused" in `warn` color
- Quando è in stato `critical`: mostra "Stream Suspended" + icona 🔴 lampeggiante

**Tooltip/Drawer espanso**:
- Al click/hover sul widget, mostra un pannello espanso con:
  - Valori esatti: `RAM: 620 MB / 1024 MB`
  - Uptime della VM
  - Stato corrente dello streaming
  - Le soglie configurate (`warn: 80%`, `critical: 90%`)

**Design e Stile**:
- Il widget deve integrarsi con il design system esistente del progetto
- Usa CSS variables per i colori in modo da rispettare temi light/dark
- Le barre di progresso devono avere transizioni `transition: width 0.5s ease, background-color 0.3s ease`
- Evita stili generici/stock — il widget deve avere carattere visivo proprio
- Usa font monospace per i valori numerici (es. `font-variant-numeric: tabular-nums`)

**Pseudo-struttura del componente** (adatta al framework usato):

```
<ResourceMonitor>
  <MetricBar label="CPU" value={cpu} state={cpuState} />
  <MetricBar label="RAM" value={ram} state={ramState} />
  <MetricBar label="GPU" value={gpu} state={gpuState} />
  <StreamingStatus paused={streamingPaused} suspended={streamingSuspended} />
</ResourceMonitor>
```

---

## Feature 3: Impostazioni Configurabili

Aggiungi una sezione nelle impostazioni del sito (settings page/panel) per configurare:

| Impostazione | Default | Descrizione |
|---|---|---|
| `cpu_warn_threshold` | 80 | % CPU sotto cui lo streaming è normale |
| `cpu_critical_threshold` | 90 | % CPU oltre cui si chiude drasticamente |
| `health_poll_interval` | 5000 | ms tra un poll e l'altro in stato ok |
| `health_poll_interval_fast` | 2000 | ms tra un poll in stato warn/critical |
| `streaming_pause_enabled` | true | Abilita/disabilita la pausa soft |
| `streaming_kill_enabled` | true | Abilita/disabilita la chiusura drastica |

Queste impostazioni devono essere:
- **Persistite** (file JSON, DB locale, o variabili d'ambiente — usa il metodo già usato nel progetto)
- **Lette dal Resource Governor** all'avvio e aggiornate in tempo reale quando cambiate dalla UI senza restart del server
- **Visibili nel widget espanso** del monitor risorse

---

## Note Implementative Critiche

### Campionamento CPU accurato su Linux

`os.loadavg()` restituisce il load average (media su 1/5/15 min), NON l'utilizzo istantaneo. Per un valore più preciso e reattivo, leggi `/proc/stat` due volte a distanza di 100ms e calcola la differenza:

```javascript
async function getCpuUsage() {
  const [a, b] = await Promise.all([readProcStat(), delay(100).then(readProcStat)]);
  const idle = (b.idle - a.idle);
  const total = (b.total - a.total);
  return 1 - idle / total; // 0.0-1.0
}
```

### Evitare feedback loops

Il Resource Governor stesso consuma CPU. Assicurati che il polling interval non sia troppo basso (minimo 1500ms) e che le operazioni di campionamento siano leggere (solo lettura file, no exec di processi pesanti ad ogni ciclo tranne nvidia-smi che può essere fatto ogni 10s).

### Sicurezza del tmux capture-pane

Quando recuperi l'output con `tmux capture-pane`:
- Limita l'output alle ultime N righe (es. `tmux capture-pane -p -S -200`) per non mandare megabyte di dati al client
- Sanitizza l'output prima di inviarlo (rimuovi sequenze ANSI anomale se necessario)
- Metti un timeout sull'esecuzione del comando (max 2s)

### Gestione delle sessioni multiple

Se più terminali sono aperti contemporaneamente:
- Il governor è uno solo e condiviso
- Quando lo stato è `warn`, si mettono in pausa TUTTE le sessioni attive
- Quando lo stato torna `ok`, si riprendono TUTTE le sessioni

### Evitare race conditions nel resume

Quando lo stato passa da `critical` → `ok`:
- Il server non deve inviare immediatamente il resume — aspetta che il client si riconnetta e invii `{ type: 'resume-session' }`
- Metti un debounce di 3 secondi prima di considerare lo stato "stabilmente ok"

---

## Checklist di Completamento

- [ ] Modulo `ResourceGovernor` con campionamento CPU/RAM accurato da `/proc/stat` e `/proc/meminfo`
- [ ] Endpoint `GET /api/health` che restituisce metriche + stato streaming
- [ ] Logica di pausa soft (Approccio 1) integrata nel WebSocket handler
- [ ] Logica di kill drastico (Approccio 3) integrata nel WebSocket handler
- [ ] Messaged di controllo client-side: `stream-pause`, `stream-resume`, `stream-kill`
- [ ] Overlay/banner UI sul terminale durante pausa e sospensione
- [ ] Polling adattivo del frontend su `/api/health`
- [ ] Componente `ResourceMonitor` con barre CPU/RAM/GPU
- [ ] Cambio colore dinamico: verde/giallo/rosso con animazione pulse su critical
- [ ] Tooltip/drawer espanso con dettagli
- [ ] Sezione impostazioni con tutte le soglie configurabili
- [ ] Le impostazioni vengono lette dal governor in tempo reale
- [ ] Le impostazioni mostrano i valori attuali nel widget espanso
- [ ] Nessun polling più frequente di 1500ms per non aggravare il carico
- [ ] Test manuale: simula carico alto (`stress-ng` o loop bash) e verifica che il sistema reagisca correttamente
