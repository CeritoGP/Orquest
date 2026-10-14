# Relevo operativo — Fase 3 MCP

## Cómo usar esta guía

Referencia histórica de la Fase 3. Para la siguiente asignación actual, leer
[handoff.md](handoff.md) y [continuation-progress.md](continuation-progress.md);
no repetir esta cadena por el simple hecho de encontrar sus prompts aquí.

Este documento permite continuar la Fase 3 aunque la sesión del orquestador se agote. Copia un bloque completo en una conversación distinta de Antigravity. Los agentes trabajan **en orden A → B → C**, no en paralelo, porque comparten contratos y el mismo árbol de trabajo.

La fuente de verdad es `AGENTS.md`, `IMPLEMENTATION_PLAN.md` y `docs/phase-3-mcp-plan.md`. Si hay contradicción, el agente debe detenerse y reportarla, sin crear un contrato alternativo.

## Identificación obligatoria

Cada respuesta inicial y cada informe final de un agente debe iniciar con esta forma exacta:

```text
[ORQUEST][AGENTE <A|B|C>][<ID-PAQUETE>][ESTADO: EN_PROGRESO|BLOQUEADO|FINALIZADO]
```

El informe final siempre incluye: resumen, archivos modificados, decisiones, riesgos, comandos ejecutados y resultados. Nunca incluye tokens, cookies, cadenas Bearer ni secretos.

## Reglas comunes para A, B y C

1. Leer completos `AGENTS.md`, `IMPLEMENTATION_PLAN.md` y `docs/phase-3-mcp-plan.md` antes de editar.
2. Inspeccionar código y pruebas existentes; no suponer que una API, migración o tipo ya existe.
3. Mantener TypeScript estricto y Zod en cada límite externo.
4. En Windows usar `npm.cmd`, nunca `npm`.
5. Al cierre ejecutar y reportar:

   ```powershell
   npm.cmd run typecheck
   npm.cmd run lint
   npm.cmd test
   ```

6. No usar `--dangerously-skip-permissions`, `shell: true`, secretos en logs, merge, push, despliegues, migraciones externas ni borrados amplios.
7. No editar archivos fuera del alcance asignado. Si una dependencia obliga a hacerlo, responder `BLOQUEADO` con evidencia y ruta exacta.
9. El árbol actual contiene trabajo no confirmado; nunca usar git reset, git checkout --, borrados amplios ni revertir cambios ajenos.
8. Persistir eventos antes de publicarlos y conservar el daemon limitado a `127.0.0.1`.

## Cadena de entrega

```text
A: MCP-CONTRACTS-03
        │ contratos, tipos y persistencia compatibles
        ▼
B: MCP-DAEMON-03
        │ token local, middleware y API HTTP
        ▼
C: MCP-SERVER-QA-03
        └─ herramientas MCP, registro de Codex y validación E2E
```

No inicies B sin el informe `FINALIZADO` de A y las tres verificaciones en verde. No inicies C sin el informe `FINALIZADO` de B, incluyendo pruebas de token ausente, token erróneo y token correcto.

---

## Agente A — MCP-CONTRACTS-03

**Prerrequisito:** ninguno. Es el primer agente de Fase 3.

Copia este prompt íntegro:

