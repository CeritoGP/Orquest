# Orquest Bridge â€” Plan de implementaciÃ³n

## Actualización de producto — 2026-10-06

La siguiente evolución está definida en
[`docs/product-evolution-plan.md`](docs/product-evolution-plan.md).
Este plan amplía la UI con chat por tarea, continuidad UI/MCP, metadatos reales
de worker y orquestador, siete tarjetas por columna, Profiles editables y una
integración local evaluable de Codex App Server con login oficial de ChatGPT.

Para estas nuevas fases, el documento enlazado sustituye las restricciones
anteriores de dashboard exclusivamente observador y perfiles solo en YAML.
Codex conserva el rol de orquestador y el daemon sigue siendo fuente de verdad.
Los requisitos de seguridad de AGENTS.md continúan vigentes. Se trata de una
planificación; las nuevas funciones no están implementadas por añadir este plan.

## 1. Objetivo

Construir un sistema local en el que Codex actÃºe como orquestador y Google
Antigravity CLI (`agy`) como fuerza de ejecuciÃ³n multiagente. El usuario darÃ¡
Ã³rdenes en el chat de Codex y observarÃ¡ toda la actividad en un dashboard local
tipo Hermes Agent.

El sistema deberÃ¡:

- Exponer a Codex herramientas MCP para crear, consultar, continuar y cancelar
  trabajos.
- Ejecutar uno o varios procesos headless de `agy` y consumir sus eventos
  NDJSON en tiempo real.
- Conservar trabajos, conversaciones, eventos, artefactos y configuraciÃ³n tras
  reinicios.
- Mostrar un Kanban, jerarquÃ­a de agentes, transcripciones, comandos, diffs,
  pruebas, consumo y bloqueos.
- Aislar cualquier agente escritor en un Git worktree y evitar integraciones
  automÃ¡ticas en la rama del usuario.
- Usar la sesiÃ³n autenticada de Antigravity CLI para aprovechar la suscripciÃ³n
  del usuario, sin recurrir por defecto al SDK o a la API de pago por consumo.

## 2. Decisiones ya cerradas

1. **Codex es el Ãºnico orquestador de nivel superior.** El dashboard observa y
   ofrece controles operativos seguros; no habrÃ¡ un segundo planificador que
   compita con Codex.
2. **El puente usa Antigravity CLI, no automatizaciÃ³n de la UI.** La integraciÃ³n
   se harÃ¡ con `agy --output-format stream-json`.
3. **MCP serÃ¡ la interfaz de Codex.** El servidor MCP local utilizarÃ¡ `stdio`.
4. **El daemon serÃ¡ la fuente de verdad.** Los trabajos no dependerÃ¡n de que el
   dashboard o una sesiÃ³n de Codex permanezcan abiertos.
5. **El dashboard se enlazarÃ¡ solo a loopback.** Por defecto:
   `http://127.0.0.1:4317`.
6. **No se usarÃ¡ `--dangerously-skip-permissions`.** Los permisos se concederÃ¡n
   por perfil y mediante allowlists.
7. **No habrÃ¡ merge automÃ¡tico.** Codex inspeccionarÃ¡ el diff y decidirÃ¡ cÃ³mo
   integrar cada resultado.
8. **El modelo ejecutor del desarrollo serÃ¡ GPT-5.6 Terra.** GPT-5.6 Sol conserva
   la direcciÃ³n arquitectÃ³nica, revisiÃ³n y aceptaciÃ³n de cada fase.

## 3. Alcance del MVP

### Incluido

- Daemon local persistente.
- Servidor MCP local.
- Adaptador headless de Antigravity CLI.
- Cola con lÃ­mite de concurrencia.
- SQLite y recuperaciÃ³n despuÃ©s de reinicios.
- Perfiles de agentes, selecciÃ³n de modelo y esfuerzo.
- Kanban en vivo.
- Detalle de trabajo con transcripciÃ³n, eventos, stderr y resultado.
- CancelaciÃ³n, reanudaciÃ³n mediante mensaje y reintento controlado.
- Worktrees para trabajos escritores.
- Diff y resultados de pruebas.
- Ejecutor falso para pruebas deterministas.
- InstalaciÃ³n y operaciÃ³n en Windows.

### Fuera del MVP

