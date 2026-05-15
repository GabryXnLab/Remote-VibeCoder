# Piano: Revisione Sistema Gestione File e Sincronizzazione Progetti

## Obiettivo

Revisione completa del sistema di gestione file e sincronizzazione, articolata in 4 aree:
1. Sicurezza del pull con rilevamento conflitti
2. Verifica persistenza dati su GCP
3. Riutilizzo dell'interfaccia di commit guidato esistente
4. Redesign dei blocchi repository nella pagina principale

---

## Analisi dello stato attuale

### Cosa esiste già
- **ProjectsPage.tsx** contiene tutto: lista repo, card con pulsanti (Open/Pull/Clone/Commit), modal di commit completo (selezione file, messaggio, autore, push)
- **Server `POST /api/repos/pull`** → chiama `git.pull()` direttamente senza alcun controllo preventivo
- **Server `GET /api/repos/:name/git-status`** → ritorna branch, ahead/behind, tracking, files con status
- **Nessun endpoint per pre-check pull** (fetch + confronto stato locale vs remoto)
- **Nessun ConflictWarningDialog** — non esiste alcun dialog di avviso conflitti
- **Persistenza file**: i file dei progetti risiedono sul disco persistente della VM GCP e2-micro. Le modifiche fatte nel terminale (tramite tmux/node-pty) vengono scritte direttamente sul disco dal processo in esecuzione (es. editor vim, nano, o Claude Code). Il disco della VM è storage GCP persistente — non c'è un layer separato di Google Cloud Storage. Le modifiche sono già persistite istantaneamente dal filesystem Linux.
- **Nessun polling dello stato sync** — git-status viene caricato una volta al mount della pagina

### Cosa manca
1. Endpoint server per pre-check pull (fetch + status)
2. Endpoint server per force-pull (reset + pull)
3. Componente ConflictWarningDialog
4. Indicatore di sincronizzazione real-time nelle card
5. Pulsante commit diretto nelle card repo
6. Redesign layout card con tutte le info richieste

---

## File che verranno modificati/creati

### Nuovi file
| File | Descrizione |
|------|-------------|
| `client-src/src/components/feedback/ConflictWarningDialog.tsx` | Dialog riutilizzabile per avvisi conflitto |
| `client-src/src/components/feedback/ConflictWarningDialog.module.css` | Stili del dialog |

### File modificati
| File | Modifiche |
|------|-----------|
| `server/routes/repos.js` | Nuovo endpoint `GET /api/repos/:name/sync-status` (fetch + confronto), nuovo endpoint `POST /api/repos/force-pull` (reset hard + pull) |
| `client-src/src/pages/ProjectsPage.tsx` | Logica pre-check pull, integrazione ConflictWarningDialog, polling sync status, pulsante commit in card, redesign card |
| `client-src/src/pages/ProjectsPage.module.css` | Stili aggiornati per card redesignata, indicatore sync, nuovi pulsanti |
| `client-src/src/components/index.ts` | Export del nuovo ConflictWarningDialog |

---

## Step di implementazione

### Step 1 — Nuovi endpoint server

**1a. `GET /api/repos/:name/sync-status`**
- Esegue `git fetch origin` per aggiornare i ref remoti
- Esegue `git status` per rilevare: modifiche locali (staged/unstaged), commit ahead/behind
- Ritorna:
  ```json
  {
    "synced": true|false,
    "localChanges": true|false,
    "ahead": 0,
    "behind": 0,
    "files": [...],
    "branch": "main",
    "tracking": "origin/main"
  }
  ```

**1b. `POST /api/repos/force-pull`**
- Accetta `{ repo: "nome" }`
- Esegue `git reset --hard HEAD` + `git clean -fd` + `git pull`
- Sovrascrive completamente le modifiche locali
- Ritorna il risultato del pull

### Step 2 — Componente ConflictWarningDialog

Creare `client-src/src/components/feedback/ConflictWarningDialog.tsx`:
- **Props:**
  - `open: boolean`
  - `onClose: () => void`
  - `onForceOverwrite: () => void` — callback per "Sovrascrivi comunque"
  - `onCommitFirst: () => void` — callback per "Salva con commit"
  - `context: { repoName, branch, files, ahead, behind }`
- **UI:**
  - Usa il componente `Modal` esistente
  - Header con icona warning e titolo "Modifiche locali rilevate"
  - Lista file modificati con badge status (riuso stile commit modal)
  - Info branch e ahead/behind
  - 3 pulsanti:
    1. **Annulla** (secondary) → `onClose()`
    2. **Sovrascrivi comunque** (danger) → `onForceOverwrite()`
    3. **Salva modifiche** (primary) → `onCommitFirst()`

### Step 3 — Logica pre-check pull in ProjectsPage

Modificare il handler del pulsante Pull:
1. Prima di pullare, chiama `GET /api/repos/:name/sync-status`
2. Se `localChanges === true` o `ahead > 0`:
   - Blocca il pull
   - Apri `ConflictWarningDialog` con i dati del conflitto
3. Se tutto pulito → procedi con pull normale
4. Handler "Sovrascrivi comunque":
   - Chiama `POST /api/repos/force-pull`
   - Chiudi dialog, refresh lista
5. Handler "Salva modifiche":
   - Chiudi dialog conflitto
   - Apri il modal di commit esistente, pre-caricato con i file modificati
   - Dopo il commit+push, ri-esegui il pull automaticamente

### Step 4 — Indicatore di sincronizzazione nelle card

