# client-src/ — React/Vite frontend

## Build pipeline

```
client-src/src/  →  pnpm run build  →  ../dist/
```

The server serves `../dist/` in production. The `dist/` directory is gitignored — builds happen on the VM during deploy (`deploy.yml` workflow).

**NEVER modify `../client/` (legacy vanilla JS) — it is archived.** All changes go in `client-src/`.

## Dev workflow

```bash
cd client-src && pnpm install && pnpm run build
```

No dev server is wired to the backend — test against the production build served by the Node.js server on port 3000.

## Path aliases

`@/` maps to `client-src/src/`. Configured in `vite.config.ts` and `tsconfig.json`.

## Key architecture decisions

- **React 18 + TypeScript + Vite** — no SSR, pure SPA
- **CSS Modules** per component (`.module.css`) — never use global class names
- **No state management library** — React hooks only; no Redux/Zustand
- **xterm.js** for terminal rendering — see `src/terminal/CLAUDE.md` for critical mobile gotchas
