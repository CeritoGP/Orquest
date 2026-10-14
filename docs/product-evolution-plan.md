# Orquest: plan de evolución del producto

Fecha del diseño: 2026-10-06. Actualización de estado: 2026-10-07.
Estado: correcciones P0/P1a verificadas; aceptación visual pendiente; P1b–P6 planificadas.

El orden operativo se concreta en
[`continuation-plan.md`](continuation-plan.md): aceptación de P0, P1a
(contratos/persistencia) y P1b (daemon/adaptadores/MCP), después las vistas.
La revisión previa se conserva en
[`terra-review-next-steps.md`](terra-review-next-steps.md). La última verificación
registrada pasó 135 pruebas; consultar
[`continuation-progress.md`](continuation-progress.md) para evidencia y
[`delegation-plan.md`](delegation-plan.md) para asignaciones pequeñas.
Esta actualización documental no representa una nueva ejecución de pruebas.

Este documento concreta las mejoras solicitadas por el usuario y actualiza las
decisiones del MVP donde se indica. Leer junto con `AGENTS.md` e
`IMPLEMENTATION_PLAN.md`. La planificación no autoriza iniciar sesiones de IA,
consumir cuota, modificar autenticación o hacer commits automáticamente.

## 1. Resultado esperado

Desde Orquest, el usuario podrá abrir una tarjeta, leer su conversación completa,
hablar con el trabajador y continuar la tarea después de su resultado. También
podrá iniciar una conversación con Codex dentro de Orquest para que este gestione
trabajadores de Antigravity. El chat externo de Codex seguirá disponible por MCP.

Cada ejecución mostrará quién la encargó, qué modelo y esfuerzo solicitó, qué
modelo y esfuerzo ejecutó realmente y qué intentos forman parte de la tarea.
Profiles se editará desde la aplicación, sin reiniciar ni editar YAML a mano.

## 2. Estado de partida comprobado

- Existen daemon, SQLite, workers AGY, herramientas MCP y dashboard React.
- La API permite continuación de estados terminales con conversationId y reintentos
  de estados terminales o BLOCKED; no admite mensajes a un job activo.
- Continuar crea un job hijo; reintentar crea un intento vinculado al original.
- El dashboard solo ofrece cancelación; Profiles y Settings son principalmente
  informativos. Result ocupa una sección lateral sin límite de longitud.
- El campo model actual no distingue solicitud y ejecución; init del worker
  conserva datos crudos, pero no expone metadatos efectivos estructurados.
- Activity consulta eventos ascendentes: primeros 100, no últimos 100. Su recorte
  del DOM impide navegar todo el historial; SSE carece de recuperación completa.
- El aviso de novedad no sobrevive correctamente a recarga. BLOCKED no tiene
  finishedAt y la UI sigue calculando duración contra el reloj actual.
- P0 ya incorpora eventos inversos, recuperación tras reconexión que rellena
  automáticamente páginas intermedias, avisos de finalización persistentes y
  parada de ejecución para BLOCKED. La batería posterior pasa TypeScript, lint y
  123 pruebas, incluida una línea de tiempo de 250 eventos con solo diez nodos
  visibles; falta recorrer manualmente el flujo completo en navegador.
- Codex CLI 0.160.0 está instalado y reconoce app-server. No se ha validado
  autenticación, disponibilidad de modelos o ejecución integrada en Orquest.
- En la revisión previa, el repositorio no tenía HEAD. El trabajo de escritores
  con worktrees requiere un commit base; no crear uno sin revisar su contenido.

## 3. Decisiones de producto

### Tarjeta, conversación y ejecución

Una tarjeta actual representa un job, no un agente permanente. Se introducirá una
identidad estable de tarea/conversación (`taskSessionId`) que agrupe sus ejecuciones.
El worker puede cambiar de modelo o reiniciarse entre turnos sin perder el historial.