- Acceso remoto por Internet.
- Aplicaciones mÃ³viles.
- ColaboraciÃ³n multiusuario.
- EdiciÃ³n libre del workflow mediante drag-and-drop.
- Merge, push, despliegues o migraciones automÃ¡ticas.
- FacturaciÃ³n propia o combinaciÃ³n de cuotas de proveedores.
- Lectura o reconstrucciÃ³n de razonamiento privado que `agy` no exponga.
- Compatibilidad inicial con ejecutores distintos de Antigravity.

## 4. Arquitectura

```text
Usuario
  â”‚
  â”œâ”€â”€ conversaciÃ³n y Ã³rdenes
  â–¼
Codex / GPT-5.6 Sol
  â”‚ MCP stdio
  â–¼
packages/mcp-server
  â”‚ HTTP local autenticado / IPC
  â–¼
apps/daemon â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º SQLite + event log
  â”‚                               â”‚
  â”‚ cola y procesos               â””â”€â”€â–º Dashboard React (SSE)
  â–¼
packages/agy-adapter
  â”‚ child_process.spawn
  â”œâ”€â”€ agy worker A â”€â”€â–º worktree A
  â”œâ”€â”€ agy worker B â”€â”€â–º worktree B
  â””â”€â”€ agy reviewer â”€â”€â–º solo lectura
```

### Responsabilidades

#### MCP server

- Convertir llamadas de Codex en solicitudes al daemon.
- Exponer respuestas compactas y paginadas.
- Declarar correctamente quÃ© herramientas son de lectura y cuÃ¡les pueden
  producir cambios.
- No mantener estado de trabajos en memoria como fuente primaria.

#### Daemon

- Validar todas las solicitudes.
- Administrar la mÃ¡quina de estados, dependencias, prioridades y concurrencia.
- Crear y terminar procesos.
- Persistir cada evento antes de publicarlo.
- Emitir actualizaciones SSE.
- Recuperar trabajos y marcar procesos huÃ©rfanos despuÃ©s de un reinicio.
- Aplicar polÃ­ticas de rutas, comandos, tiempos y perfiles.

#### Adaptador `agy`

- Descubrir el ejecutable y consultar versiÃ³n, modelos y agentes.
- Construir argumentos sin interpolaciÃ³n de shell.
- Leer stdout NDJSON lÃ­nea por lÃ­nea.
- Separar stderr y clasificar diagnÃ³sticos.
- Normalizar eventos, resultados, usos, herramientas y `subagent_info`.
- Continuar una conversaciÃ³n usando su `conversation_id`.
- Cancelar el Ã¡rbol de procesos de forma portable.

#### Dashboard

- Consumir snapshots REST y actualizaciones SSE.
- Ser principalmente una superficie de observabilidad.
- Permitir solo controles seguros: pausar cola, reanudar cola, cancelar trabajo,
  reintentar y abrir/enviar un mensaje de seguimiento.
- Mostrar configuraciÃ³n efectiva, no Ãºnicamente la solicitada.

## 5. Stack propuesto

- **Runtime:** Node.js 22 o superior. La mÃ¡quina actual tiene Node 26.7.0.
- **Lenguaje:** TypeScript estricto.
- **Monorepo:** npm workspaces. En este Windows se deberÃ¡ invocar `npm.cmd`
  porque la polÃ­tica de PowerShell bloquea `npm.ps1`.
- **Daemon HTTP:** Fastify enlazado explÃ­citamente a `127.0.0.1`.
- **MCP:** SDK oficial de Model Context Protocol para TypeScript.
- **ValidaciÃ³n:** Zod y JSON Schema generado desde contratos compartidos cuando
  sea Ãºtil.
- **Persistencia:** `node:sqlite`, evitando una dependencia nativa externa.
- **Dashboard:** React, Vite y TypeScript.
- **Actualizaciones:** Server-Sent Events. WebSocket solo si posteriormente se
  necesita comunicaciÃ³n bidireccional sostenida.
- **Pruebas:** Vitest para unidad/integraciÃ³n y Playwright para los recorridos
  crÃ­ticos del dashboard.
- **Calidad:** ESLint, Prettier y `tsc --noEmit`.

## 6. Estructura prevista

