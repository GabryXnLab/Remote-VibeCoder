# CURRENT_CONTEXT.md — Remote VibeCoder

> Sessione: 2026-03-20
> Branch: `master`
> Multi-terminal work: branch `feature/multi-terminal` (Tasks 1-4 completati, Task 5+ pending)

---

## Stato attuale (master)

### Fix completati in questa sessione

| SHA | Descrizione |
|-----|-------------|
| `29d1762` | fix: mobile scroll + remove legacy vanilla client |
| `57ed7a3` | fix: force manual touch scroll with stopImmediatePropagation |
| `60fbc1f` | fix: remove conflicting CSS touch-action |
| `a951281` | fix: use overlay div for mobile touch scroll |
| `fde774e` | fix: send SGR mouse wheel sequences to tmux instead of term.scrollLines |
| (pending) | fix: invert scroll direction for natural mobile feel + docs update |

### Problema risolto: Mobile touch scroll

xterm.js non supporta il touch scroll su mobile (issue aperte dal 2016). tmux usa l'alternate screen buffer che svuota il scrollback di xterm.js, rendendo `term.scrollLines()` un no-op. Soluzione: overlay div trasparente che invia escape sequences SGR mouse wheel (`\x1b[<64;1;1M` / `\x1b[<65;1;1M`) direttamente a tmux via WebSocket. Dettagli completi in `CLAUDE.md` sezione "xterm.js + tmux: Mobile Touch Interaction".

### Cambiamenti strutturali

- `client/` (vanilla JS) rimosso da master, archiviato in branch `archive/legacy-vanilla-client`
- Tutte le modifiche frontend vanno SOLO in `client-src/`

---

## Multi-terminal (branch feature/multi-terminal)

Piano: `docs/superpowers/plans/2026-03-18-multi-terminal.md`

| Task | File/Componente | Stato |
|------|-----------------|-------|
| Task 1 | `server/routes/sessions.js` | done |
| Task 2 | `server/pty.js` | done |
| Task 3–6 | types + animations + hooks | done |
| Task 7 | `FileBrowser` component | done |
| **Task 8** | **`RepoSelector` component** | **prossimo** |
| Task 9 | `TerminalOpenMenu` component | pending |
| Task 10 | `TerminalSidebar` component | pending |
| Task 11 | `TerminalWindow` component | pending |
| Task 12 | `WindowManager` component | pending |
| Task 13 | `components/index.ts` exports | pending |
| Task 14 | `TerminalPage.tsx` refactor | pending |
| Task 15 | `ProjectsPage.tsx` aggiornamento | pending |
| Task 16 | Build + typecheck + verifica browser | pending |

---

## Note

- VM `remote-vibecoder` (GCP `us-east1-b`, IP `34.138.166.193`)
- Deploy automatico via GitHub Actions su push a master
- Testing manuale via browser + systemd logs (no test suite)
