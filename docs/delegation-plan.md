# Orquest: plan de delegación por entregas

Fecha: 2026-10-07; checkpoint actualizado el 2026-10-13.
Estado: preparado para asignar; ningún agente se activa por
crear este documento. Modelo de implementación: el modelo económico que el
usuario elija, sin depender de una marca ni cambiar su configuración.

## 1. Base real y objetivo

La última verificación repetida por el revisor pasó typecheck, lint y **137
pruebas en 15 archivos**, además de build, el 2026-10-13 al aceptar D00. Consultar
[`continuation-progress.md`](continuation-progress.md) para la evidencia.

Ya existen contratos y persistencia de sesión de tarea, intentos, mensajes,
snapshots de perfil y procedencia de modelos. No rehacer P1a. Falta integrarlos
en el flujo del daemon/adaptador/MCP y construir el chat. P0/D00 ya fue aceptado
con evidencia fake en navegador.
Los tests fake no demuestran funcionamiento con Antigravity real.

Objetivo: una tarjeta representa **una tarea estable con varios intentos**, no
un agente permanentemente vivo. Puede continuarse desde Orquest o MCP, conserva
su conversación y muestra modelos y orquestador sin inventar datos.

Esta guía divide el trabajo de [`continuation-plan.md`](continuation-plan.md).
`AGENTS.md` manda sobre seguridad. Antes de cambiar contratos, persistencia,
procesos, MCP o permisos, leer `IMPLEMENTATION_PLAN.md` completo. Los documentos
de revisiones anteriores son históricos, no órdenes para repetir trabajo hecho.

## 2. Cómo delegar sin enviar todo el chat

1. Pegar el prompt del apartado 7, cambiando únicamente el ID de entrega.
2. Asignar **una entrega por vez**. El mismo agente económico puede asumir los
   roles A, B y C sucesivamente; no hacen falta tres suscripciones o chats.
3. El agente lee la entrega, sus prerrequisitos y los archivos afectados. No
   copiar toda la conversación ni volver a auditar el repositorio entero.
4. Entrega cambios, pruebas y un informe breve en
   `docs/delegation-results/<ID>.md`; después se detiene.
5. El orquestador revisa el cambio y registra su aceptación en
   `docs/continuation-progress.md`. Solo entonces se asigna la siguiente entrega.
   Un agente no puede declarar aprobada su propia entrega.

Roles: **A** contratos/persistencia; **B** daemon/adaptadores/MCP/operación;
**C** dashboard. El rol indica propiedad de archivos, no un modelo concreto.
No ejecutar agentes concurrentes sobre un archivo compartido. Si se permite
paralelismo posteriormente, congelar primero contratos y asignar archivos
exclusivos; la ejecución secuencial es el modo previsto para esta guía.

### Revisión y uso de cuota

- El modelo económico implementa entregas acotadas con criterios verificables.
- Revisión reforzada del orquestador en D01–D05, D08, D12–D13 y D15–D16:
  contratos, datos, concurrencia, secretos y procesos. Esto no exige usar un
  modelo caro para toda la implementación ni garantiza un ahorro cuantificado.
- Primero fixtures y proveedores fake. No iniciar workers reales, autenticaciones
  ni sesiones Codex para explorar capacidades sin una asignación explícita.
- Si el modelo admite ajustar razonamiento: usar esfuerzo moderado para UI y
  mayor atención para transacciones/seguridad. No confundir los niveles de Codex
  con los de Antigravity ni configurar valores no admitidos por el proveedor.
- Evitar reejecutar verificaciones sin cambios. Para código, ejecutar primero
  los tests focalizados y, antes de entregar, los tres comandos de `AGENTS.md`.
  Para documentos, comprobar enlaces y consistencia; no repetir la suite entera.

## 3. Orden y dependencias

**D00, D01 y D02 ACEPTADOS el 2026-10-13**; D03–D21 pendientes. El progreso conserva la
revisión de código, gates completos y evidencia acumulada V01–V08. Los bloqueos
de navegador y entregas parciales anteriores son históricos; no reabrir D00
sin una regresión nueva. Siguiente asignación: **agente B, D03**. Consultar
[`delegation-results/D00.md`](delegation-results/D00.md) para la evidencia.
Una dependencia significa entrega aceptada, no únicamente informe recibido.

