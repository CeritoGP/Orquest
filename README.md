# Orquest Bridge

Puente local para que Codex orqueste trabajadores de Antigravity CLI (`agy`) y
el usuario observe la actividad en un dashboard web. El daemon es la fuente de
verdad: conserva trabajos, eventos y diffs en SQLite aun si se cierra el
frontend o Codex.

Para retomar el desarrollo desde otro agente, empezar por
[el handoff actual](docs/handoff.md). El [índice documental](docs/README.md)
separa guías actuales e históricas; la
[metodología de validación visual](docs/visual-validation.md) explica cómo
comprobar cambios UI en navegador y conservar capturas como evidencia.

Hoja de ruta y criterios para las próximas entregas:
[guía de continuación](docs/continuation-plan.md).
Asignación por entregas a un modelo económico, con prompts y criterios de revisión:
[plan de delegación](docs/delegation-plan.md).

## Qué está operativo

- MCP por `stdio` con 10 herramientas para crear, inspeccionar, esperar,
  continuar, cancelar, reintentar y leer diffs.
- Daemon local autenticado, enlazado exclusivamente a `127.0.0.1:4317`.
- Dashboard React en `http://127.0.0.1:4318` con Kanban, conexión SSE,
  actividad, subagentes, perfiles efectivos, pruebas, cambios/diff y cancelación.
- Adaptador real para `agy --output-format stream-json`, sin shell y sin
  `--dangerously-skip-permissions`.
- Cola con concurrencia limitada, persistencia SQLite y recuperación: las
  tareas en cola se reanudan; las que estaban ejecutándose al reiniciar quedan
  registradas como fallidas, no se simulan como exitosas.
- Trabajos escritores aislados en Git worktrees. No hay merge, push, despliegue
  ni migración automáticos.
- Dependencias entre trabajos y revisores de solo lectura sobre el worktree del
  implementador. Un fallo de prerrequisito bloquea sus dependientes.

## Arranque local

En PowerShell, desde la raíz del proyecto:

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test

# Solo para ejecutar trabajadores reales de Antigravity.
$env:ORQUEST_RUNNER = 'agy'
$env:ORQUEST_ALLOWED_ROOTS = (Get-Location).Path
npm.cmd run dev:daemon
```

En otra terminal:

```powershell
npm.cmd run dev:dashboard
```

Abre `http://127.0.0.1:4318`. El dashboard lee el token local del daemon y lo
reenvía únicamente al proxy loopback.

Para pruebas sin consumir Antigravity, omite `ORQUEST_RUNNER=agy`: el daemon
usa el ejecutor determinista `fake-agy`.

### Instalación y arranque administrado

Para el uso diario en Windows, haz doble clic en `iniciar-orquest.bat`. Mantiene una consola visible con los logs y la URL del dashboard, y aplica la política operativa base de Antigravity antes de iniciar los servicios.

Para un inicio local de ambos procesos en segundo plano, sin registrar nada en
el sistema, usa:

```powershell
npm.cmd run install:local
npm.cmd run start:local
```

El lanzador conserva solamente sus PIDs y logs en
`%LOCALAPPDATA%\OrquestBridge\`. Detén exclusivamente los procesos que él creó
con `npm.cmd run stop:local`; la base de datos, token, worktrees y logs se
preservan. El script no toca configuración global de Codex.

## Conectar Codex

Copia [`config/codex.example.toml`](config/codex.example.toml) a
`.codex/config.toml` dentro de un workspace de confianza y reinicia Codex.
La guía completa está en [`docs/codex-setup.md`](docs/codex-setup.md). La guía de uso diario está en [`docs/user-guide.md`](docs/user-guide.md).

## Crear trabajos desde Codex

Cada trabajo admite, además de título, tarea y ruta:

- `model`: slug de modelo de `agy`, o `auto`.
- `effort`: `low`, `medium`, `high` o `max`.
- `agent`: agente concreto de `agy` opcional.
- `accessMode`: `read-only` o `worktree`.
- `dependsOnJobIds`: UUIDs de trabajos que deben terminar correctamente.
- `reviewOfJobId`: UUID de un trabajo escritor; obliga modo `read-only` y usa
  su worktree como contexto.

## Perfiles de ejecución

Los perfiles predeterminados son `quick` (lectura y esfuerzo bajo),
`researcher` (lectura y esfuerzo medio), `implementer` (worktree y esfuerzo
alto) y `reviewer` (lectura y esfuerzo alto). Envía `profileId` al crear el
trabajo; una configuración explícita de modelo, esfuerzo, agente o acceso tiene
prioridad cuando no coincide con el valor predeterminado de la solicitud.

Para personalizarlos, copia [`config/profiles.example.yaml`](config/profiles.example.yaml)
fuera de Git y apunta el daemon a esa copia antes de arrancarlo:

```powershell
Copy-Item config/profiles.example.yaml "$env:LOCALAPPDATA\OrquestBridge\profiles.yaml"
$env:ORQUEST_PROFILES_PATH = "$env:LOCALAPPDATA\OrquestBridge\profiles.yaml"
npm.cmd run dev:daemon
```

Reinicia el daemon después de editarlo. `GET /api/profiles` muestra los
perfiles efectivos al dashboard o a un cliente local autenticado. Define
`agent` sólo con un nombre que exista en `agy agents`.

## Comandos de verificación

`verificationCommands` se ejecuta después de la respuesta del worker, en el
workspace efectivo (el worktree para un escritor). No se usa un shell. Por
seguridad sólo se admiten:

```text
npm.cmd test
npm.cmd run test
npm.cmd run lint
npm.cmd run build
git diff --check
```

Si alguno falla, el trabajo queda `FAILED` y el evento final incluye la salida
acotada del comando. Un comando fuera de la allowlist se rechaza al enviar el
trabajo.
Para un escritor, el `workspacePath` debe ser la raíz de un repositorio Git con
al menos un commit. Orquest crea una rama efímera `orquest/<id>` bajo su
worktree privado y deja el checkout original intacto.

## Permisos de Antigravity

Las sesiones headless no pueden responder diálogos de permisos. Añade reglas
estrechas desde una sesión interactiva de `agy`, por proyecto, antes de enviar
una tarea real. Por ejemplo, para una inspección inicial en Windows:

```text
command(dir)
escalate_admin(dir)
```

En versiones que usen el nombre nuevo, la segunda regla equivalente es
`unsandboxed(dir)`. Agrega otras reglas solo para comandos concretos necesarios,
como `command(git)` o `command(regex:npm run (build|lint|test))`.

No uses `command(*)`, `unsandboxed(*)` ni
`--dangerously-skip-permissions`.

## Verificación

La suite cubre contratos, persistencia, autenticación, REST/SSE, MCP, worktrees,
diffs, dependencias, revisores y recuperación del daemon.

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
```
