# CURRENT_CONTEXT.md — Remote VibeCoder

> Sessione: 2026-03-17
> Obiettivo: security audit completo + nuova feature "Visual GitHub Commit"

---

## File modificati

| File | Tipo di modifica |
|---|---|
| `server/index.js` | Security fix: permissions directory sessioni |
| `server/routes/sessions.js` | Security fix: whitelist shell |
| `server/pty.js` | Security fix: cap earlyBuffer |
| `server/routes/repos.js` | Security fix: path traversal + 2 nuovi endpoint REST |
| `client/js/projects.js` | Feature: git status loader + commit modal |
| `client/style.css` | Feature: stili modal + badge changes + btn-git |

---

## Security fixes

### 1. Sessions dir world-readable (`server/index.js:67`)
```js
// Prima
fs.mkdirSync(sessionsDir, { recursive: true });
// Dopo
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
```
La directory `~/.claude-mobile/sessions/` conteneva i file di sessione Express
e veniva creata con i permessi di default (0o777). Qualsiasi utente shell
poteva leggere i token di sessione.

### 2. SHELL env var injection (`server/routes/sessions.js:86`)
```js
// Prima
const startCmd = shellMode ? (process.env.SHELL || '/bin/bash') : 'claude';

// Dopo — whitelist esplicita
const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/sh', '/bin/zsh',
  '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish',
]);
const rawShell  = process.env.SHELL || '/bin/bash';
const safeShell = ALLOWED_SHELLS.has(rawShell) ? rawShell : '/bin/bash';
const startCmd  = shellMode ? safeShell : 'claude';
```
Se `SHELL` fosse stata manomessa (processo compromesso o injection via env),
poteva eseguire un binario arbitrario come comando iniziale tmux.

### 3. earlyBuffer OOM (`server/pty.js`)
```js
// Aggiunto cap a 256 KB
const EARLY_BUFFER_LIMIT = 256 * 1024;
if (earlyBufferBytes < EARLY_BUFFER_LIMIT) {
  earlyBuffer.push(data);
  earlyBufferBytes += data.length;
}
```
Il buffer che accumulava output PTY in attesa dello scrollback tmux non aveva
limite. Su e2-micro (1 GB RAM), una reconnessione lenta con output verboso
poteva causare OOM. Il buffer è ora capped a 256 KB.

### 4. Path traversal `startsWith` edge case (`server/routes/repos.js`)
```js
// Prima — falso positivo: /repos/myrepo-evil passa il check di /repos/myrepo
if (!resolved.startsWith(resolvedRoot)) { ... }

// Dopo — separator-aware
if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) { ... }
```
Applicato in: endpoint `/tree`, `git-status`, `commit`, e DELETE.

### 5. DELETE endpoint senza path-traversal guard
Il DELETE `/api/repos/:name` non aveva il `realpathSync` check presente
negli altri endpoint. Aggiunto per defense-in-depth (il regex sul nome
già preveniva il traversal, ma la coerenza è importante).

---

## Nuova feature: Visual GitHub Commit

### Flusso UX
1. La pagina projects carica le repo come prima (non bloccante)
2. Dopo il render iniziale, `loadGitStatuses()` chiama in parallelo
   `GET /api/repos/:name/git-status` per ogni repo clonata senza sessione attiva
3. Se ci sono file modificati → appare:
   - Badge verde `N changes` nella riga meta della card
   - Pulsante verde `↑ N` nella riga azioni
4. Click sul pulsante → apre il commit modal
5. L'utente seleziona file, scrive il messaggio, opzionalmente modifica
   autore ed email, sceglie se fare push
6. Submit → `POST /api/repos/:name/commit` → chiude il modal e ricarica

### Decisioni architettoniche backend

**`GET /api/repos/:name/git-status`**
- Usa `simpleGit.status()` che internamente esegue `git status --porcelain`
- Ritorna: branch corrente, tracking, ahead/behind, lista file (path, from,
  index, working_dir), git user.name e user.email dal config locale
