# GEMINI.md — Ambiente di Programmazione Agentico

Questo file contiene i mandati fondamentali e le linee guida operative per Gemini CLI all'interno del progetto **Remote VibeCoder**. Queste istruzioni hanno la precedenza sui flussi di lavoro generali.

## Panoramica del Progetto
**Remote VibeCoder** è un'applicazione web leggera per eseguire agenti AI (come Claude Code) o shell remote da browser mobile.
- **Backend:** Node.js, Express, `node-pty`, `tmux`.
- **Frontend:** React 18, TypeScript, Vite (migrazione in corso da vanilla HTML/JS).
- **Infrastruttura:** VM GCP e2-micro (1GB RAM + 2GB swap), Cloudflare Tunnel/Nginx.

## Mandati Fondamentali

### 1. Sicurezza e Integrità
- **Protezione Credenziali:** Non loggare, stampare o committare mai `githubPat`, hash delle password o secret di sessione. Proteggere rigorosamente `~/.claude-mobile/config.json`.
- **Prevenzione Path Traversal:** Validare sempre i percorsi dei file utilizzando `realpathSync()` e verificando che si trovino all'interno della root del repository.
- **Sanitizzazione:** Sanitizzare ogni input utente che viene passato a comandi shell o `tmux`.

### 2. Standard Ingegneristici

#### Frontend (React + TypeScript)
- **Componenti Atomici:** Seguire rigorosamente la struttura definita in `UI Component Library.md`.
- **CSS Modules:** Usare file `.module.css` per lo scoping locale degli stili.
- **Design Tokens:** Utilizzare esclusivamente i token definiti in `client-src/src/styles/tokens.ts`.
- **Barrel Exports:** Esportare i componenti tramite `index.ts` nelle relative cartelle.
- **TypeScript Strict:** Mantenere `strict: true` nel `tsconfig.json`. Evitare `any`.

#### Backend (Node.js)
- **Gestione Sessioni:** Ogni sessione tmux deve seguire il pattern `claude-{repo}-{shortId}`.
- **PTY Bridge:** Gestire con cura il buffering dello scrollback (limite 256 KB) per evitare crash su e2-micro.
- **Compatibilità:** Mantenere il supporto legacy per le rotte esistenti durante il refactoring.

### 3. Prestazioni su Hardware Limitato
- Il progetto gira su una istanza **e2-micro** (1GB RAM). Ogni modifica deve essere ottimizzata per il consumo minimo di risorse.
- Evitare build pesanti se non necessarie; preferire `npm run typecheck` per la validazione veloce.

## Flusso di Lavoro Operativo

### Ricerca e Strategia
1. **Analisi:** Prima di ogni modifica, analizzare `CURRENT_CONTEXT.md` e `CLAUDE.md`.
2. **Pianificazione:** Per task complessi, fare riferimento ai piani in `docs/superpowers/plans/`.
3. **Validazione:** Dopo ogni modifica, eseguire `npm run typecheck` nel frontend e verificare la sintassi nel backend.

### Comandi Utili
```bash
# Frontend (client-src)
npm run dev        # Sviluppo locale
npm run build      # Build di produzione
npm run typecheck  # Validazione tipi (MANDATORIO prima di finire un task)

# Backend (server)
npm run dev        # Server con hot-reload
npm start          # Produzione

# Sistema
sudo systemctl status claude-mobile@$USER
sudo journalctl -u claude-mobile@$USER -f
```

## Stato Attuale (Multi-terminal Management)
Siamo nella fase di implementazione del supporto multi-terminale.
- **Prossimo Task:** Implementazione del componente `RepoSelector`.
- **Riferimento:** `docs/superpowers/plans/2026-03-18-multi-terminal.md`.

## Istruzioni per Gemini
- Mantieni sempre aggiornato `CURRENT_CONTEXT.md` con l'avanzamento dei task e i commit effettuati.
- Non committare senza autorizzazione esplicita.
- In caso di errori di build/tipizzazione, risolvili prima di dichiarare il task completato.
- Interagisci in **italiano** con l'utente, mantenendo un tono tecnico e professionale.
