# Fase 3 — MCP local para que Codex orqueste Antigravity

## 1. Resultado esperado

Referencia histórica del diseño MCP. No describe por sí sola el estado actual:
consultar [handoff.md](handoff.md) y [continuation-progress.md](continuation-progress.md).

Al cerrar esta fase, el usuario seguirá dando instrucciones en el chat de Codex y Codex podrá, mediante herramientas MCP locales, comprobar el sistema, crear varios trabajos independientes, esperarlos, inspeccionarlos, leer transcripciones paginadas, continuar conversaciones, reintentar y cancelar. El daemon seguirá siendo la fuente de verdad y el dashboard una superficie de observabilidad.

## 2. Estado de partida

Fase 2 ya proporciona daemon loopback, SQLite, Fake AGY, runner real `agy` read-only, `conversationId`, estado `CANCELING`, errores tipados y eventos persistidos antes de publicarse. Existe un MCP preliminar con health, list, submit, get, transcript y cancel, pero aún no es una interfaz estable: carece de autenticación local, respuestas compactas, continuación, reintento, espera y pruebas completas de protocolo.

## 3. Decisiones cerradas

### Transporte

- Codex iniciará `packages/mcp-server` como servidor MCP STDIO.
- El MCP será cliente HTTP del daemon en `http://127.0.0.1:4317`.
- stdout queda reservado al protocolo MCP; diagnósticos irán a stderr.
- Se configurará mediante `.codex/config.toml` en un proyecto confiable o `codex mcp add`.
- Tras registrarlo se reiniciará Codex y se verificará con `/mcp` o `codex mcp list`.

### Autenticación local

- Loopback no sustituye autenticación: MCP y daemon compartirán un token local.
- En desarrollo podrá inyectarse `ORQUEST_DAEMON_TOKEN`.
- Por defecto el daemon generará un secreto aleatorio bajo `ORQUEST_HOME`; la configuración guardará la ruta del archivo, nunca el secreto.
- Las llamadas usarán `Authorization: Bearer`; la comparación será constante y el token nunca aparecerá en logs o errores.
- El cliente MCP rechazará URLs que no sean loopback.

### Aprobaciones

- Consultas: `readOnlyHint: true`, no destructivas e idempotentes.
- Crear, continuar y reintentar: mutaciones no destructivas.
- Cancelar: mutación destructiva e idempotente.
- Configuración recomendada: `default_tools_approval_mode = "writes"`.
- Ninguna herramienta hará merge, push, deploy, migraciones ni omitirá permisos.

### Contexto compacto

- Listas, eventos y diffs serán paginados con cursores opacos.
- Nunca se devolverán historiales completos por defecto.
- Los handlers validarán entrada y respuesta con Zod.
- El contenido textual para Codex será breve; `structuredContent` conservará datos útiles cuando corresponda.

## 4. Herramientas MCP

| Herramienta | Tipo | Propósito |
|---|---|---|
| `orquest_health` | lectura | readiness de daemon, DB, runner, auth y capacidad |
| `orquest_submit_jobs` | mutación | crear de 1 a 8 trabajos independientes |
| `orquest_list_jobs` | lectura | filtrar tarjetas resumidas con cursor |
| `orquest_get_job` | lectura | snapshot, último evento y resultado resumido |
| `orquest_wait_job` | lectura larga | esperar cambio/terminal hasta 60 segundos |
| `orquest_get_transcript` | lectura | eventos normalizados paginados |
| `orquest_send_message` | mutación | continuar mediante un trabajo hijo |
| `orquest_cancel_job` | destructiva | solicitar `CANCELING` y devolver snapshot |
| `orquest_retry_job` | mutación | crear un intento enlazado nuevo |
| `orquest_get_diff` | lectura | contrato paginado; `available:false` hasta Fase 4 |

`orquest_submit_job` se sustituirá por `orquest_submit_jobs`; todavía no existe una interfaz registrada que requiera mantener un alias.

## 5. Semántica

### Envío múltiple

- Entre 1 y 8 trabajos por llamada, cada uno con `idempotencyKey`.
- Solo trabajos independientes `read-only`; dependencias y escritores quedan para Fase 4.
- La respuesta separará `accepted` y `rejected` para permitir éxito parcial.

### Continuación

- Solo trabajos terminales con `conversationId` podrán continuarse.
- `orquest_send_message` creará un trabajo hijo que hereda workspace, perfil, modelo, esfuerzo y acceso.
- El hijo guardará `parentJobId`; el original será inmutable.
- Continuar un trabajo activo responderá conflicto accionable. Encolar mensajes en puntos seguros queda fuera de esta fase.

### Reintento

- Siempre crea otro trabajo con `retryOfJobId`; nunca reabre el original.
- Permitirá modificar tarea, modelo o esfuerzo.
- No reutilizará `conversationId`: eso corresponde a continuación.

