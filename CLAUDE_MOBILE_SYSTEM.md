# Mobile Claude Code System — Project Brief (Evoluzione OCI)

## Contesto e obiettivo

Costruisci un sistema completo che permetta di usare Claude Code da smartphone, senza mai accendere il computer locale. L'utente deve poter aprire il browser del telefono, scegliere su quale repository GitHub lavorare, e ritrovarsi in una sessione interattiva di Claude Code.

Il sistema è nato su GCP e2-micro ma si è evoluto in un'architettura **"Nexus-Core" su Oracle Cloud Infrastructure (OCI)** per garantire potenza e versatilità.

---

## Infrastruttura Target (Evoluzione)

### Server Primario: Oracle Cloud ARM Ampere (Always Free)

- **Tipo macchina:** `VM.Standard.A1.Flex` (4 OCPU ARM, 24 GB RAM)
- **OS:** Ubuntu 24.04 LTS
- **Disco:** 200 GB Standard persistent disk
- **Sicurezza:** Shielded Instance (Secure Boot, TPM)
- **RAM:** 24 GB fisici (elimina la necessità di swap aggressiva e permette carichi paralleli)

La VM è l'unico componente che deve girare sempre. Tutto il resto (Claude Code, sessioni tmux, repo) vive dentro di essa.

### Networking