| ID | Rol | Entrega | Depende de |
| --- | --- | --- | --- |
| D00 | C | Aceptación visual de P0 — ACEPTADO | — |
| D01 | A | Congelar contrato de continuidad — ACEPTADO | D00 |
| D02 | A | Consultas y operaciones de tarea en SQLite | D01 |
| D03 | B | Mensajes y metadatos públicos del worker | D02 |
| D04 | B | API HTTP de tareas y continuación | D03 |
| D05 | B | Continuidad y chat por MCP | D04 |
| D06 | C | Chat de lectura y navegación | D04 |
| D07 | C | Responder, continuar y reintentar desde UI | D05, D06 |
| D08 | A/B | Cola de mensajes y recuperación | D05, D07 |
| D09 | C | Mensajes pendientes y retirada en UI | D08 |
| D10 | A/B | Consulta Kanban paginada por columna | D04 |
| D11 | C | Siete tarjetas y resultados compactos | D06, D10 |
| D12 | A | Profiles persistentes y versionados | D02 |
| D13 | B | API de Profiles y capacidades | D12 |
| D14 | C | Editor de Profiles | D13 |
| D15 | B | Prueba de compatibilidad de Codex | D05 |
| D16 | B | Adaptador del orquestador interno | D14, D15 |
| D17 | C | Chat del orquestador interno | D09, D16 |
| D18 | C | Vistas Sessions y Agents | D09, D11 |
| D19 | C | Vistas Logs, cambios y pruebas | D18 |
| D20 | B/C | Settings y operación Windows | D13, D19 |
| D21 | A/B/C | Aceptación integrada y guía de uso | D14, D20; D17 si compatible |

Secuencia recomendada: D00 → D01–D07 → D10–D11 → D08–D09 → D12–D14 →
D15–D17 → D18–D21. Si D15 demuestra incompatibilidad, registrar el motivo,
no asignar D16/D17 y completar el producto con orquestación externa por MCP.

**Primer hito utilizable:** D07 + D11. Permite leer y continuar tareas, ver siete
tarjetas por columna y abrir resultados completos en el chat. No depende de
integrar Codex dentro de Orquest.

## 4. Fichas de implementación

Cada ficha autoriza únicamente su alcance y tests asociados. Cualquier cambio
necesario fuera de él se propone en el informe, no se incorpora silenciosamente.

### D00 — Aceptación visual de P0

- Archivos: fixtures/tests del dashboard y reporte; no rediseñar la aplicación.
- Entorno: fake-agy, base y puertos aislados; no tocar la instancia personal.
- Probar en navegador 250 eventos, máximo diez visibles, páginas anteriores,
  retorno a vivo, reconexión con huecos y cambio de tarjeta con peticiones activas.
- Probar novedad tras recarga, errores recuperables y duración congelada de BLOCKED.
- Aceptación: evidencia por caso y build del dashboard. Si falta acceso a navegador,
  informar pendiente; no sustituirlo por la afirmación de que jsdom equivale a UI.
  Si aparece una regresión, documentar una corrección acotada para aprobarla.

### D01 — Contrato de continuidad, sin rehacer la base

- Archivos: `packages/contracts/src/index.ts`, sus tests y especificación breve.
- Inventariar qué existe y qué falta: identidad de turno/mensaje del proveedor,
  mensajes pendientes, destino, contexto del orquestador y sesiones/intentos.
- Definir requests/responses Zod, cursores, errores, idempotencia y relaciones.
  Proponer y congelar endpoints/tools antes de B/C; conservar API de jobs existente.
- Separar modelo/esfuerzo solicitado de efectivo y fuente runtime/client/configured/
  unknown. Un cliente no puede declarar metadatos propios como runtime verificado.
- Aceptación: fixtures válidos/inválidos y compatibilidad de payloads históricos.
  Si ya existe un campo, reutilizarlo; no ampliar contratos por conveniencia estética.

### D02 — Persistencia y lectura por tarea

- Archivos: `packages/persistence/src/index.ts` y tests; core solo si D01 lo exige.
- Implementar consultas paginadas de tareas e intentos y operaciones que faltan
  para instrucción inicial/continuación + mensaje + evento persistido.
