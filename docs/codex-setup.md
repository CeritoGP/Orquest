# Connect Codex to Orquest Bridge

This guide explains how to register and operate the local Orquest Bridge MCP server in Codex.

---

## 1. Prerequisites

1. Install project dependencies:
   ```powershell
   npm.cmd install
   ```

2. Start the local daemon:
   ```powershell
   npm.cmd run dev:daemon
   ```
   The daemon starts on `http://127.0.0.1:4317` and creates a local token at:
   `%LOCALAPPDATA%\OrquestBridge\daemon.token` (or `$env:ORQUEST_HOME\daemon.token`).

3. Verify daemon health in another terminal:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:4317/health"
   ```
   Should return `@{up=True}` (unauthenticated minimal health check).

---

## 2. Recommended Configuration: `.codex/config.toml`

For a trusted local project, create or update `.codex/config.toml` in your workspace root.

> **Security Rule:** Never commit secrets, tokens, or personal user paths to Git.

```toml
# .codex/config.toml
# Recommended approval mode: read-only tools run automatically; mutating tools require approval.
default_tools_approval_mode = "writes"

[mcp_servers.orquest]
command = "node"
args = ["./node_modules/tsx/dist/cli.mjs", "./packages/mcp-server/src/server.ts"]
env = { ORQUEST_DAEMON_URL = "http://127.0.0.1:4317" }
```

A template is provided at [`config/codex.example.toml`](../config/codex.example.toml).

---

## 3. Alternative Registration: `codex mcp add`

If you prefer registering the MCP server globally or per-session via the Codex CLI:

```powershell
# Replace <WORKSPACE-PATH> with the absolute path to your local repository clone
codex mcp add orquest -- "<WORKSPACE-PATH>\node_modules\.bin\tsx.cmd" "<WORKSPACE-PATH>\packages\mcp-server\src\server.ts"
```

To set the recommended approval policy globally in your user configuration (`~/.codex/config.toml`):
```toml
default_tools_approval_mode = "writes"
```

---

## 4. Authentication Architecture

- **Automatic token discovery:** The MCP server automatically resolves the bearer token from the daemon's local token file (`%LOCALAPPDATA%\OrquestBridge\daemon.token` or `$env:ORQUEST_HOME\daemon.token`). No token entry in configuration files is necessary.
- **Development override:** You can explicitly set `$env:ORQUEST_DAEMON_TOKEN = "<secret>"` before starting both daemon and MCP.
- **Loopback protection:** The MCP server strictly validates the daemon URL and rejects any non-loopback host.
- **Redaction:** Secrets, tokens, and Authorization headers are automatically redacted with `[REDACTED]` from all error messages and responses before returning to Codex.

---

## 5. Verifying MCP Registration in Codex

1. **Restart Codex:** Close and restart Codex to ensure the MCP configuration is loaded.
2. **Inspect tools:** In the Codex chat, type `/mcp` or run in terminal:
   ```powershell
   codex mcp list
   ```
   Verify that `orquest` is listed with all **10 tools**:
   - `orquest_health` (read-only)
   - `orquest_submit_jobs` (mutation)
   - `orquest_list_jobs` (read-only)
   - `orquest_get_job` (read-only)
   - `orquest_wait_job` (read-only)
   - `orquest_get_transcript` (read-only)
   - `orquest_send_message` (mutation)
   - `orquest_cancel_job` (destructive)
   - `orquest_retry_job` (mutation)
   - `orquest_get_diff` (read-only)

3. **Run health check:** In Codex, invoke:
   > "Call orquest_health to verify daemon connectivity."

---

## 6. Safety & Operational Boundaries

- **Approval mode (`default_tools_approval_mode = "writes"`):**
  - Read tools (`health`, `list_jobs`, `get_job`, `wait_job`, `get_transcript`, `get_diff`) execute without prompting.
  - Mutating tools (`submit_jobs`, `send_message`, `retry_job`) and destructive tools (`cancel_job`) request confirmation.
- **No autonomous deployments:** Orquest Bridge never performs Git merge, Git push, production deployments, database migrations, or bypasses Antigravity permissions.
- **Bounded outputs:** Transcripts, job lists, and diffs are paginated with opaque cursors (`cursor`) and bounded limits (`limit`) to avoid context saturation.
---

## 7. Permisos de Antigravity en modo headless

El modo headless no puede responder diálogos de permiso. Para evitar que los
trabajos habituales terminen en `BLOCKED`, inicia Orquest mediante
`iniciar-orquest.bat`. El lanzador aplica una sola vez y de forma idempotente la
política operativa base definida en
[`config/antigravity-permissions.orquest.example.json`](../config/antigravity-permissions.orquest.example.json).

La política conserva la configuración existente de `agy`, activa la ejecución
`proceed-in-sandbox` y permite únicamente inspección de archivos, búsqueda, Git
de consulta y `npm` para build/lint/test. No habilita escritura fuera del
workspace, red, push, merge, despliegues, migraciones, `command(*)`,
`unsandboxed(*)` ni `--dangerously-skip-permissions`.

Si una capacidad nueva queda bloqueada, Orquest debe reportar el permiso exacto
solicitado y añadirlo a la política solo después de revisar su alcance. No se
soluciona cambiando la política a permisos universales.
## 8. Modelos, esfuerzo, agentes y flujo de revisión

Al invocar `orquest_submit_jobs`, Codex puede establecer `model`, `effort` y
`agent` por trabajo. `effort` admite `low`, `medium`, `high` y `max`; `agent`
es opcional y se envía a Antigravity mediante `--agent`.

Para cambios de código, crea primero un trabajo `worktree`. Después envía un
trabajo `read-only` con `reviewOfJobId` igual al ID del implementador. El daemon
hace que el revisor espere al implementador y lo ejecuta dentro de su worktree,
sin permiso de edición. Para dependencias generales usa `dependsOnJobIds`.

Consulta [`mcp-tools.md`](mcp-tools.md) para los ejemplos completos.