# Fix for EACCES Permission Denied during `pnpm` Installation in "Deploy to VM" Workflow

## Problem
The "Deploy to VM" workflow was failing consistently during the SSH deployment phase with an `EACCES` (permission denied) error when attempting to install `pnpm`. Specifically, the error output indicated:
`npm error path /usr/lib/node_modules/pnpm`

This showed that the installation was incorrectly targeting the system-wide global `node_modules` directory (`/usr/lib/node_modules`), which requires root (`sudo`) privileges, instead of the user-specific directory managed by `nvm`.

## Root Cause
The root cause was a misconfiguration of the `$PATH` environment variable inside the deployment script within `.github/workflows/deploy.yml`.

The script was previously setting the path by appending the `nvm` path to the existing system path:
```bash
export PATH="$PATH:$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo 'default')/bin"
```

Because the `nvm` path was appended at the very end of `$PATH`, system directories like `/usr/bin` (where the system-level `npm` binary resides) took precedence over the `nvm` user-level directories. As a result, when the script executed `npm install -g pnpm`, it invoked the system-level `npm` instead of the `nvm`-managed `npm`. Since system-level `npm` defaults to installing global packages in `/usr/lib/node_modules`, the command failed with a permission denied error.

## Solution Implemented
To fix the issue, the `$PATH` definition in the SSH script was modified to prepend the `nvm` directory to the front of the `$PATH`, giving it precedence over system directories.

The configuration was changed to:
```bash
export PATH="$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo 'default')/bin:$PATH"
```

## Why It Resolves the EACCES Error
By prepending the `nvm` path to `$PATH`, the script now correctly prioritizes the `nvm`-managed binaries. When the command `npm install -g pnpm` runs, the shell resolves `npm` to the `nvm` version, which is configured to install global packages into the user's `nvm` directory (e.g., `~/.nvm/versions/node/v.../lib/node_modules/pnpm`). Because this directory is owned by the user running the workflow, the installation succeeds without encountering any permission (`EACCES`) errors.