```text
Orquest/
â”œâ”€â”€ AGENTS.md
â”œâ”€â”€ README.md
â”œâ”€â”€ IMPLEMENTATION_PLAN.md
â”œâ”€â”€ package.json
â”œâ”€â”€ package-lock.json
â”œâ”€â”€ tsconfig.base.json
â”œâ”€â”€ .gitignore
â”œâ”€â”€ apps/
â”‚   â”œâ”€â”€ daemon/
â”‚   â”‚   â”œâ”€â”€ src/
â”‚   â”‚   â”‚   â”œâ”€â”€ api/
â”‚   â”‚   â”‚   â”œâ”€â”€ jobs/
â”‚   â”‚   â”‚   â”œâ”€â”€ queue/
â”‚   â”‚   â”‚   â”œâ”€â”€ security/
â”‚   â”‚   â”‚   â””â”€â”€ server.ts
â”‚   â”‚   â””â”€â”€ test/
â”‚   â””â”€â”€ dashboard/
â”‚       â”œâ”€â”€ src/
â”‚       â”‚   â”œâ”€â”€ components/
â”‚       â”‚   â”œâ”€â”€ features/
â”‚       â”‚   â”œâ”€â”€ pages/
â”‚       â”‚   â””â”€â”€ styles/
â”‚       â””â”€â”€ e2e/
â”œâ”€â”€ packages/
â”‚   â”œâ”€â”€ contracts/
â”‚   â”œâ”€â”€ core/
â”‚   â”œâ”€â”€ persistence/
â”‚   â”œâ”€â”€ agy-adapter/
â”‚   â”œâ”€â”€ fake-agy/
â”‚   â”œâ”€â”€ mcp-server/
â”‚   â””â”€â”€ test-utils/
â”œâ”€â”€ config/
â”‚   â”œâ”€â”€ profiles.example.yaml
â”‚   â””â”€â”€ permissions.example.json
â”œâ”€â”€ scripts/
â”‚   â”œâ”€â”€ dev.mjs
â”‚   â”œâ”€â”€ install-local.mjs
â”‚   â””â”€â”€ doctor.mjs
â””â”€â”€ docs/
    â”œâ”€â”€ architecture.md
    â”œâ”€â”€ security.md
    â”œâ”€â”€ mcp-tools.md
    â””â”€â”€ operations.md
```

## 7. Estado local y rutas

El cÃ³digo permanecerÃ¡ en el repositorio. Los datos operativos no deberÃ¡n
versionarse.

Directorio por defecto:

```text
%LOCALAPPDATA%\OrquestBridge\
â”œâ”€â”€ orquest.db
â”œâ”€â”€ config.yaml
â”œâ”€â”€ daemon.json
â”œâ”€â”€ logs/
â”œâ”€â”€ runs/<job-id>/
â”‚   â”œâ”€â”€ events.ndjson
â”‚   â”œâ”€â”€ stderr.log
â”‚   â”œâ”€â”€ final.json
â”‚   â””â”€â”€ artifacts/
â””â”€â”€ worktrees/<repo-hash>/<job-id>/
```

La variable `ORQUEST_HOME` permitirÃ¡ cambiar la ubicaciÃ³n. Toda ruta recibida
por API o MCP se resolverÃ¡ a una ruta absoluta y se comprobarÃ¡ contra las raÃ­ces
permitidas.

## 8. MÃ¡quina de estados

Estados persistidos:

```text
TRIAGE -> TODO -> READY -> QUEUED -> RUNNING -> VERIFYING -> DONE
                              â”‚          â”‚
                              â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â–º BLOCKED
                              â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º FAILED
                              â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º CANCELED
```

Reglas:

- Solo el daemon puede realizar transiciones.
- Un trabajo con dependencias incompletas no puede pasar a `READY`.
- Los estados terminales son `DONE`, `FAILED` y `CANCELED`.
- `BLOCKED` debe registrar una causa tipada: permiso, informaciÃ³n, dependencia,
  conflicto, cuota o error recuperable.
- El Kanban agruparÃ¡ `QUEUED`, `RUNNING` y `VERIFYING` de forma comprensible,
  aunque el estado interno conserve mayor precisiÃ³n.

## 9. Modelo de datos mÃ­nimo

### `jobs`

- `id`, `parent_job_id`, `title`, `task_prompt`, `status`, `priority`.
- `workspace_path`, `worktree_path`, `branch_name`, `access_mode`.
- `profile_id`, `agent_name`, `requested_model`, `effective_model`, `effort`.
- `conversation_id`, `pid`, `exit_code`.
- `created_at`, `queued_at`, `started_at`, `finished_at`, `updated_at`.
- `summary`, `error_code`, `error_message`.

