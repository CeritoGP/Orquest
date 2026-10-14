# Operación local

## Puertos y datos

- Daemon: `http://127.0.0.1:4317`.
- Dashboard: `http://127.0.0.1:4318`.
- Estado por defecto: `%LOCALAPPDATA%\OrquestBridge\`.
- Token del daemon: `%LOCALAPPDATA%\OrquestBridge\daemon.token`.
- Cambia el directorio de estado con `ORQUEST_HOME`.

No expongas estos puertos a la red. El token no debe ponerse en Git ni en prompts.

## Inicio administrado

Después de `npm.cmd install`, `npm.cmd run install:local` crea
`.codex/config.toml` únicamente si aún no existe. Después:

```powershell
npm.cmd run start:local
# ... cuando termines
npm.cmd run stop:local
```

El iniciador sólo escucha en loopback: si el daemon o dashboard ya existe, deja
ese proceso ajeno intacto e inicia sólo el componente que falte. Guarda los
PIDs que creó; la parada verifica el comando antes de enviar la señal y no
purga el estado persistente.

## Arrancar en modo real

```powershell
$env:ORQUEST_RUNNER = 'agy'
$env:ORQUEST_ALLOWED_ROOTS = 'C:\ruta\permitida;C:\otra\ruta'
$env:ORQUEST_MAX_CONCURRENCY = '2'
npm.cmd run dev:daemon
```

`ORQUEST_ALLOWED_ROOTS` es obligatorio al usar `agy`. Una ruta fuera de esa
lista se rechaza antes de iniciar la CLI.

## Perfiles de ejecución

Sin configuración adicional hay cuatro perfiles: `quick`, `researcher`,
`implementer` y `reviewer`. Para adaptar modelo, esfuerzo, agente o modo de
acceso, parte de `config/profiles.example.yaml` y mantén la copia fuera del
repositorio:

```powershell
Copy-Item config/profiles.example.yaml "$env:LOCALAPPDATA\OrquestBridge\profiles.yaml"
$env:ORQUEST_PROFILES_PATH = "$env:LOCALAPPDATA\OrquestBridge\profiles.yaml"
```

El daemon lee el archivo al iniciar; reinícialo después de cambiarlo. La API
autenticada `GET /api/profiles` devuelve la configuración efectiva, sin
credenciales. Un perfil `worktree` requiere una raíz Git con al menos un commit;
los revisores siguen siendo siempre de solo lectura. No declares `agent` hasta
confirmar su nombre con `agy agents`.

## Comprobaciones

```powershell
npm.cmd run doctor
Invoke-RestMethod http://127.0.0.1:4317/health
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
```

Con token, `/health` informa `status: "ok"` y `runner: "agy"` o `fake-agy`.
El dashboard añade el token automáticamente sólo a su proxy loopback.

## Recuperación

Al reiniciar el daemon:

- un trabajo `QUEUED` vuelve a entrar en la cola;
- un trabajo `READY` reevalúa sus dependencias;
- un trabajo que estaba `RUNNING`, `VERIFYING` o `CANCELING` queda como
  `FAILED` con un evento de recuperación, porque el proceso anterior ya no es
  fiable.

Los worktrees se conservan para poder inspeccionar el diff. Orquest no los
fusiona ni los borra automáticamente.

## Permisos de Antigravity

En el primer arranque mediante `iniciar-orquest.bat`, Orquest instala de forma
idempotente su **política operativa base** en la configuración local de `agy`.
Conserva los ajustes existentes y añade solo reglas explícitas de lectura,
búsqueda, Git de consulta y `npm` para `build`, `lint` y `test`. La plantilla
auditable está en
[`config/antigravity-permissions.orquest.example.json`](../config/antigravity-permissions.orquest.example.json).

La política permite a investigadores y revisores trabajar sin solicitar una
aprobación por cada comando seguro. No concede `command(*)`,
`unsandboxed(*)`, red, borrados amplios, merge, push, despliegues ni migraciones.
Esas acciones requieren una autorización separada y no se habilitan por el
bridge.

Puedes comprobar la política sin modificar nada con:

```powershell
node scripts/provision-agy-permissions.mjs
```

El lanzador usa `--apply` para añadir únicamente las reglas faltantes. Si un
trabajo legítimo queda bloqueado por un comando no incluido, se amplía primero
la plantilla con una regla estrecha y se revisa antes de aplicarla; nunca se
soluciona con flags de omisión.
## Verificaciones automatizadas

Los comandos de verificación se ejecutan sin shell desde el workspace efectivo.
La allowlist actual es deliberadamente mínima: `npm.cmd test`, `npm.cmd run
test`, `npm.cmd run lint`, `npm.cmd run build` y `git diff --check`. Para añadir
nuevos comandos hace falta ampliar la política en código y cubrirla con pruebas;
no se deben habilitar comodines.