- Preservar asignación transaccional de `attemptIndex`, sesión/workspace inmutables,
  snapshot independiente y datos históricos. Usar registros normalizados devueltos.
- Diseñar enlace explícito del mensaje pendiente a su futuro intento: hoy `jobId`
  es inmutable al actualizar un mensaje. No eliminar esa protección para evitar
  diseñar la operación. Dejar la ejecución de la cola para D08.
- Aceptación: rollback, dos conexiones, reinicio, paginación y migración de fixture
  antiguo sin pérdida. Nunca experimentar con la base personal.

### D03 — Conversación y metadatos del worker

- Archivos: `packages/agy-adapter`, `packages/fake-agy`, integración mínima del
  servicio daemon y tests; no UI ni nuevas herramientas MCP.
- Persistir instrucción y respuestas públicas. Reconciliar deltas/finales con
  identidad estable; el stream repetido no crea mensajes ni resultados duplicados.
- Registrar modelo/esfuerzo efectivos solo si el protocolo los informa; guardar
  desconocido en otro caso. No atribuir un modelo concreto porque se pidió `auto`.
- Excluir razonamiento privado y redactar secretos antes de persistir/publicar.
- Aceptación: streams fragmentados/repetidos, final sin resumen, cancelación,
  identidad desconocida y secretos. Fake determinista; no ejecutar AGY real.

### D04 — HTTP de tareas y continuidad

- Archivos: `apps/daemon/src/server.ts`, `service.ts`, tests y documentación HTTP.
- Consultar tarea, intentos y mensajes; continuar/reintentar por identidad estable.
  Resolver el intento aplicable dentro de la protección contra carreras.
- Usar escritura atómica, devolver el job normalizado y persistir antes de SSE.
  Guardar contexto de orquestador por turno, sin heredarlo si no se proporcionó.
- Mantener autenticación y protección de escrituras frente a origen no permitido;
  canonicalizar rutas y conservar exclusión de escritores y permisos existentes.
- Aceptación: carreras de dos clientes, replay idempotente, 401/errores Zod,
  sesión inexistente y política explícita para DONE/FAILED/CANCELED/BLOCKED.

### D05 — Continuidad por MCP

- Archivos: `packages/mcp-server`, tests y `docs/mcp-tools.md`.
- Exponer lectura paginada de tarea/chat/intentos y continuación/reintento por
  identidad estable, según D01. Conservar herramientas basadas en job ID.
- Respuestas compactas con cursores; anotaciones honestas de herramientas mutantes.
  Documentar cómo identificar la tarjeta y cómo aportar contexto del orquestador.
- Aceptación: E2E fake con tres intentos, sin duplicados, secretos redactados,
  paginación y compatibilidad de clientes anteriores. Actualizar tests de listado
  de tools; no mantener un número fijo antiguo que impida añadir capacidades.

### D06 — Chat de tarea en lectura

- Archivos: `apps/dashboard/src` y tests; consumir exclusivamente D04.
- Ruta de tarea con breadcrumb Kanban → tarea → intento; vista de conversación
  paginada, resultados completos, selector/historial de intentos y estados claros.
- Mostrar trabajador y orquestador por turno: proveedor, modelo, esfuerzo y fuente.
  Distinguir solicitado/efectivo y renderizar desconocido sin suposiciones.
- Aceptación: enlace directo/recarga, historial grande acotado, Markdown seguro,
  cargas/errores/vacíos, cambio de tarea sin datos mezclados y navegación por teclado.

### D07 — Continuar desde la UI

- Archivos: dashboard y tests; no cambiar semántica backend acordada.
- Añadir compositor, continuar, reintentar y estados de envío/error. Tras terminar
  un intento, la tarea conserva su chat y permite otro intento cuando sea compatible.
- La instrucción muestra destino/perfil y permisos; no elevar privilegios al reintentar.
- Aceptación: doble clic/reintento de red no duplica instrucciones; un nuevo intento
  conserva tarea, historial y snapshot anterior. Para trabajo activo mostrar la
  limitación actual, no fingir conversación instantánea; la cola llega en D08/D09.

### D08 — Mensajes durante ejecución y recuperación