```text
[ORQUEST][AGENTE A][MCP-CONTRACTS-03][ESTADO: EN_PROGRESO]

Eres responsable de contratos y persistencia de Fase 3 de Orquest Bridge.
No implementes autenticación HTTP, endpoints nuevos ni herramientas MCP.

Lee AGENTS.md, IMPLEMENTATION_PLAN.md y docs/phase-3-mcp-plan.md completos.
Inspecciona primero packages/contracts, packages/core, packages/persistence,
apps/daemon y sus pruebas.

Objetivo:
Estabilizar contratos compartidos y persistencia necesarios para la interfaz MCP,
sin romper trabajos que ya se guardaron en Fase 2.

Alcance permitido:
- packages/contracts/src/**
- packages/core/src/** solo para tipos, creación o invariantes de Job necesarios
  para los vínculos nuevos
- packages/persistence/src/**
- pruebas asociadas a esos paquetes
- docs/ solo para documentar un contrato imprescindible

Entregables:
1. Schemas Zod exportados para cursor opaco, límites paginados, filtros de jobs,
   lote de 1 a 8 submits, idempotencyKey, continuación y reintento.
2. Campos persistibles compatibles para parentJobId, retryOfJobId e
   idempotencyKey. Los registros antiguos deben rehidratarse con valores seguros.
3. Tipos compactos para listas y eventos paginados, snapshots y resultado
   accepted/rejected por elemento de un lote. No diseñes payloads del SDK MCP.
4. Persistencia que pueda buscar por idempotencyKey dentro del ámbito definido y
   guardar/recuperar los vínculos parent/retry.
5. Pruebas de schemas, rehidratación, persistencia y duplicación idempotente.

Decisiones obligatorias:
- El cursor es opaco; no expongas offset interno como contrato.
- Un lote permite éxito parcial: un item rechazado no anula los demás.
- Un reintento no reutiliza conversationId. La continuación será un hijo y la
  implementará B; deja preparado el contrato, no la ruta HTTP.
- No renombres contratos públicos ya existentes sin migración documentada.

Fuera de alcance estricto:
- apps/daemon/src/server.ts y cualquier ruta HTTP.
- packages/mcp-server/**.
- Tokens, Authorization, env, perfiles, worktrees, dashboard y agy real.

Criterios de aceptación:
- Los contratos no dependen de Fastify ni del SDK MCP.
- Datos antiguos cargan sin error.
- La idempotencyKey evita duplicación conforme al contrato documentado.
- Pasan npm.cmd run typecheck, npm.cmd run lint y npm.cmd test.

No avances a B. Finaliza exactamente con:
[ORQUEST][AGENTE A][MCP-CONTRACTS-03][ESTADO: FINALIZADO]
Incluye archivos, resultados de las tres verificaciones, decisiones de
compatibilidad y una nota concreta con los exports que Agente B debe usar.
```

**Control antes de pasar a B:** verifica que el informe de A diga `FINALIZADO`, que no haya editado `packages/mcp-server`, y que explique el ámbito de idempotencia. Si falla algo, reenvía el error a A; no lo transfieras a B.

---

## Agente B — MCP-DAEMON-03

**Prerrequisito:** informe final válido de A (`MCP-CONTRACTS-03`).

Copia este prompt íntegro:

```text
[ORQUEST][AGENTE B][MCP-DAEMON-03][ESTADO: EN_PROGRESO]

Eres responsable de seguridad local y API HTTP del daemon en Fase 3 de Orquest
Bridge. Tu prerrequisito es el informe FINALIZADO de Agente A: revisa su diff,
exports y pruebas antes de editar. No implementes servidor MCP ni dashboard.

Lee AGENTS.md, IMPLEMENTATION_PLAN.md y docs/phase-3-mcp-plan.md completos.
Inspecciona apps/daemon, packages/contracts, packages/core,
packages/persistence y sus pruebas.

Objetivo:
Crear la frontera HTTP autenticada entre MCP y daemon, más las operaciones de
orquestación de Fase 3 usando los contratos entregados por A.

Alcance permitido:
- apps/daemon/src/** y pruebas
- packages/core/src/** solo para transiciones o servicio indispensables
- packages/persistence/src/** solo para integrar contratos de A
- packages/contracts/src/** únicamente para una incompatibilidad demostrable y
  probada; explícalo en el informe

Entregables:
1. Token local: ORQUEST_DAEMON_TOKEN solo para desarrollo, o secreto aleatorio
   generado/cargado bajo ORQUEST_HOME. Guarda referencia al archivo, nunca el
   token en config, respuestas, eventos o logs.
2. Middleware Bearer con comparación en tiempo constante. `/api/*` exige token.
   Si `/health` no exige token, solo puede devolver `{ up: true }` y no revelar
   versión, rutas ni capacidades.
3. Rechazar conexiones no-loopback y conservar bind `127.0.0.1`.
4. Implementar y validar con Zod:
   GET  /api/jobs?cursor=&limit=&status=&workspace=&profile=
   POST /api/jobs/batch
   GET  /api/jobs/:id
   GET  /api/jobs/:id/events?cursor=&limit=
   GET  /api/jobs/:id/wait?after=&timeoutSeconds=
   POST /api/jobs/:id/messages
   POST /api/jobs/:id/cancel
   POST /api/jobs/:id/retry
   GET  /api/jobs/:id/diff?cursor=&limit=
   El diff devuelve `available:false` hasta Fase 4.
5. Batch: 1–8 trabajos independientes read-only, con accepted/rejected por item
   e idempotencyKey.
6. Continuación: solo job terminal con conversationId; crear hijo con
   parentJobId, heredando workspace, perfil, modelo, esfuerzo y acceso. Un job
   activo devuelve conflicto accionable. No encolar mensajes a procesos vivos.
7. Reintento: crear un job nuevo con retryOfJobId; no reabrir ni reutilizar
   conversationId del original.
8. Wait: long-poll 1–60 segundos. Al vencer, devolver snapshot y
   `timedOut:true`; no 5xx ni polling desde MCP.
9. Persistir cada evento antes de notificar. Mantener CANCELING y evitar carrera
   entre cancelación y resultado final.
10. Pruebas HTTP/servicio: 401 sin token, 401 token incorrecto, token correcto,
    token redactado, idempotencia, batch parcial, cursores, wait (cambio,
    terminal y timeout), continuación, reintento, cancelación y reinicio.

Restricciones:
- No aceptar URL base desde un cliente.
- No usar shell, interpolación de comandos ni bypass de permisos.
- No implementar writers, dependencias, worktrees ni diff real.
- No tocar packages/mcp-server/** ni apps/dashboard/**.

Criterios de aceptación:
- El daemon sigue en loopback.
- Un cliente sin token no obtiene datos sensibles.
- Todas las entradas HTTP se validan con Zod.
- La suite usa Fake AGY; no requiere agy real.
- Pasan npm.cmd run typecheck, npm.cmd run lint y npm.cmd test.

No avances a C. Finaliza exactamente con:
[ORQUEST][AGENTE B][MCP-DAEMON-03][ESTADO: FINALIZADO]
Incluye endpoints, archivos, verificaciones, comportamiento de auth, diferencias
con A y los formatos concretos que C debe consumir (base URL, header y payloads).
Nunca reveles el token.
```

**Control antes de pasar a C:** B debe demostrar 401 para token ausente e incorrecto, éxito con token válido, y long-poll real en `wait`. Si alguno falta, B conserva el trabajo.

---

## Agente C — MCP-SERVER-QA-03

**Prerrequisito:** informe final válido de B (`MCP-DAEMON-03`).

Copia este prompt íntegro:

```text
[ORQUEST][AGENTE C][MCP-SERVER-QA-03][ESTADO: EN_PROGRESO]

Eres responsable del servidor MCP, su configuración local y el gate E2E de
Fase 3 de Orquest Bridge. Tu prerrequisito es el informe FINALIZADO de B;
revisa su diff, endpoints, esquema de token y pruebas antes de editar.

Lee AGENTS.md, IMPLEMENTATION_PLAN.md, docs/phase-3-mcp-plan.md y el informe de
B. Inspecciona packages/mcp-server, apps/daemon, packages/contracts y
 docs/codex-setup.md antes de cambiar nada.

Objetivo:
Transformar el MCP preliminar en la interfaz estable que Codex usa para
orquestar el daemon local autenticado. El MCP nunca es fuente de estado.

Alcance permitido:
- packages/mcp-server/src/** y pruebas
- docs/codex-setup.md
- docs/mcp-tools.md y docs/operations.md si son necesarios
- scripts/** solo para registro o diagnóstico local reproducible
- configuración de ejemplo dentro del repo, sin secretos ni rutas personales

Entregables:
1. Factoría testeable `createOrquestMcpServer` con cliente HTTP inyectable.
   stdout se reserva exclusivamente al protocolo MCP; diagnósticos a stderr.
2. Cliente con timeout/AbortSignal, header Bearer desde ruta de secreto o env de
   desarrollo, URL estrictamente loopback y errores redactados. Nunca imprimir
   el token.
3. Catálogo MCP final:
   - orquest_health
   - orquest_submit_jobs
   - orquest_list_jobs
   - orquest_get_job
   - orquest_wait_job
   - orquest_get_transcript
   - orquest_send_message
   - orquest_cancel_job
   - orquest_retry_job
   - orquest_get_diff
4. Zod para input y output de cada herramienta. Declarar correctamente lectura,
   mutación y operación destructiva. Respuesta textual breve más contenido
   estructurado útil. Listas, transcript y diff deben usar cursor y límite.
5. Sustituir `orquest_submit_job` por `orquest_submit_jobs`; no dejar alias sin
   una necesidad de compatibilidad demostrada.
6. Instrucciones MCP: sus primeros 512 caracteres deben bastar para saber que
   el daemon es local, qué herramientas son lecturas y que no hay merge, push ni
   deploy.
7. Guía reproducible: `.codex/config.toml` para proyecto confiable o `codex mcp
   add`; no versionar secretos ni rutas personales. Documentar reinicio y
   verificación con `/mcp` o `codex mcp list`.
8. Pruebas de protocolo: initialize, tools/list, schemas, stdout sin ruido,
   `isError:true` redactado, cursores, anotaciones y daemon fake autenticado.
9. E2E con Fake AGY: health, dos submits de lote, wait, dos páginas de
   transcript, continuación, cancelación y reinicio. Prueba real opcional: un
   directorio temporal vacío, read-only, una tarea estática; no enviar el repo a
   agy.

Restricciones:
- No tocar daemon ni contratos salvo incompatibilidad reproducible, mínima y
  documentada. Si ocurre, detenerse y reportarla.
- No implementar MCP HTTP, OAuth, dashboard, worktrees, diffs reales, merge,
  push ni despliegue.
- Recomendar `default_tools_approval_mode = "writes"`, sin modificar
  automáticamente la configuración global del usuario.

Criterios de aceptación:
- Tras reiniciar Codex se descubren las diez herramientas y health funciona
  contra daemon autenticado.
- Lecturas no solicitan aprobación innecesaria con política writes; mutaciones
  están identificadas.
- No hay secretos ni diagnóstico en stdout MCP.
- Pasan npm.cmd run typecheck, npm.cmd run lint y npm.cmd test.

Finaliza exactamente con:
[ORQUEST][AGENTE C][MCP-SERVER-QA-03][ESTADO: FINALIZADO]
Incluye catálogo, archivos, verificaciones, pasos manuales para registrar y
reiniciar Codex, pendientes fuera de alcance y riesgos. Nunca reveles secretos.
```

## Gate de cierre de Fase 3

Cuando C termine, revisa estos siete puntos:

1. Typecheck, lint y test pasan en el árbol completo.
2. Daemon en `127.0.0.1`; API protegida por Bearer; errores sin secretos.
3. Codex descubre las diez herramientas después de reiniciar.
4. Dos trabajos read-only se envían en lote sin duplicarse con la misma idempotencyKey.
5. Listas, transcript y diff son paginados; `wait` es long-poll.
6. Continuar crea hijo; reintentar crea intento nuevo; cancelar conserva eventos.
7. No se habilitaron writers, worktrees, OAuth, merge, push, deploy ni acceso remoto.

Si un gate falla, devuelve la corrección al propietario: contratos/persistencia a A; daemon/auth a B; MCP, documentación o pruebas de protocolo a C. No reasignes por intuición: exige una incompatibilidad demostrada.