### Espera

- `orquest_wait_job` hará long-poll en el daemon, no polling repetido desde Codex.
- Timeout entre 1 y 60 segundos. Al expirar devuelve snapshot y `timedOut: true`, no un error.

## 6. API local requerida

```text
GET  /health
GET  /api/jobs?cursor=&limit=&status=&workspace=&profile=
POST /api/jobs/batch
GET  /api/jobs/:id
GET  /api/jobs/:id/events?cursor=&limit=
GET  /api/jobs/:id/wait?after=&timeoutSeconds=
POST /api/jobs/:id/messages
POST /api/jobs/:id/cancel
POST /api/jobs/:id/retry
GET  /api/jobs/:id/diff?cursor=&limit=
```

Todos los endpoints salvo un health mínimo exigirán token. Un health no autenticado, si se conserva, solo dirá `up`; no revelará rutas, versiones ni configuración.

## 7. Paquetes de trabajo

### 3.0 — Contratos y documentación

- Zod para cursores, filtros, batch, continuación y reintento.
- `parentJobId`, `retryOfJobId` e idempotencia persistible.
- Compatibilidad con trabajos ya almacenados.

Gate: typecheck y pruebas de rehidratación.

### 3.1 — Autenticación MCP → daemon

- Generar/cargar el token y aplicar middleware Bearer.
- Cliente MCP con timeout, aborto, validación loopback y errores redactados.

Gate: 401 sin token, 401 incorrecto, éxito correcto y cero secretos en logs/eventos.

### 3.2 — API de orquestación

- Batch idempotente, filtros, cursores, wait, continuación, reintento y cancelación `CANCELING`.

Gate: pruebas HTTP con Fake AGY y reinicio de SQLite.

### 3.3 — Servidor MCP definitivo

- Factoría testeable `createOrquestMcpServer` y cliente del daemon inyectable.
- Diez herramientas y anotaciones correctas.
- Instrucciones MCP: primeros 512 caracteres autosuficientes.
- stdout reservado al protocolo y outputs acotados.

Gate: transporte MCP en memoria y snapshot exacto del catálogo.

### 3.4 — Registro en Codex

- Configuración reproducible o script de registro sin paths personales ni secretos versionados.
- Política `writes`, límites de salida y guía de reinicio/diagnóstico.

Gate: Codex reiniciado descubre tools y `orquest_health` responde.

### 3.5 — Recorrido E2E

Con Fake AGY: health, dos submits, wait, dos páginas de transcript, continuación, cancelación y reinicio. Después se permite una sola prueba real estática en un directorio temporal vacío; el gate no enviará contenido del repositorio a Antigravity.

## 8. Pruebas

### Unidad

- cursores; anotaciones; compactación; loopback/token; herencia de continuación/reintento.

### Integración

- MCP autenticado contra daemon con Fake AGY;
- batch parcial e idempotencia;
- transcript sin huecos/duplicados;
- wait con cambio, terminal y timeout;
- persistencia de vínculos;
- cancelación y reinicio.

### Protocolo MCP

- inicialización STDIO sin ruido en stdout;
- catálogo y schemas exactos;
- errores `isError: true` redactados;
- outputs bajo presupuesto.

## 9. Criterios de aceptación

- Codex descubre el MCP tras reinicio.
- Health distingue daemon caído, auth inválida y runner no listo.
- Dos trabajos se crean en una llamada idempotente.
- Codex puede esperar, listar, inspeccionar y paginar.
- Continuación crea un hijo enlazado.
- Cancelación llega a estado terminal correcto.
- Lecturas no piden aprobación con política `writes`; mutaciones sí están anotadas.
- No hay secretos ni logs en stdout MCP.
- Typecheck, lint y tests pasan.

## 10. Fuera de alcance

- escritores/worktrees, dependencias, merge/push/deploy, acceso remoto, OAuth, MCP HTTP, dashboard completo y diff real de worktrees.

## 11. Delegación ordenada

1. `MCP-CONTRACTS-03`: contratos, cursores y vínculos.
2. `MCP-AUTH-03`: token y middleware; no toca tools.
3. `MCP-DAEMON-03`: batch/wait/message/retry.
4. `MCP-SERVER-03`: tools y cliente después de estabilizar API.
5. `MCP-QA-03`: revisión/E2E de solo lectura.

Solo un escritor por paquete. Sol revisará contratos, seguridad y gates antes de cerrar la fase.

Para delegar la fase sin perder identidad ni orden, usar [agent-handoff-phase-3.md](agent-handoff-phase-3.md): contiene los prompts completos para Agente A, B y C.

## 12. Referencias oficiales

- <https://learn.chatgpt.com/docs/extend/mcp.md>
- <https://learn.chatgpt.com/docs/config-file/config-reference>