- Archivos: persistencia, core/daemon y MCP; contratos solo conforme a D01.
- Guardar instrucciones mientras corre un turno y procesarlas al terminar cuando
  sea permitido. No introducir inyección en vivo sin soporte probado del proveedor.
- Estados pendientes/enviados/fallidos, retirada solo antes de despacho, orden
  persistente, exclusión por tarea y enlace atómico mensaje → intento.
- Aceptación: UI/MCP concurrentes, retirar vs despachar, crash/reinicio y permisos.
  Si el proveedor no permite garantizar entrega única tras un crash ambiguo,
  registrar incertidumbre y pedir resolución; no reenviar ni afirmar éxito en silencio.

### D09 — Cola visible en el chat

- Archivos: dashboard y tests.
- Habilitar envío durante ejecución con explicación «se procesará al terminar»,
  destino, estado persistido y acción retirar mientras siga pendiente.
- Aceptación: recarga conserva cola, retirada confirma estado servidor, carreras
  muestran error recuperable y un fallo conserva la instrucción para decidir.

### D10 — Kanban paginado en backend

- Archivos: contratos acordados, persistencia, daemon y tests; no dashboard.
- Consultar siete tareas por columna con total y cursores estables, usando último
  intento y actividad significativa; no limitar primero una lista global a cien.
- Una tarjeta por tarea, no por intento. Especificar cómo se representan históricos
  y cómo se ordenan empates, filtros y cambios de estado entre páginas.
- Aceptación: al menos cuarenta tareas por columna; todas accesibles sin duplicados
  entre páginas estables. SSE/reinicio no borra selección ni altera identidad.

### D11 — Siete tarjetas y Result compacto

- Archivos: dashboard y tests.
- Siete tarjetas por columna, total y navegación explícita; conservar filtros y
  selección al volver del chat. Señal de finalización no vista independiente de estado.
- Sustituir Result lateral ilimitado por extracto acotado + «Abrir conversación».
- Aceptación: cuarenta tareas/columna, resultados largos, móvil/teclado, breadcrumb
  y novedad tras recarga. No usar scroll infinito como sustituto del límite pedido.

### D12 — Profiles versionados en SQLite

- Archivos: contratos/core profiles/persistencia y tests.
- CRUD versionado y archivado, importación inicial de YAML una sola vez y validación
  de perfiles. Resolver precedencia sin que un reinicio vuelva a sobrescribir ediciones.
- Concurrencia optimista con `expectedVersion`; snapshot de cada intento permanece
  inmutable. Archivar no borra datos históricos ni altera trabajos activos.
- Aceptación: importación repetida, versiones concurrentes, reinicio y perfil
  archivado. Migraciones internas en fixtures; no migraciones de proyectos externos.

### D13 — API de Profiles y capacidades

- Archivos: daemon, adaptador si requiere lectura de capacidades, tests y docs.
- Exponer edición/archivado autenticados, conflicto 409 y cambios visibles sin
  reinicio; validar cada campo y publicar notificación solo tras persistir.
- Catálogo de modelos/esfuerzos con proveedor, versión y fuente; indicar si no se
  puede descubrir. No codificar «Gemini 3.8» como modelo disponible por una captura.
- Aceptación: catálogo conocido/desconocido, campo incompatible, conflicto, redacción
  y snapshots de trabajos anteriores intactos.

### D14 — Editor de Profiles

- Archivos: dashboard y tests.
- Crear/editar/archivar perfiles desde formularios, sin YAML manual. Selectores
  basados en capacidades conocidas y validación clara cuando falte catálogo.
- Conflicto 409 permite revisar/recargar; no sobrescribir silenciosamente.
- Aceptación: CRUD, errores, reinicio, perfiles archivados, accesibilidad y cambios
  efectivos solo en futuros intentos. No prometer niveles inexistentes.

### D15 — Compatibilidad del orquestador Codex

- Archivos: prueba aislada/tests fake y reporte técnico; no UI ni conexión de cuenta.
- Verificar documentación oficial vigente y versión instalada: app-server/transport,
  sesión propia, catálogo, autenticación de cuenta, aprobaciones y conexión MCP.
  Usar la skill de OpenAI correspondiente y enlazar fuentes/fecha en el informe.
