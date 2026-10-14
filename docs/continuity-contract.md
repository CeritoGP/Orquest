# Contrato de continuidad por tarea

Estado: D01 aceptado por el orquestador el 2026-10-13. Este documento fija el
contrato para D02–D05; no implementa almacenamiento, HTTP ni MCP.

## Identidad y relaciones

Una tarea estable es `TaskSession` (`taskSessionId`): tiene un `rootJobId`, un
workspace inmutable y varios `JobRecord` ordenados por `attemptIndex`. Un intento
es un job histórico, por lo que continuar y reintentar crean otro intento y no
alteran el anterior. Las relaciones `parentJobId` y `retryOfJobId` expresan el
origen; no se agrupa por título, dependencia ni revisión.

`TaskMessage` pertenece a la tarea y conserva su `jobId` de origen, que puede
ser nulo para una instrucción todavía pendiente. `providerIdentity` distingue
proveedor, conversación, turno y mensaje cuando el protocolo los informa. Los
campos ausentes en datos históricos permanecen ausentes (los consumidores los
presentan como desconocidos), sin inventar una identidad de proveedor ni
reescribir el payload histórico durante la lectura.

La persistencia permite que D03 complete una `providerIdentity` desconocida solo
mediante una operación específica de enriquecimiento set-once. Una actualización
genérica puede cambiar contenido o estado de entrega, pero no `recipient`,
`intent`, `target`, contexto del orquestador ni identidad de proveedor. Una vez
conocida, la identidad solo puede repetirse exactamente; nunca se reemplaza.

Una instrucción pendiente usa `target: next-attempt`. Al despacharla, D02/D08
crean en la misma transacción un `TaskMessageAttemptDispatch` hacia el nuevo
intento. No se cambia `TaskMessage.jobId`: esa protección evita que una
actualización genérica reescriba la identidad histórica del mensaje.

La relación de despacho tiene unicidad por `taskMessageId`: un mensaje se
enlaza como máximo a un intento. D02/D08 comprueban dentro de la transacción que
mensaje, intento y sesión pertenecen a la misma tarea antes de insertar la
relación. Un reinicio ambiguo no autoriza crear una segunda relación ni afirmar
entrega; D08 conserva la incertidumbre para recuperación explícita.

## Metadatos y fuentes

`model` y `effort` del job siguen siendo solicitados. Los valores efectivos son
independientes y solo pasan a ser `runtime` si un límite de ejecución confiable
los reporta. `OrchestratorTurnContext` guarda la misma separación por turno;
el input externo solo admite fuentes `client`, `configured` o `unknown` y no
incluye valores efectivos. La lectura histórica conserva `OrchestratorMetadata`
sin reinterpretarla. Un contexto omitido no se hereda automáticamente al turno
siguiente.

## Inputs, respuestas, cursores y errores

Los exports de `@orquest/contracts` congelados por D01 son:

- `TaskSessionSchema`, `PaginatedTaskAttemptsResponseSchema` y
  `TaskReadResponseSchema` para tarea e intentos.
- `TaskMessageSchema`, `PaginatedTaskMessagesResponseSchema`,
  `ProviderMessageIdentitySchema`, `TaskMessageTargetSchema` y
  `TaskMessageAttemptDispatchSchema` para el chat y la cola futura.
- `TaskContinuationInputSchema`, `TaskRetryInputSchema` y
  `TaskMutationResponseSchema` para mutaciones por tarea. Las claves de replay
  son obligatorias. Retry reutiliza los overrides legacy (`task`, `model`,
  `effort`, `verificationCommands`) y añade un selector opcional
  `fromAttemptId` y contexto de orquestador declarable.
- `PaginationQuerySchema` conserva cursores opacos, límite 1–100 y dirección.
  `TaskAttemptCursorSchema` y `TaskMessageCursorSchema` fijan el contenido
  interno: `taskSessionId`, dirección y el límite estable de orden. Intentos y
  mensajes usan el mismo envelope `items`, `nextCursor`, `hasMore`.
- `ContractErrorResponseSchema` fija `VALIDATION_ERROR`, ausencia de tarea o
  intento, conflicto, conflicto de idempotencia y mensaje no despachable.

Una clave nueva queda reservada por **tarea + idempotencyKey** para cualquier
mutación de continuidad. El fingerprint canónico incluye el tipo de operación
(`continue`, `retry` o mensaje en cola), selector y payload. Repetir exactamente
la misma operación devuelve la respuesta normalizada original con
`idempotentReplay: true`; reutilizar la clave en otra operación o con cualquier
contenido distinto devuelve `IDEMPOTENCY_CONFLICT`, sin replay cruzado.
D02/D04 deben guardar la reserva y fingerprint en la misma transacción.
La búsqueda histórica de creación de jobs permanece delimitada por
`workspacePath + idempotencyKey`; no se cambia en D01. La reserva nueva no se
copia al `idempotencyKey` del job, de modo que no contamina ese lookup legacy.