### `job_dependencies`

- `job_id`, `depends_on_job_id`.

### `events`

- `id`, `job_id`, `sequence`, `timestamp`, `kind`, `source`.
- `payload_json`, `redaction_state`.

### `messages`

- `id`, `job_id`, `role`, `content`, `delivery_status`, `created_at`.

### `artifacts`

- `id`, `job_id`, `type`, `path`, `mime_type`, `metadata_json`.

### `approvals`

- `id`, `job_id`, `action`, `target`, `reason`, `status`, timestamps.

### `profiles`

- ConfiguraciÃ³n versionada en YAML y snapshot efectivo guardado por trabajo.

## 10. Perfiles de ejecuciÃ³n

Ejemplo inicial:

```yaml
version: 1

defaults:
  timeoutMinutes: 20
  maxRetries: 1
  sandbox: true

profiles:
  quick:
    agent: default
    model: auto
    effort: low
    access: read-only

  researcher:
    agent: research
    model: flash
    effort: medium
    access: read-only

  implementer:
    agent: implementer
    model: pro
    effort: high
    access: worktree

  reviewer:
    agent: reviewer
    model: pro
    effort: high
    access: read-only
```

`auto`, `flash` y `pro` serÃ¡n preferencias lÃ³gicas. Durante la ejecuciÃ³n el
adaptador consultarÃ¡ `agy models`, resolverÃ¡ un slug compatible y registrarÃ¡ el
modelo efectivo. TambiÃ©n serÃ¡ posible fijar un slug exacto.

## 11. Contrato MCP inicial

### `orquest_health`

Comprueba daemon, base de datos, versiÃ³n de `agy`, autenticaciÃ³n observable,
modelos, agentes y capacidad disponible.

### `orquest_submit_jobs`

Acepta de uno a varios trabajos con:

- TÃ­tulo y tarea.
- Criterios de aceptaciÃ³n.
- Perfil o configuraciÃ³n explÃ­cita.
- Workspace y modo de acceso.
- Dependencias.
- Comandos de verificaciÃ³n permitidos.
- Clave de idempotencia.

Devuelve inmediatamente IDs, estados y cualquier validaciÃ³n fallida.

### `orquest_list_jobs`

Filtra por estado, workspace, perfil, agente, rango temporal y padre.

### `orquest_get_job`

Devuelve snapshot, configuraciÃ³n efectiva, progreso, Ãºltimo evento, resultado y
referencias a artefactos.

### `orquest_get_transcript`

Devuelve eventos paginados mediante cursor. Nunca vuelca todo el historial por
defecto.

### `orquest_send_message`

ContinÃºa el trabajo usando el `conversation_id`. Si estÃ¡ ejecutÃ¡ndose, el daemon
encola el mensaje para un punto seguro; si estÃ¡ inactivo, inicia una continuaciÃ³n.

### `orquest_cancel_job`

Cancela el proceso y sus descendientes, registra el motivo y preserva logs y diff.

### `orquest_get_diff`

Devuelve resumen, estadÃ­stica y diff paginado del worktree. No aplica el diff.

### `orquest_retry_job`

Crea un intento enlazado al original; no reescribe el registro histÃ³rico.

## 12. API local y streaming

Endpoints mÃ­nimos:

```text
GET    /health
GET    /api/jobs
POST   /api/jobs
GET    /api/jobs/:id
POST   /api/jobs/:id/messages
POST   /api/jobs/:id/cancel
POST   /api/jobs/:id/retry
GET    /api/jobs/:id/events?cursor=
GET    /api/jobs/:id/diff
GET    /api/events/stream
GET    /api/profiles
GET    /api/capabilities
```

Los eventos SSE tendrÃ¡n `id`, `event`, `data` y cursor reanudable. Ante una
desconexiÃ³n, el cliente usarÃ¡ `Last-Event-ID` y luego reconciliarÃ¡ con un snapshot.

## 13. IntegraciÃ³n con `agy`

### EjecuciÃ³n nueva

Equivalente conceptual, siempre usando `spawn` con argumentos separados:

```text
agy -p <prompt>
    --output-format stream-json
    --model <slug>
    --effort <low|medium|high>
    --agent <agent>
    --print-timeout <duraciÃ³n>
    --sandbox
```