- Prototipo de handshake/protocolo con fake, sin sesiones reales ni cambios de login.
- Aceptación: matriz soportado/no soportado/desconocido, límites de la suscripción,
  paso manual requerido y recomendación de seguir o descartar D16/D17. No asumir
  API cubierta por la suscripción ni acceso al historial externo de este chat.

### D16 — Adaptador Codex interno, condicionado a D15

- Archivos: nuevo módulo de integración, daemon, contratos acordados y tests.
- Crear sesiones propias, procesar turnos y aprobaciones mediante mecanismo
  soportado; conectar herramientas Orquest y persistir identidad del orquestador.
- Procesos sin shell, secretos redactados, cierre de árboles Windows, recuperación
  explícita y errores de autenticación. No ejecutar comandos aprobados por defecto.
- Aceptación: tests fake y prueba real mínima solo con autorización visible,
  autenticación existente y presupuesto acordado. Si D15 lo impide, no implementar
  un bypass con automatización de navegador, extracción de cookies o tokens.

### D17 — Chat del orquestador interno

- Archivos: dashboard y tests.
- Vista adicional para sesiones propias de Codex, selección válida de modelo/esfuerzo,
  actividad y enlaces a tareas delegadas; aprobaciones reales del runtime visibles.
- Aceptación: nueva sesión, turnos, denegar/aprobar y navegación a tarea; MCP externo
  sigue operativo. No simular importación de este chat ni mostrar una sesión fake
  como cuenta real conectada. Guía clara de requisitos y errores.

### D18 — Sessions y Agents

- Archivos: dashboard; consultas backend solo si faltan y están acordadas.
- Sessions: tareas, intentos y sesiones de proveedor vinculadas con búsqueda/filtros.
  Agents: ejecuciones y subagentes realmente reportados, perfiles y estados.
- Aceptación: datos enlazan al chat correcto, paginación y vacíos útiles. No
  inventar agentes permanentes ni subagentes/modelos que el worker no reporta.

### D19 — Logs, cambios y pruebas

- Archivos: dashboard; endpoints existentes primero, ampliaciones acotadas si faltan.
- Logs paginados/filtrados con secretos redactados. Navegación a diff y verificaciones
  por intento, sin cargar resultados completos en todas las tarjetas.
- Aceptación: error recuperable, historial grande, intento fallido/sin worktree y
  pruebas no ejecutadas distinguibles de pruebas exitosas. Sin resultados ficticios.

### D20 — Settings y operación Windows

- Archivos: dashboard Settings, scripts, `.bat`, tests y documentación operacional.
- Mostrar configuración segura y salud real; editar solo opciones previstas por
  contrato. Explicar permisos de proyecto, sin otorgar privilegios globales.
- Arranque informa URL efectiva, mantiene terminal visible, espera readiness y
  reutiliza servicios compatibles o explica puerto ocupado. Parada solo de procesos
  propiedad de Orquest, sin matar procesos por puerto/nombre de forma indiscriminada.
- Aceptación: doble inicio, fallo backend, ruta con espacios, salida/cierre y proceso
  ajeno en puerto. Permiso real en modo headless no se sustituye por skip-permissions.

### D21 — Aceptación integrada y documentación

- Archivos: tests E2E, `README.md`, guías de uso/operación/MCP y reporte final.
- Fixtures de base antigua, tarea con tres intentos, UI/MCP concurrentes, reinicio
  con pendientes, Profiles versionados y Kanban de cuarenta tareas por columna.
- Ejecutar typecheck, lint, tests, build y recorrido visual. Proveedores reales:
  únicamente smoke acotado expresamente asignado; separar evidencia fake/real.
- Aceptación: sin fallos críticos conocidos, guía de inicio y continuidad de tarjeta,
  permisos/errores claros y funciones pendientes declaradas. Orquestador interno
  puede quedar fuera por incompatibilidad documentada, sin bloquear MCP externo.

## 5. Invariantes que no debe romper ninguna entrega

- Sin `--dangerously-skip-permissions`, `shell: true`, credenciales visibles,
  bind externo por defecto, despliegue/push/merge o borrados amplios.
- Rutas de cliente canonicalizadas; escritor en worktree y exclusión conservados.
- Persistir antes de publicar; Zod en límites externos y TypeScript estricto.
- `saveJob`/`saveJobWithTaskMessage` devuelven el registro normalizado. El borrador
  no contiene necesariamente el `attemptIndex` definitivo.