- La tarjeta principal mostrará el último intento y conservará acceso a todos.
- Continuar: nuevo mensaje y nuevo job hijo, intentando reutilizar la conversación
  AGY existente. El intento original conserva resultado, tiempos y eventos.
- Reintentar: nueva ejecución vinculada mediante retryOfJobId; sin reutilizar la
  conversación fallida por defecto.
- Si no se puede reanudar la conversación del proveedor, ofrecer explícitamente
  un nuevo intento con contexto recuperado. Mostrar que es una nueva sesión.
- Un mensaje directo al worker y una instrucción al orquestador son acciones
  diferentes y tendrán destinatario visible en el compositor.
- Solo una ejecución escritora por conversación/worktree a la vez. Serializar
  continuaciones y rechazar conflictos entre envíos desde UI y MCP.

### Kanban y navegación

- Interpretación adoptada: siete tarjetas por columna, ordenadas por actividad
  relevante más reciente. Un evento técnico no debe reordenar todo el tablero.
- Cabecera: total real y rango visible; navegación por cursor, siete por página.
- Nunca perder trabajos fuera de la página: búsqueda, filtros y enlace por ID.
- Si hay trabajos activos fuera de la página, mostrar su contador y acceso directo.
- Panel lateral compacto: estado, modelos, tiempos, resumen breve y acciones.
- Result deja de ser un bloque ilimitado: vista previa acotada y botón Abrir chat.
  El resultado completo aparece como mensaje del agente en la conversación.
- Ruta compartible propuesta: `/tasks/:taskSessionId/chat?job=:jobId`.
- Breadcrumb: Kanban > título de tarea > Chat > intento, cuando corresponda.
  Volver restaura filtros, página, tarjeta seleccionada y posición del tablero.
- Chat con mensajes paginados, scroll interno, Markdown seguro, bloques de código,
  copiar texto y detalles de herramientas expandibles. No mostrar razonamiento privado.
- No mantener el chat y el panel lateral descargando dos copias del mismo historial.

### Modelos, razonamiento y procedencia

Guardar metadatos por ejecución y por turno de orquestación, no solo por tarea:

| Información | Tratamiento |
|---|---|
| Worker solicitado | provider, modelId/modelPreference, requestedEffort |
| Worker efectivo | effectiveModelId, displayName, effectiveEffort, runnerVersion |
| Orquestador | provider, modelId, displayName, effort, sessionId, turnId, client |
| Procedencia | runtime-reported, client-reported, configured o unknown |
| Perfil | profileId y snapshot de su versión en esa ejecución |

`auto` es una preferencia, no un nombre de modelo real. Mostrar por ejemplo
Gemini 3.8 Flash / medium SOLO si el catálogo/protocolo identifica ese modelo;
no tomar el texto del prompt ni capturas como prueba de identidad.

Descubrir modelos y niveles por proveedor. No asumir que los valores permitidos
por AGY y Codex coinciden. Mostrar solicitado y efectivo si difieren; nunca hacer
una sustitución silenciosa. Si el proveedor no informa esfuerzo efectivo, mostrar
No reportado junto al esfuerzo solicitado.

Un cliente MCP externo puede declarar el modelo y esfuerzo del orquestador, pero
Orquest no puede leer automáticamente el selector de cualquier chat. Etiquetar esa
información como declarada por el cliente; si falta, No reportado. En el orquestador
integrado se registra la configuración de cada turno y lo que confirme el runtime.
No atribuir un modelo a trabajos históricos sin evidencia.

### Profiles dinámicos

- CRUD con nombre, descripción/rol, proveedor, modelo, esfuerzo, agente y acceso.
- Catálogos de capacidades alimentan selectores y validación en backend.
- Guardado persistente y aplicación a nuevos trabajos sin reiniciar.
- Versiones y control de edición concurrente; archivar perfiles en uso en vez de
  borrar sus referencias. Importación YAML inicial idempotente y exportación opcional.
