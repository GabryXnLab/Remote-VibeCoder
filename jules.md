# Deployment Fix Report: pnpm EACCES Error

## Problem
The "Deploy to VM" GitHub Actions workflow was failing during the SSH deployment phase. Specifically, the script failed when attempting to install `pnpm` globally using `npm install -g pnpm`.

**Error Log Snippet:**
```
npm error code EACCES
npm error syscall mkdir
npm error path /usr/lib/node_modules/pnpm
npm error errno -13
npm error Error: EACCES: permission denied, mkdir '/usr/lib/node_modules/pnpm'
```

## Root Cause: PATH Precedence
The root cause was a misconfiguration of the `PATH` environment variable in the SSH deployment script within `.github/workflows/deploy.yml`.

The script was originally appending the `nvm` node binary path to the end of the system `PATH`:
```bash
export PATH="$PATH:$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo 'default')/bin"
```

Because system directories like `/usr/bin` come first in the default `PATH`, the script was inadvertently executing the system-level `npm` (located at `/usr/bin/npm`) instead of the user-level `npm` managed by `nvm`. The system-level `npm` attempts to install global packages into `/usr/lib/node_modules/`, which requires root privileges, leading to the `EACCES` permission denied error.

## Solution
I modified the SSH deployment script to **prepend** the `nvm` node binary path to the `PATH` variable:

```bash
export PATH="$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo 'default')/bin:$PATH"
```

## Verification
- By prepending the path, the shell finds the `npm` binary inside the user's `.nvm` directory before searching system paths.
- The `nvm`-managed `npm` is configured to install global packages within the user's home directory, which does not require `sudo`.
- This change ensures that `command -v pnpm` and `npm install -g pnpm` correctly target the user-space Node environment.