### Escrituras iniciales y mutaciones por tarea

D03 usa `saveInitialJobWithTaskMessageAndEvent` al registrar un submit inicial:
es una escritura atómica de intento nuevo, mensaje inicial y evento ya
normalizado, y conserva la `idempotencyKey` legacy opcional con scope de
workspace. El evento devuelto solo se publica después del commit. Un ID de job
ya persistido se rechaza para que esta operación creadora no adquiera la
semántica de actualización de `saveJob`.

D04 usa `saveTaskMutation` para `continue`, `retry` y cola por tarea. Esa ruta
requiere la clave por tarea, reserva su fingerprint y no escribe la clave en el
índice legacy. Ninguna de las dos sustituye los métodos legacy existentes de
dos argumentos: D04 conserva su replay histórico para submit inicial hasta que
integre las superficies nuevas.

### Lecturas paginadas

`GET attempts` ordena por `attemptIndex ASC, jobId ASC`; `GET messages` por
`createdAt ASC, messageId ASC`. Una solicitud `backward` puede consultar desde
el final, pero devuelve `items` en orden ascendente para que el chat no invierta
la pantalla. El cursor siguiente codifica sesión, dirección y la última
frontera del orden; cambiar la tarea o la dirección, o usar un cursor malformado,
es `VALIDATION_ERROR`. D02/D04 no reutilizan los cursores de lista global de
jobs para estas lecturas por tarea.

El listado interno de sesiones usa orden fijo `updatedAt DESC, id DESC` y solo
admite dirección `forward`; rechaza `backward` en vez de ignorarla. Su cursor
valida el UUID y fecha mediante `TaskSessionSchema`.

### Continuar, reintentar y cola

`fromAttemptId` siempre selecciona el **origen** de una nueva continuación o
retry; nunca es un destino para inyectar texto en ese job. `target: attempt`
requiere ese selector y conserva esta misma semántica de origen; el nuevo intento
queda enlazado mediante `parentJobId` para continuación o `retryOfJobId` para
retry. Si se omite, D04 selecciona atómicamente el intento elegible más reciente
de la tarea por `attemptIndex`. Un selector ajeno a la tarea devuelve
`ATTEMPT_NOT_FOUND`.

La política inicial para una tarea con intento activo es `TASK_ACTIVE`: no se
crea un intento ni se inyecta el mensaje. D08 será la primera entrega que admite
`target: next-attempt` como cola persistente, con orden por tarea, retirada solo
antes de despacho y exclusión de despacho. Si `recipient: orchestrator` no tiene
adaptador disponible, D04/D05 devuelve `ORCHESTRATOR_UNAVAILABLE`; no simula
una ejecución ni cambia el destinatario.

## Interfaces propuestas para D04/D05

HTTP propuesto, autenticado y con validación Zod:

```text
GET  /api/tasks/:taskSessionId
GET  /api/tasks/:taskSessionId/attempts?cursor=&limit=
GET  /api/tasks/:taskSessionId/messages?cursor=&limit=&direction=
POST /api/tasks/:taskSessionId/continuations
POST /api/tasks/:taskSessionId/retries
```

Las rutas por `jobId` existentes siguen siendo compatibles. D04 resuelve el
intento aplicable dentro de la sección crítica y persiste antes de publicar SSE.
El endpoint de continuación acepta `TaskContinuationInputSchema` y responde
`TaskMutationResponseSchema`; retry acepta `TaskRetryInputSchema` y obtiene la
tarea de la ruta. Las rutas legacy por job mantienen `JobRetryInputSchema` y su
semántica opcional de clave.

Herramientas MCP propuestas para D05: `orquest_get_task`,
`orquest_list_task_attempts`, `orquest_get_task_messages`,
`orquest_continue_task` y `orquest_retry_task`. Las lecturas son paginadas; las
mutaciones usan los mismos inputs/respuestas e idempotencia que HTTP. Las
herramientas existentes por job ID no se eliminan.

## Límites de esta entrega

D01 no modifica SQLite, el daemon, adaptadores, MCP ni UI. D02 implementará
las consultas, la relación de despacho y la migración; D03 guardará mensajes
del worker y metadatos runtime; D04/D05 conectarán estas interfaces.