- IDs existentes no cambian de tarea/workspace; mensajes no cambian de identidad
  por una actualización genérica; el snapshot histórico no se modifica.
- Modelo/razonamiento del orquestador son metadatos por turno, no datos inferidos
  del prompt ni heredados automáticamente de la ejecución anterior.
- Inspeccionar el estado Git actual al empezar; hay HEAD desde el checkpoint
  observado el 2026-10-09 y también cambios sin commit/archivos nuevos. La nota
  histórica de «sin commit base» ya no describe este árbol. No limpiar ni hacer
  commit global para habilitar worktrees. Usar fixtures Git aislados para tests
  y documentar el requisito de un commit base para proyectos escritores reales.

## 6. Informe, aceptación y reanudación

Cabecera obligatoria en actualizaciones y reporte final:

```text
[ORQUEST][AGENTE <A/B/C>][DXX][ESTADO: EN_PROGRESO|ENTREGADO|BLOQUEADO]
```

`ENTREGADO` significa listo para revisar, no aceptado. El orquestador registra
`ACEPTADO` o `REQUIERE_CORRECCION` con evidencia en el progreso central.

Cada reporte `docs/delegation-results/DXX.md` contiene:

1. Objetivo y resultado en tres líneas; rol y modelo/esfuerzo reales si se conocen.
2. Archivos modificados y decisión de contrato/migración, si aplica.
3. Comandos de verificación con resultado; evidencia UI separada de tests,
   siguiendo [visual-validation.md](visual-validation.md). Conservar capturas
   saneadas en `docs/evidence/<ID>/` y enlazarlas al criterio probado.
4. Riesgos, limitaciones y criterios pendientes, sin ocultar fallos.
5. Próxima entrega sugerida y checkpoint para reanudar, sin ejecutarla.

Mantener el informe breve: no pegar streams, toda la suite ni archivos enteros.
No inventar identidad de modelo. Ante falta de cuota, guardar checkpoint con
pruebas ya realizadas y pendientes; el siguiente agente retoma el mismo ID sin
repetir exploración. Si hay un error relevante, corregir dentro del mismo alcance
y volver a entregar; un bloqueo externo permite avanzar solo tareas independientes.

## 7. Prompt listo para copiar

Cambiar `D00` por el ID elegido y el rol por el indicado en la tabla. Asignar
solo cuando los prerrequisitos estén aceptados.

```text
[ORQUEST][AGENTE C][D00][ESTADO: EN_PROGRESO]

Trabaja en C:\Users\Usuario\Documents\Orquest.
Tu única asignación es D00 de docs/delegation-plan.md.

Lee AGENTS.md, el progreso actual en docs/continuation-progress.md y la ficha
D00 con sus reglas comunes/dependencias en docs/delegation-plan.md. Antes de
cambiar contratos, persistencia, procesos, MCP o permisos, lee completo
IMPLEMENTATION_PLAN.md. Inspecciona después solo los archivos necesarios.
Lee docs/handoff.md y docs/visual-validation.md para el checkpoint y el método
de evidencia en navegador. Retoma los casos V01–V08 del informe D00.

No rehagas la base P1a ni ejecutes otras entregas. Preserva cambios existentes;
si necesitas salir del alcance, proponlo antes. Usa proveedores/base/puertos
aislados y no consumas sesiones reales ni cambies autenticación. Respeta las
skills aplicables. Usa apply_patch para editar y npm.cmd en Windows.

Verifica todos los criterios de esta ficha. Para código: typecheck, lint y
tests antes de entregar; build y recorrido visual si cambias UI. No declares
una prueba no ejecutada como aprobada. No hagas commits, push, merge ni deploy.

Guarda informe breve en docs/delegation-results/D00.md con archivos, resultados,
pendientes y checkpoint. Identifícate con la cabecera en cada actualización.
Termina como ENTREGADO o BLOQUEADO, sin aprobar tu propia entrega y sin
continuar con D01. El orquestador revisará antes de asignar el siguiente paso.
```

Para corregir una entrega rechazada, reutilizar el mismo ID y añadir únicamente
los hallazgos concretos del revisor. No reenviar todo el plan o chat.