- Usato solo per repo senza sessione attiva → nessun conflitto con Claude Code
  che lavora nella stessa directory

**`POST /api/repos/:name/commit`**
- Staging: `git.add(files)` — solo i file selezionati dall'utente
- Commit: `git.env({ ...process.env, ...authorEnv }).commit(message)`
  - Le override autore usano **variabili d'ambiente** (`GIT_AUTHOR_NAME` ecc.)
    e **non** modificano `.git/config` → nessun side-effect persistente
- Push opzionale: usa `withGitCredentials()` già esistente → token PAT
  mai scritto in `.git/config`, passato solo tramite `GIT_ASKPASS`
- Validazione input: null-bytes, CRLF, lunghezza, path traversal su ogni
  file path ricevuto dal client

### Decisioni architettoniche frontend

**Non bloccare il render iniziale**
`loadGitStatuses()` viene chiamata *dopo* `renderRepos()` senza `await` nel
flusso principale. Il render delle card è istantaneo; i badge appaiono
appena le chiamate API tornano (tipicamente < 500ms per repo piccole).

**Aggiornamento DOM incrementale**
Invece di re-renderizzare le card, `loadGitStatuses()` trova la card via
`data-card-repo` e inietta badge + pulsante nel DOM esistente. Questo evita
di perdere lo stato dei pulsanti già disabilitati durante operazioni in corso.

**Stato git status nel `data-gitStatus`**
Il pulsante commit porta con sé il JSON del git status nel `dataset.gitStatus`.
Quando l'utente clicca, il modal si apre già popolato senza un'ulteriore
chiamata API. Trade-off: se lo stato git cambia tra il caricamento della
pagina e il click, il modal mostra dati leggermente vecchi — ma è accettabile
perché il server ri-valida tutto al momento del commit.

**Modal come bottom sheet su mobile**
Via media query `@media (max-width: 540px)`: il modal usa
`align-items: flex-end` e `border-radius: 16px 16px 0 0` per comportarsi
da bottom sheet nativo su smartphone. Su desktop è un pannello centrato
con max-width 520px.

**`<details>` nativo per "Author info"**
Invece di implementare un accordion custom in JS, la sezione autore usa
l'elemento HTML `<details>/<summary>` nativo. Zero JavaScript, accessibile,
e funziona su tutti i browser moderni.

---

## Architettura esistente (riferimento)

```
Smartphone Browser (HTTPS via Cloudflare Tunnel)
    ↓ WebSocket /ws/pty/:repo
Express + ws  (localhost:3000, bind 127.0.0.1)
    ↓ node-pty spawn
tmux attach-session -t claude-{repo}   ← persiste tra disconnessioni
    ↓
Claude Code CLI  (cwd: ~/repos/{repo})
```

**Sessioni tmux:** `new-session -A` → attach se esiste, crea se no.
Il kill del WebSocket uccide solo il processo node-pty; la sessione tmux
rimane viva. File mai persi per disconnessione.

**Auth:** PBKDF2-SHA512 (100k iterazioni) + sessioni FileStore in
`~/.claude-mobile/sessions/` + cookie httpOnly/sameSite:strict/secure.

**Credenziali GitHub:** PAT in `~/.claude-mobile/config.json` (plain text,
0o600). Passato a git solo tramite GIT_ASKPASS (script temporaneo in /tmp,
0o700, rimosso nel finally). **Mai** scritto in `.git/config`.

---

## Todo / Known issues rimasti

- Nessun locking per connessioni multiple allo stesso repo (accettabile:
  app single-user)
- GitHub PAT salvato in chiaro su disco (mitigato da permessi file 0o600)
- Dopo `loadAll()` i badge git vengono ricaricati — se una repo ha molte
  modifiche la chiamata a `/git-status` può impiegare 1-2s su VM lenta