- Cambiar un perfil nunca altera retrospectivamente una ejecución ni su snapshot.
- Profiles de worker y de orquestador se distinguen; los primeros no permiten
  cambiar el ejecutor AGY por Codex implícitamente.
- Los perfiles no conceden permisos globales. Settings administra límites y
  roots validados; no convertir el formulario en ejecución de comandos arbitrarios.

## 4. Orquestador Codex dentro de Orquest

Propuesta: dashboard -> daemon -> adaptador local Codex App Server por stdio.
Codex accede a las herramientas MCP de Orquest para enviar trabajo a AGY.
El daemon conserva la fuente de verdad y sirve ambos puntos de entrada.

La documentación oficial contempla integración en aplicaciones, login, hilos,
streaming y selección de modelos. Usar handshake y bindings de la versión instalada;
verificar `account/read`, `account/login/start`, `model/list`, `thread/start`,
`thread/resume` y `turn/start`. Hay componentes experimentales: comenzar con una
prueba de compatibilidad, no prometer integración estable antes de comprobarla.
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

Usar el login oficial con ChatGPT para acceso de suscripción. La API key corresponde
a uso facturado aparte; no activar ese fallback automáticamente. No copiar tokens
al frontend, SQLite o prompts. Las cuotas y modelos dependen de la cuenta.
[Autenticación](https://learn.chatgpt.com/docs/auth).

Este chat externo no se importa ni se controla automáticamente. Orquest gestionará
sus propias sesiones integradas; admitir migración de contexto explícita como
resumen verificable, no prometer transferir todo el historial.

La decisión antigua de que el dashboard solo observa se amplía: ahora también puede
ser cliente del MISMO rol de orquestación Codex. No introducir otro planificador
autónomo. Registrar origen y destinatario de cada instrucción; bloquear turnos
simultáneos que compitan por la misma sesión/worktree.

## 5. Fases y criterios de aceptación

| Fase | Entrega | Dependencia |
|---|---|---|
| P0 | Corregir paginación, reconexión, novedad y tiempos — código verificado; recorrido manual pendiente | Base actual |
| P1 | Sesiones de tarea, mensajes y procedencia/modelos | P0 |
| P2 | Chat de tarea y continuaciones desde UI/MCP | P1 |
| P3 | Kanban de siete tarjetas y navegación compacta | P1; reutiliza P2 |
| P4 | Profiles editables y catálogo de capacidades | P1 |
| P5a | Prueba de integración Codex local | Investigación independiente |
| P5b | Chat de orquestación integrado | P2, P4, P5a |
| P6 | Vistas operativas restantes y entrega completa | P3, P4, P5b |

### P0: corregir la base observada

Estado: correcciones automáticas verificadas el 2026-10-06; queda un recorrido
manual en navegador. La API conserva el cursor ascendente de MCP y
añade la dirección inversa para el dashboard. La vista inicial carga los diez
eventos más recientes, permite recuperar páginas anteriores y, tras una
reconexión SSE, recupera páginas inversas hasta enlazar con el historial ya
mostrado. Los avisos pendientes se guardan por intento
terminal en el almacenamiento local. `stoppedAt` congela el tiempo de un worker
bloqueado, sin hacer pasar BLOCKED por un resultado terminal irreversible.

- Añadir paginación inversa compatible: últimos diez eventos al abrir, páginas
  anteriores por cursor. Mantener la paginación ascendente existente para MCP.
- Mostrar una ventana de diez eventos con navegación entre páginas cargadas: el
  límite de DOM no puede hacer inaccesibles los primeros eventos. Dedupe y orden
  por secuencia.
- Snapshot tras reconexión y recuperación de eventos perdidos; si se añade replay,
  usar cursor global, pues sequence actual pertenece a cada job.
- Persistir pendientes/vistos de novedad sin reconocer todos al recargar.
- Separar fin de ejecución del estado final de la tarea: BLOCKED puede volver a
  estar READY. Registrar parada del worker y congelar duración. Históricos sin
  registro muestran dato no disponible; no inventar hora de finalización.
- Gate: historial de 250 eventos navegable; corte SSE con finalización durante la
  desconexión; aviso pendiente tras F5; bloqueo sin contador que siga creciendo.

### P1: contratos y persistencia

- Introducir taskSessionId, intentos, messageId, turnId y mensaje con rol,
  destinatario, estado de entrega, jobId y timestamp. Distinguir pending/sent/failed.
- Persistir prompt original, mensajes enviados, respuesta pública y resultado;
  agregar deltas por identificador de mensaje, sin duplicar snapshots/final.
- Capturar init/capacidades del worker y separar configuración solicitada/efectiva.
- Añadir contexto de orquestación opcional a submit/message/retry y persistirlo
  también en batch, con correlación por sesión/turno.
- APIs/MCP permiten localizar tarea, listar intentos y consultar chat paginado.
- Migración aditiva y transaccional con backup operativo. Histórico conserva IDs
  y puede asignarse a sesiones sin reescribir evidencia de modelos.
- Gate: reinicio conserva mensajes y vínculos; tests con datos históricos, eventos
  repetidos, batch y metadatos desconocidos.

### P2: conversación y continuidad

- Página de chat y botón Abrir chat en tarjeta/detalle. Encabezado con trabajador,
  modelo, esfuerzo, orquestador y estado; historial de intentos accesible.
- Compositor directo al worker. Al enviar desde DONE, crear continuación hija y
  conservar conversación y worktree; desde BLOCKED, ofrecer reintento o reanudación
  solo si el proveedor y contrato lo permiten y la causa está resuelta.
- Para job activo, inicialmente encolar mensaje para DESPUÉS de que termine el
  turno, con estado visible y opción de retirar el pendiente. No presentar la cola
  como entrega instantánea ni como interrupción que AGY no soporte.
- Idempotencia y exclusión mutua para doble clic, reenvío y UI/MCP concurrentes.
- MCP devuelve taskSessionId, jobId, latestAttemptId, relaciones y enlace de UI;
  lista/búsqueda permite al orquestador encontrar y continuar una tarea concreta.
- Gate: crear por MCP -> abrir en UI -> continuar allí -> continuar por MCP;
  historial único con tres intentos, sin perder resultados o mezclar mensajes.

### P3: Kanban y detalle compacto

- Siete tarjetas por columna, cursores, total y filtro por tarea/workspace/perfil/
  estado/modelo. Consulta por columna evita depender de primeros 100 jobs globales.
- Vista previa limitada de Result y navegación al chat; campos esenciales legibles.
- Volver desde breadcrumb recupera el tablero; enlaces profundos funcionan tras F5.
- Notificar terminaciones fuera de página con enlace a su tarea.
- Gate: 40 trabajos por columna, navegación completa, teclado y pantalla estrecha;
  ninguna tarea desaparece por el límite visual.

### P4: Profiles y capacidades

- CRUD, archivo, versionado, validación Zod, persistencia y actualización en vivo.
- Catálogos AGY/Codex con estado de disponibilidad, caché y botón Actualizar.
- YAML solo importa/exporta; editar en la UI es el flujo principal.
- Gate: editar y ejecutar sin reiniciar, preservar snapshot histórico, conflicto de
  dos ediciones detectado, opción inválida rechazada en backend.

### P5a/P5b: integración del orquestador

- P5a: validar login oficial y catálogo en la versión instalada; handshake,
  thread/turn, MCP Orquest requerido, streaming, cancelación y manejo de solicitudes
  de aprobación. Fixture fake para desarrollar sin consumir cuota.
- La prueba real mínima de login + conversación + delegación usa cuota y se hará
  durante implementación con visibilidad del usuario. Aquí no se ha ejecutado.
- P5b: vista Orquestador con sesiones, selector de modelo/esfuerzo y conexión de
  cuenta. Mostrar instrucciones y tarjetas creadas como enlaces navegables.
- Perfiles de orquestación orientados a delegar a AGY, sin ejecución directa
  duplicada de tareas asignadas. Aplicar límites, cancelación y aprobación del host.
- Reinicio permite retomar sesiones; fallo de login/quota produce estado accionable.
- Gate: una orden en Orquest crea dos workers, sigue ambos, resume resultados y
  continúa uno; modelos y esfuerzos por turno visibles, sin exponer credenciales.

### P6: vistas y entrega

- Agents: árbol orquestador -> tareas -> workers -> subagentes reportados, con
  modelos, esfuerzo, estado y enlaces. No inventar jerarquías no emitidas.
- Sessions: lista de conversaciones y grupos de intentos, búsqueda y reanudación.
- Logs: filtros, cursor, herramientas y diagnósticos redactados.
- Changes/Tests: resultados por intento, diffs paginados y comandos verificables.
- Settings: estado real de conexiones, puertos, roots, concurrencia y límites;
  persistencia y aviso explícito cuando un cambio requiere reiniciar.
- Overview: actividad, bloqueos y terminaciones sin revisar, con enlaces útiles.
- Analytics/Approvals: habilitar cuando existan datos y operaciones reales; uso no
  reportado figura como no disponible, nunca como cero ni costo calculado ficticio.
- Guía de instalación, uso, permisos y recuperación actualizada. Cada vista tiene
  estados vacíos, error/reintento, foco visible y ninguna navegación decorativa.

## 6. Distribución propuesta entre agentes

Es una asignación propuesta para las próximas órdenes; no hay agentes nuevos
trabajando como resultado de este documento.

| Agente | Responsabilidad y ownership |
|---|---|
| A | Contratos y persistencia: packages/contracts, packages/persistence; migraciones y compatibilidad |
| B | Daemon/core/adaptadores/MCP/scripts; procesos, catálogo, continuaciones e integración Codex |
| C | Dashboard: rutas, chat, Kanban, formularios, UX y pruebas de interfaz |
| Orquestador | Orden de fases, aceptación, revisión de contratos y recorridos integrados |

Primero A entrega contratos acordados; después B y C pueden trabajar en sus
directorios. No dos escritores sobre el mismo archivo. A/B coordinan cualquier
cambio en contratos; C no los cambia lateralmente. Una fase no se declara completa
solo porque pasan las pruebas del cliente HTTP.

Cada prompt y entrega lleva:
`[ORQUEST][AGENTE A|B|C][P<n>-<TAREA>][ESTADO: ASIGNADO|EN_PROGRESO|FINALIZADO|BLOQUEADO]`.

Entregar archivos, decisiones, pruebas, evidencia del recorrido y límites reales.
Respetar AGENTS.md: loopback, rutas validadas, sandbox y sin permisos universales.

## 7. Contratos propuestos y gates generales

Nombres de endpoints nuevos a cerrar en P1, no promesa de API existente:

- `/api/task-sessions`: listar, buscar, detalle e intentos vinculados.
- `/api/task-sessions/:id/messages`: historial paginado y envío dirigido al worker.
- `/api/capabilities`: proveedores, modelos/esfuerzos disponibles y estado.
- `/api/profiles`: CRUD versionado y eventos de cambio.
- `/api/orchestrator/sessions`: sesiones, turnos y eventos del chat integrado.

Mantener compatibilidad de herramientas MCP actuales; extender schemas de entrada
y snapshots sin obligar a clientes antiguos a conocer metadatos nuevos.

Por fase: `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`; ejecutar
también build y pruebas de navegador en las fases de UI. Regresiones significativas
requieren casos de reconexión, cursor, carrera de mensajes y migración. Verificar
un recorrido con fake workers y posteriormente AGY real. Ninguna prueba fake
demuestra autenticación o nombres efectivos de modelos del proveedor.

Próxima orden de implementación: P1. La investigación P5a puede
avanzar independientemente, pero el chat integrado depende de la base de P1/P2.