### ContinuaciÃ³n

```text
agy -p <mensaje>
    --conversation <conversation-id>
    --output-format stream-json
    ...configuraciÃ³n efectiva...
```

### Reglas del adaptador

- No usar `shell: true`.
- No concatenar un comando mediante strings.
- Limitar el tamaÃ±o mÃ¡ximo de una lÃ­nea NDJSON.
- Guardar la lÃ­nea original antes de normalizarla.
- Tratar un `result` como la Ãºnica terminaciÃ³n lÃ³gica vÃ¡lida.
- Distinguir salida fallida, timeout, cancelaciÃ³n y proceso terminado sin
  resultado.
- Propagar uso acumulado y por paso cuando exista.
- Convertir `subagent_info` en nodos hijos visibles en el Ã¡rbol de agentes.
- No asumir que todos los modelos soportan todos los niveles de esfuerzo.

## 14. Dashboard

### Vista Kanban

Columnas:

- Triage.
- Todo.
- Ready.
- In Progress.
- Blocked.
- Done.

Cada tarjeta mostrarÃ¡:

- TÃ­tulo, rol/agente y estado actual.
- Modelo y esfuerzo efectivos.
- Tiempo transcurrido.
- Uso disponible.
- Progreso o Ãºltima actividad.
- Worktree o indicador de solo lectura.
- Conteo de archivos, pruebas, avisos y subagentes.

### Detalle de trabajo

PestaÃ±as:

1. **Activity:** timeline normalizado.
2. **Conversation:** mensajes y respuestas emitidas.
3. **Tools:** herramientas, comandos y resultados.
4. **Changes:** archivos y diff.
5. **Tests:** comandos y resultados de verificaciÃ³n.
6. **Agents:** jerarquÃ­a de subagentes.
7. **Raw logs:** NDJSON y stderr, con secretos redactados.
8. **Settings:** configuraciÃ³n solicitada y efectiva.

### NavegaciÃ³n lateral

- Overview.
- Kanban.
- Agents.
- Sessions.
- Changes.
- Logs.
- Analytics.
- Approvals.
- Profiles.
- Settings.

El MVP implementarÃ¡ primero Kanban, Agents, Logs, Profiles y Settings. Las demÃ¡s
entradas podrÃ¡n aparecer deshabilitadas hasta su fase correspondiente.

## 15. Seguridad

1. Enlazar HTTP solo a `127.0.0.1`; nunca a `0.0.0.0` por defecto.
2. Usar un secreto local aleatorio entre MCP y daemon, almacenado con permisos
   del usuario. El dashboard serÃ¡ same-origin y recibirÃ¡ una sesiÃ³n efÃ­mera.
3. Canonicalizar y validar rutas despuÃ©s de resolver enlaces.
4. No permitir raÃ­ces amplias como la unidad completa o el perfil de usuario.
5. Ejecutar agentes escritores Ãºnicamente en worktrees dedicados.
6. Rechazar workspaces que no sean repositorios Git para modo `worktree`.
7. Mantener allowlists de comandos por perfil.
8. Redactar tokens, cookies, claves y valores de variables sensibles antes de
   guardar o transmitir eventos.
9. No pasar secretos dentro del prompt ni en argumentos visibles del proceso.
10. Exigir aprobaciÃ³n para migraciones, despliegues, pushes, borrados amplios y
    acceso fuera de las raÃ­ces configuradas.
11. Limitar concurrencia global, por repositorio y por perfil.
12. Establecer profundidad mÃ¡xima interna de subagentes configurable; MVP: 1.

## 16. Estrategia de pruebas

### Unidad

- MÃ¡quina de estados y dependencias.
- ResoluciÃ³n de perfiles, modelo y esfuerzo.
- Parser NDJSON incremental, lÃ­neas parciales y eventos desconocidos.
- RedacciÃ³n de secretos.
- ValidaciÃ³n/canonicalizaciÃ³n de rutas.
- ConstrucciÃ³n de argumentos de `agy`.
- Control de concurrencia y prioridad.

### IntegraciÃ³n

- Fake `agy` emitiendo eventos lentos, errores, stderr, subagentes y resultados.
- Persistencia y recuperaciÃ³n del daemon.
- CancelaciÃ³n del Ã¡rbol de procesos.
- ReconexiÃ³n SSE con cursor.
- MCP â†’ daemon â†’ fake runner â†’ resultado MCP.
- CreaciÃ³n y limpieza segura de worktrees en un repositorio temporal.