Aggiungere polling dello stato sync:
- Al mount della pagina e ogni 60 secondi, per ogni repo clonata chiama `GET /api/repos/:name/sync-status`
- Mostra un indicatore colorato nella card:
  - 🟢 Verde: "Sincronizzato" (no local changes, ahead=0, behind=0)
  - 🟡 Giallo: "Modifiche locali" (local changes o ahead>0)
  - 🔵 Blu: "Aggiornamenti disponibili" (behind>0)
  - 🟠 Arancione: "Modifiche locali + aggiornamenti remoti" (sia ahead che behind)
- Il polling usa `Promise.allSettled` per non bloccarsi se una repo fallisce
- Rate limiting: le chiamate fetch sono sequenziali con 200ms di pausa tra una repo e l'altra per non sovraccaricare la VM

### Step 5 — Pulsante commit diretto nelle card

Per ogni repo clonata con modifiche:
- Aggiungere un pulsante con icona commit (↑ o simile) nella barra azioni della card
- Il click apre direttamente il modal di commit esistente, pre-caricato con git-status della repo
- Nessuna duplicazione di logica — si riusa esattamente lo stesso `commitModal` già presente

### Step 6 — Redesign layout card repository

Ristrutturare la card repo con questo layout:

```
┌─────────────────────────────────────────────┐
│ 🔒 repo-name                    ● Synced    │
│ Short description of the repo               │
│ Updated: Mar 15, 2026                       │
│                                             │
│ [Open]  [↓ Pull]  [↑ Commit]               │
└─────────────────────────────────────────────┘
```

Per repo non clonate:
```
┌─────────────────────────────────────────────┐
│ 🔓 repo-name                               │
│ Short description of the repo               │
│ Updated: Mar 15, 2026                       │
│                                             │
│ [Clone]                                     │
└─────────────────────────────────────────────┘
```

Dettagli visivi:
- Badge visibilità (🔒 Private / 🔓 Public) inline col nome
- Indicatore sync: pallino colorato + testo breve, allineato a destra nella prima riga
- Descrizione troncata a 1 riga con ellipsis
- Data aggiornamento in formato leggibile
- Pulsanti in riga con icone + testo abbreviato
- Pulsante Commit visibile solo se ci sono modifiche (file count nel badge)
- Colori coerenti col tema scuro: sfondo card `var(--bg-secondary)`, bordi `var(--border)`

---

## AREA 2 — Persistenza (Nessuna modifica necessaria)

I file dei progetti sono sul disco persistente della VM GCP. Quando si modifica un file tramite il terminale (vim, nano, Claude Code, qualsiasi comando), la modifica viene scritta direttamente sul filesystem ext4 della VM da parte del processo in esecuzione nel tmux. Il disco della VM è storage GCP Persistent Disk — è già persistente per design. Non esiste un layer intermedio che potrebbe perdere dati.

L'unico scenario di perdita dati sarebbe un crash della VM durante una scrittura, ma questo è gestito dal journaling del filesystem ext4 e dalla replicazione del Persistent Disk di GCP.

**Conclusione**: non serve implementare un watcher aggiuntivo. Il sistema attuale garantisce già persistenza istantanea.

---

## AREA 3 — Migrazione a Oracle Cloud Infrastructure (OCI)

### Obiettivo
Trasferire l'intero ecosistema da GCP e2-micro a un'istanza OCI ARM Ampere per superare i limiti di risorse (1GB RAM) e creare un'architettura "nexus-core" tuttofare.

### Stato Attuale
- **Infrastruttura Target:** VM VM.Standard.A1.Flex (4 OCPU, 24GB RAM, 200GB Disco).
- **Automazione:** Implementato bot di acquisizione `claim_nexus.sh` su e2-micro che tenta il provisioning ogni 10 minuti tramite OCI CLI/Stack.
- **Backup:** Creato pacchetto di migrazione in `/home/gabry/Desktop/Projects/OCI_Migration_Nexus/`.

### Step di implementazione
1. **Fase 1: Acquisizione** (In corso) — Tentativi automatici di superare l'errore "Out of capacity".
2. **Fase 2: Setup Base** — Installazione Docker, Traefik (Reverse Proxy), Cloudflared.
3. **Fase 3: Migrazione VibeCoder** — Containerizzazione dell'app attuale e deploy su OCI.
4. **Fase 4: Orchestrazione Risorse** — Implementazione del System Governor per gestione priorità container.
5. **Fase 5: Servizi Aggiuntivi** — Setup CI/CD Runner (GitHub), Storage, Web Hosting.

---

## Rischi e dipendenze

| Rischio | Mitigazione |
|---------|-------------|
| `git fetch` lento su connessioni deboli | Timeout di 10s sulla fetch, fallback a stato "sconosciuto" |
| Polling sync-status sovraccarica la VM | Rate limiting: max 1 check/repo ogni 60s, chiamate sequenziali con pausa |
| `git reset --hard` nella force-pull distrugge lavoro | Dialog esplicito con warning rosso e conferma utente obbligatoria |
| Commit modal aperto da card vs da pull-conflict potrebbe avere stato inconsistente | Singola funzione `openCommitModal(repoName)` che carica sempre fresh git-status |
| Troppi endpoint simultanei su e2-micro (1GB RAM) | Le chiamate sync-status sono sequenziali, non parallele |

---

## Ordine di esecuzione

1. **Step 1** — Endpoint server (sync-status + force-pull) ← fondazione
2. **Step 2** — ConflictWarningDialog component ← UI building block
3. **Step 3** — Logica pre-check pull ← integra step 1 + 2
4. **Step 6** — Redesign card layout ← ristruttura UI
5. **Step 4** — Indicatore sync nelle card ← usa nuovo endpoint
6. **Step 5** — Pulsante commit in card ← riusa modal esistente

Step 2-3 e 4-5-6 sono relativamente indipendenti ma li eseguirò in sequenza per semplicità.