Valuta se usare:
- **Cloudflare Tunnel** (`cloudflared`, gratuito): crea un tunnel HTTPS con dominio stabile senza aprire porte nel firewall GCP. Approccio più sicuro.
- **IP statico GCP + nginx**: espone la web app su HTTPS direttamente, richiede un certificato TLS (Let's Encrypt via certbot).

Scegli l'approccio più robusto per uso mobile (connessioni intermittenti, cambio rete tra WiFi e dati).

---

## Componenti da costruire

### 1. Bootstrap script

Uno script di setup (`setup.sh`) che, eseguito una volta sulla VM fresca, installa e configura tutto:

- Node.js (versione LTS)
- npm, git, tmux
- Claude Code CLI (`@anthropic-ai/claude-code`)
- La web app di questo progetto
- Il networking scelto (Cloudflare Tunnel o nginx + certbot)
- Il servizio systemd per avviare la web app automaticamente al boot

Il risultato finale dello script deve essere una VM completamente operativa. L'unica azione manuale residua è l'autenticazione OAuth di Claude Code (un link da aprire una volta sul browser).

### 2. Web app (backend)

**Stack:** Node.js. Scegli le librerie più adatte.

**Funzionalità richieste:**

**Autenticazione:** proteggi l'intera app. L'utente configura una password (o token segreto) durante il setup. Ogni sessione richiede autenticazione prima di accedere a qualsiasi funzionalità.

**GitHub integration:** la web app deve poter elencare i repository dell'utente tramite GitHub API. L'utente configura un GitHub Personal Access Token durante il setup. La web app usa il token per chiamare l'API GitHub e recuperare la lista dei repo.

**Gestione progetti locali:** mantieni una directory locale sulla VM (`~/projects/`) dove i repo vengono clonati. La web app gestisce clone e pull automaticamente quando l'utente seleziona un repo.

**Sessioni tmux:** ogni progetto ha la sua sessione tmux nominata. La web app crea, riattacca e monitora sessioni tmux. Le sessioni sopravvivono alle disconnessioni del browser — l'utente può disconnettersi e riconnettersi ritrovando Claude Code esattamente dove lo aveva lasciato.

**Terminal server:** integra un terminale interattivo full-duplex (PTY) accessibile via WebSocket, che si aggancia alla sessione tmux del progetto selezionato. L'utente deve poter inviare input (testi, comandi, prompt a Claude Code) e ricevere l'output in tempo reale, inclusi colori ANSI, caratteri speciali e il rendering grafico di Claude Code.

### 3. Web app (frontend)

**Requisito estetico principale:** l'interfaccia deve richiamare visivamente il terminale di Claude Code. Usa:
- Sfondo scuro (`#1a1a1a` o simile)
- Font monospace
- Palette colori ispirata all'UI di Claude Code: arancione/ambra per gli accenti, testo bianco/grigio chiaro per il contenuto, bordi sottili arancioni per i pannelli
- Bordi dei pannelli e header stilizzati come quelli di Claude Code (vedi riferimento visivo allegato)

**Schermata 1 — Login:** form minimale con campo password/token, pulsante di accesso. Stessa estetica terminale.

**Schermata 2 — Project selector:**
- Header con logo/nome del sistema
- Lista dei repository GitHub dell'utente (nome repo, descrizione se disponibile, linguaggio principale, ultimo aggiornamento)
- Indicatore visivo se il repo è già clonato localmente sulla VM
- Pulsante / click per aprire il progetto
- Possibilità di fare manualmente un `git pull` su un repo già clonato

**Schermata 3 — Terminale del progetto:**
- Header con nome del progetto corrente e stato della sessione tmux (attiva / nuova)
- Terminale full-screen che renderizza l'output di Claude Code con colori ANSI e grafica ASCII
- Input bar in basso per inviare prompt e comandi
- Pulsanti rapidi per azioni comuni: `/clear`, `Ctrl+C`, scroll to bottom
- Indicatore di connessione WebSocket (connesso / riconnessione in corso)
- Il terminale deve funzionare bene su schermo mobile (touch, tastiera virtuale, scroll)

**Responsività:** l'app è progettata principalmente per smartphone. Deve funzionare sia in portrait che landscape. La tastiera virtuale non deve coprire l'input bar.

### 4. Persistenza configurazione

Crea un file di configurazione (`~/.claude-mobile/config.json` o equivalente) che salva:
- GitHub Personal Access Token
- Password/token di accesso all'app
- Configurazione networking
- Directory dei progetti

Il file di configurazione viene creato durante il setup interattivo e non viene mai sovrascritto automaticamente dagli aggiornamenti.

---

## Requisiti non funzionali

**Affidabilità delle sessioni:** se il WebSocket si disconnette (cambio rete mobile, schermo spento), il terminale deve riconnettersi automaticamente alla sessione tmux esistente senza perdere lo stato di Claude Code.

**Performance su 1 GB RAM:** il sistema deve essere dimensionato per girare stabilmente con RAM limitata. Evita dipendenze pesanti non necessarie. La swap da 2 GB gestisce i picchi.

**Sicurezza minima accettabile:** 
- Autenticazione obbligatoria prima di accedere al terminale
- HTTPS su tutta la comunicazione (niente HTTP in chiaro)
- Nessuna credenziale hardcoded nel codice

**Zero manutenzione:** una volta avviato, il sistema deve essere autosufficiente. La web app si riavvia automaticamente in caso di crash (systemd). I repo vengono aggiornati on-demand, non con cron job silenziosi.

---

## Output atteso

Al termine, il progetto deve contenere:

```
/
├── setup.sh                  # script di bootstrap completo per VM fresca
├── README.md                 # istruzioni per replicare il setup in 15 minuti
├── server/                   # backend Node.js
│   ├── package.json
│   ├── index.js (o equivalente)
│   └── ...
├── client/                   # frontend (HTML/CSS/JS o framework leggero)
│   └── ...
└── config/
    ├── claude-mobile.service # unit file systemd
    └── cloudflared.yml       # config tunnel (se si usa Cloudflare)
```

Il `README.md` deve contenere esattamente i passi da eseguire partendo da una VM e2-micro appena creata su GCP fino ad avere il sistema funzionante e accessibile da smartphone, incluso come fare l'autenticazione OAuth di Claude Code.

---

## Vincoli e note implementative

- **Uso di Docker consigliato.** Con 24 GB di RAM, Docker è lo standard per garantire isolamento e scalabilità dei servizi (CI/CD, Storage, etc.).
- **Claude Code si autentica con abbonamento Pro** (OAuth, non API key). Il token viene salvato automaticamente da Claude Code in `~/.claude/`. Il sistema non deve interferire con questo meccanismo.
- **Non modificare il comportamento di Claude Code.** Il sistema lo avvia normalmente dentro tmux, non lo wrappa o patcha.
- **GitHub API rate limit:** con un Personal Access Token autenticato il limite è 5000 req/ora — più che sufficiente. Non serve caching aggressivo.
- **La VM ha un solo progetto attivo per volta** (single user). Non è necessario gestire multi-utente o isolamento tra sessioni.

---

## Riferimento visivo

L'UI del terminale di Claude Code (allegato) mostra:
- Bordi arancioni per i pannelli principali
- Testo "Claude Code v2.1.76" come header del pannello
- Sezione "Tips for getting started" e "Recent activity" con testo arancione per i titoli
- Avatar pixel-art arancione
- Sfondo quasi-nero
- Font monospace con buon contrasto

Replica questo stile per tutte le schermate del sistema, adattandolo ai contenuti specifici (project selector, terminale attivo, ecc.).