### End-to-end

- Crear dos trabajos desde un cliente MCP de prueba.
- Ver las tarjetas aparecer y actualizarse en el dashboard.
- Abrir una transcripciÃ³n mientras el trabajo sigue activo.
- Cancelar un trabajo y conservar su historial.
- Completar un trabajo escritor y revisar su diff.
- Reiniciar el daemon y comprobar que el estado se mantiene.

### Prueba real controlada

- Ejecutar `agy` sobre un repositorio descartable.
- Empezar con una tarea de solo lectura.
- Continuar la conversaciÃ³n.
- Ejecutar despuÃ©s una tarea escritora aislada.
- No habilitar concurrencia real hasta que cancelaciÃ³n y worktrees estÃ©n
  verificados.

## 17. Fases de implementaciÃ³n

### Fase 0 â€” Bootstrap y contratos

Entregables:

- Inicializar Git y npm workspaces.
- AÃ±adir configuraciÃ³n TypeScript, lint, formato y pruebas.
- Crear `AGENTS.md` con lÃ­mites, comandos y criterios de verificaciÃ³n.
- Definir contratos Zod, enums, IDs y mÃ¡quina de estados.
- Crear documentaciÃ³n de arquitectura y threat model inicial.

Criterios de aceptaciÃ³n:

- `npm.cmd install`, `npm.cmd run typecheck`, `npm.cmd test` y
  `npm.cmd run lint` funcionan.
- No hay dependencia de `agy` para ejecutar la suite base.

### Fase 1 â€” Vertical slice con Fake AGY

Entregables:

- Daemon, SQLite y migraciones.
- Repositorios de jobs y events.
- Cola con concurrencia configurable.
- Fake runner determinista.
- REST y SSE mÃ­nimos.
- Dashboard Kanban con actualizaciones en vivo.

Criterios de aceptaciÃ³n:

- Se crean trabajos desde REST.
- Las tarjetas recorren `READY â†’ RUNNING â†’ DONE` sin refrescar.
- Reiniciar el daemon conserva trabajos y eventos.
- Un evento duplicado no duplica estado.

### Fase 2 â€” Adaptador real de Antigravity

Prerrequisito externo:

- Instalar `agy` y autenticar una sesiÃ³n interactiva.

Entregables:

- Doctor de instalaciÃ³n y capacidades.
- Descubrimiento de modelos y agentes.
- Proceso headless, parser NDJSON y stderr.
- Timeout, cancelaciÃ³n y clasificaciÃ³n de errores.
- ContinuaciÃ³n mediante `conversation_id`.
- Perfil de solo lectura real.

Criterios de aceptaciÃ³n:

- Una tarea real aparece en vivo y termina con resultado persistido.
- Modelo, esfuerzo y conversaciÃ³n efectivos quedan registrados.
- La cancelaciÃ³n termina el proceso y no deja descendientes.
- La falta de autenticaciÃ³n se presenta como bloqueo accionable.

### Fase 3 â€” Servidor MCP para Codex

Plan operativo detallado: [`docs/phase-3-mcp-plan.md`](docs/phase-3-mcp-plan.md).

La ejecuciÃ³n se divide en contratos, autenticaciÃ³n local, API, servidor MCP, registro en Codex y gate E2E. El transporte serÃ¡ STDIO, las respuestas compactas/paginadas y la polÃ­tica recomendada de aprobaciÃ³n serÃ¡ `writes`.

Entregables:

- Herramientas MCP iniciales.
- Cliente local autenticado hacia el daemon.
- PaginaciÃ³n de transcript y diff.
- ConfiguraciÃ³n de proyecto para registrar el MCP.
- GuÃ­a de reinicio y diagnÃ³stico de Codex.

Criterios de aceptaciÃ³n:

- Codex puede crear, listar, inspeccionar, continuar y cancelar un trabajo.
- Los resultados grandes no saturan el contexto; usan cursores.
- Las herramientas de lectura no solicitan aprobaciÃ³n innecesaria.
- Las operaciones mutantes estÃ¡n correctamente marcadas.

### Fase 4 â€” Worktrees y ejecuciÃ³n concurrente

Entregables:

- Gestor de worktrees y ramas efÃ­meras.
- Locks por repositorio y conjunto de archivos cuando sea conocido.
- Dependencias entre trabajos.
- Perfiles implementer/reviewer.
- ExtracciÃ³n de diff, archivos y resultados de pruebas.

Criterios de aceptaciÃ³n:

- Dos escritores pueden trabajar sin modificar el working tree principal.
- Nunca se crea un worktree sobre una ruta no validada.
- Un revisor puede inspeccionar el resultado de un implementador.
- NingÃºn trabajo realiza merge, push o borrado automÃ¡tico.

### Fase 5 â€” Dashboard operativo tipo Hermes

Entregables:

- DiseÃ±o visual oscuro inspirado en la referencia, sin copiar identidad ni
  recursos de terceros.
- Filtros por repo, perfil, agente, estado y modelo.
- Ãrbol Codex â†’ worker â†’ subagentes.
- Detalle con Activity, Conversation, Tools, Changes y Raw Logs.
- Controles de cancelar, reintentar y enviar seguimiento.
- Indicadores de desconexiÃ³n y datos desactualizados.

Criterios de aceptaciÃ³n:

- La UI refleja eventos en menos de un segundo en entorno local.
- NavegaciÃ³n completa por teclado y estados de foco visibles.
- Los errores no dependen Ãºnicamente del color.
- Logs extensos se virtualizan o paginan.

### Fase 6 â€” Robustez, seguridad y observabilidad

Entregables:

- RecuperaciÃ³n de trabajos huÃ©rfanos.
- RedacciÃ³n de secretos y lÃ­mites de payload.
- AuditorÃ­a de comandos, aprobaciones y transiciones.
- MÃ©tricas de duraciÃ³n, errores, uso y concurrencia.
- Backoff con jitter para errores transitorios; sin reintentar errores de
  permisos o configuraciÃ³n.
- ExportaciÃ³n diagnÃ³stica sin secretos.

Criterios de aceptaciÃ³n:

- Pasan las pruebas de amenazas documentadas.
- Un crash no convierte silenciosamente un trabajo activo en completado.
- Los reintentos son visibles y mantienen vÃ­nculo con el intento original.
- El daemon rechaza conexiones no locales.

### Fase 7 â€” Empaquetado e instalaciÃ³n local

Entregables:

- `doctor`, `install-local`, `start`, `stop` y `uninstall` no destructivo.
- Política inicial de permisos de Antigravity: instalación idempotente de una
  allowlist operativa mínima, conservando configuración existente y sin
  permisos universales ni flags de omisión.
- Registro MCP reproducible para Codex.
- Inicio del daemon bajo demanda.
- ConfiguraciÃ³n global opcional sin acoplarla al repo de desarrollo.
- README de operaciÃ³n y troubleshooting.

Criterios de aceptaciÃ³n:

- InstalaciÃ³n limpia en Windows desde un checkout nuevo.
- Una desinstalaciÃ³n preserva datos salvo opciÃ³n explÃ­cita de purga.
- El diagnÃ³stico explica `agy` ausente, autenticaciÃ³n pendiente, puerto ocupado,
  permisos y configuraciÃ³n de Codex.

## 18. Gates de entrega

No se avanza de fase si falla alguno de estos gates:

1. Typecheck, lint y pruebas correspondientes.
2. RevisiÃ³n de seguridad para cualquier nueva capacidad mutante.
3. ValidaciÃ³n manual del recorrido principal de la fase.
4. DocumentaciÃ³n actualizada de contratos o configuraciÃ³n.
5. Ausencia de secretos, rutas locales personales y archivos operativos en Git.
6. Diff enfocado; sin refactors laterales no requeridos.

## 19. Definition of Done del MVP

El MVP estarÃ¡ terminado cuando, desde una conversaciÃ³n de Codex, sea posible:

1. Crear al menos dos tareas independientes.
2. Verlas aparecer y progresar en el dashboard.
3. Ejecutarlas concurrentemente mediante Antigravity CLI.
4. Consultar en Codex su estado y transcripciÃ³n paginada.
5. Ver modelo, esfuerzo, actividad, comandos, uso y subagentes.
6. Cancelar una ejecuciÃ³n activa.
7. Continuar una conversaciÃ³n terminada.
8. Obtener el diff de un implementador aislado.
9. Pedir una revisiÃ³n separada de ese diff.
10. Reiniciar dashboard y daemon sin perder el historial.
11. Demostrar que la rama de trabajo del usuario no fue modificada ni fusionada
    automÃ¡ticamente.

## 20. Riesgos principales y mitigaciones

| Riesgo | MitigaciÃ³n |
|---|---|
| Cambios en el protocolo headless de `agy` | Adaptador aislado, eventos desconocidos tolerados y fixtures versionados |
| Auth expirada | Estado `BLOCKED_AUTH` y doctor con acciÃ³n clara |
| Cuota agotada | Estado `BLOCKED_QUOTA`, no reintentar en bucle |
| Procesos huÃ©rfanos | Registro de PID/start time y kill-tree verificado |
| Conflictos entre agentes | Worktrees, dependencias y lÃ­mites por repositorio |
| Contexto excesivo para Codex | ResÃºmenes, cursores y artefactos por referencia |
| Prompt injection desde el repo | Perfiles mÃ­nimos, sandbox y comandos permitidos |
| Fuga de secretos en logs | RedacciÃ³n antes de persistir y exportar |
| UI mostrando estado obsoleto | SSE reanudable mÃ¡s reconciliaciÃ³n periÃ³dica |
| Modelo solicitado no disponible | ResoluciÃ³n por capacidades y registro del modelo efectivo |

## 21. Estrategia de ejecuciÃ³n con GPT-5.6 Terra

Terra implementarÃ¡ una fase por turno de trabajo. No recibirÃ¡ â€œconstruye todo el
sistemaâ€ como una Ãºnica instrucciÃ³n.

Plantilla de asignaciÃ³n:

```text
Implementa la Fase <N> de IMPLEMENTATION_PLAN.md.

Alcance permitido:
- <directorios y archivos>

Fuera de alcance:
- <lÃ­mites explÃ­citos>

Criterios de aceptaciÃ³n:
- <criterios de la fase>

Antes de editar:
1. Lee AGENTS.md e IMPLEMENTATION_PLAN.md completos.
2. Inspecciona el estado actual y las pruebas existentes.
3. Reporta cualquier contradicciÃ³n bloqueante.

Al terminar:
1. Ejecuta typecheck, lint y pruebas aplicables.
2. Resume decisiones, archivos modificados y riesgos pendientes.
3. No avances a la fase siguiente.
```

Normas de coordinaciÃ³n:

- La Fase 0 tendrÃ¡ un solo agente escritor Terra.
- La Fase 1 tambiÃ©n se ejecutarÃ¡ secuencialmente para estabilizar contratos.
- Desde la Fase 2 se podrÃ¡n usar agentes Terra paralelos Ãºnicamente en paquetes
  distintos y con ownership explÃ­cito.
- Sol revisarÃ¡ contratos pÃºblicos, seguridad, resultados de pruebas y criterios
  de aceptaciÃ³n antes de autorizar la fase siguiente.
- Ante un cambio arquitectÃ³nico, se modifica primero este plan y despuÃ©s el
  cÃ³digo.

## 22. Orden inmediato de trabajo

1. Aprobar este plan.
2. Ejecutar Fase 0 con GPT-5.6 Terra.
3. Revisar el bootstrap con GPT-5.6 Sol.
4. Ejecutar Fase 1 con fake runner.
5. Instalar y autenticar `agy` solo cuando el vertical slice sea estable.
6. Continuar con Fases 2â€“7 respetando los gates.

## 23. Estado actual del entorno

- Workspace vacÃ­o al iniciar este plan.
- No existe todavÃ­a un repositorio Git.
- Node.js disponible: `v26.7.0`.
- Git disponible: `2.55.0.windows.4`.
- Codex CLI disponible: `0.146.0-alpha.3`.
- Antigravity IDE disponible mediante `antigravity-ide.cmd`.
- Antigravity CLI `agy`: no instalado o no presente en `PATH`.
- `npm.ps1` estÃ¡ bloqueado por la polÃ­tica de ejecuciÃ³n de PowerShell; usar
  `npm.cmd` evita modificar esa polÃ­tica global.

## 24. Referencias de integraciÃ³n

- Codex MCP: <https://learn.chatgpt.com/docs/extend/mcp.md>
- Antigravity CLI headless: <https://antigravity.google/docs/cli/headless/>
- Antigravity custom subagents: <https://antigravity.google/docs/subagents/>
- Antigravity CLI installation: <https://www.antigravity.google/docs/cli/install/>


