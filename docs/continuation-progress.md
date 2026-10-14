# Registro de continuación

## D03 — Entrega externa recuperada — 2026-10-14

Estado: **REQUIERE_CORRECCION por revisión del orquestador**. Se trasladaron los
seis archivos a `C:\Users\Usuario\Documents\Orquest_Github`, el repositorio
indicado por el usuario, sin commit/push y preservando cambios ajenos.
Dependencias locales restauradas desde lockfile tras fallo del intento offline.
Verificación final aquí: lint exit 0; typecheck exit 1 (identidad nullable);
162 tests pasaron y uno falló por exposición de secretos, con EPERM adicional
al limpiar su fixture. Hay además truncado a 20k y pérdida de deltas idénticos.
Informe y siguiente acción: [D03](delegation-results/D03.md).
Corregir D03 y revisarlo antes de asignar D04. D00/D01/D02 permanecen aceptados.


## D02 — Persistencia y lectura por tarea — 2026-10-13

Estado: **ACEPTADO por el orquestador, 2026-10-13**. Se añadieron
migraciones SQLite internas para reserva de idempotencia por tarea y despacho
único mensaje→intento, lecturas paginadas ligadas a sesión/dirección y escritura
atómica de job, mensaje y evento. Se preservan payloads, índices históricos y
lookup legacy de jobs. No se modificaron daemon, MCP, adaptadores ni UI.
La corrección de revisión exige que la ruta de mutación nueva use un ID de
intento inexistente antes de cualquier escritura; conserva el replay ya
reservado y el lookup legacy. La regresión cubre el rechazo y la reutilización
de la clave con un draft nuevo. La ruta aditiva
`saveInitialJobWithTaskMessageAndEvent` conserva submit legacy opcional por
workspace y confirma el job inicial, su mensaje y evento antes de publicación;
D03 la usará para submit inicial y D04 conserva `saveTaskMutation` para
mutaciones por tarea. Verificación final tras la adición: focalizado 28/28,
typecheck/lint y suite completa 154/154, todos exit 0. Detalles y pruebas:
[D02](delegation-results/D02.md).
Revisión independiente final: **48 pruebas de contratos/persistencia, exit 0**.
El revisor reprodujo antes y después el intento de sobrescribir un job READY:
ahora se rechaza y conserva registro, lookup legacy y ausencia de mensajes.
Las pruebas de dos conexiones son secuenciales; D04 cubrirá carreras de clientes.
Siguiente asignación: D03 al mismo subagente Terra/high, rol B, sin UI ni nuevos
endpoints/tools. La aceptación de D03 debe preceder a D04.

## D01 — Contrato de continuidad — 2026-10-13

Estado: **ACEPTADO por el orquestador, 2026-10-13**. Se añadieron
contratos compatibles para identidad de proveedor, destinatario/intención de
mensaje, enlace futuro mensaje→intento, contexto de orquestador por turno,
retry por tarea y cursores ligados a tarea/dirección. La política rechaza tareas
activas hasta D08 y no permite simular un destinatario orquestador sin adaptador.
No se modificaron SQLite, daemon, MCP, adaptadores ni UI. Detalles y resultados
de verificación: [D01](delegation-results/D01.md) y
[especificación](continuity-contract.md). La revisión corrigió el input de retry
por tarea (clave obligatoria y selector/contexto), la política para tarea activa,
destino orquestador no disponible, scope de idempotencia tarea+clave sin replay
cruzado, cursores por tarea/dirección y unicidad del despacho. El revisor repitió
contratos y persistencia: **38 tests / 2 archivos, exit 0**. Typecheck/lint y
suite completa de **144 tests / 15 archivos, exit 0**, reportados por el agente.
Siguiente asignación: D02 al agente A con Terra/high; implementación y revisión
secuenciales, sin integrar todavía daemon/MCP/UI.

## P0-ACCEPTANCE-01

### Aceptación D00 — 2026-10-13

Estado: **ACEPTADO por el orquestador**. V01–V08 cuentan con los recorridos y
evidencia acumulados en [D00](delegation-results/D00.md). V03 ahora mantiene
el productor activo durante el corte downstream y muestra recuperación LIVE
048–057; se reportan 57 LIVE históricos sin huecos ni duplicados. El revisor
inspeccionó el fixture, las nuevas capturas y la evidencia.

Para completar la condición original de V04, el revisor ejecutó un recorrido
adicional en el navegador integrado (Chrome conectado no estaba disponible):
la primera carga REST quedó retenida, se cortó solo SSE a los ocho segundos y
la reconexión sustituyó la petición pendiente en la misma tarjeta. Se observó
Cargando actividad → Recuperando eventos perdidos → HIST-241–250, diez filas,
LIVE y sin Reintentar/cambio de vista. La respuesta original tardía no dejó el
loader ni sustituyó la selección. Fixture reproducible:
`apps/dashboard/fixtures/d00-pending-load.config.ts`; usa el daemon/base fake
4417/4418 y demora la primera petición de eventos durante 30 s.
[Captura](evidence/D00/2026-10-13-v04-auto-recovered-review.png) y
[observaciones](evidence/D00/2026-10-09-browser-observations.md).

El primer lint de revisión falló: ESLint analizaba código de extensiones del
perfil temporal `.orquest/d00-chrome-cdp/` (10.919 errores). Se añadió únicamente
`.orquest/**` a los ignores de ESLint, conforme al directorio de artefactos ya
ignorado por Git; no se borró el perfil ni se cambiaron reglas para el código.
Gates del revisor: typecheck/lint exit 0; suite completa **137 tests / 15 archivos,
exit 0**; build dashboard exit 0, 32 módulos; typecheck/lint repetidos al conservar
el fixture de revisión en su ruta portable, exit 0.

Pestaña y dos procesos propios cerrados; 4417/4418/9222 sin listeners comprobados.
Sin proveedores reales ni cambios de autenticación. Las capturas/manuales
anteriores y revisiones rechazadas se conservan como históricas, incluidas sus
limitaciones. D00 acepta P0 con fake, no ejecución real de Antigravity.
**Siguiente asignación: agente A, D01**, inventario y contrato de continuidad;
no rehacer P1a ni iniciar D02 antes de aceptar D01. Las secciones siguientes
son checkpoints históricos, sustituidos por esta aceptación.

### Revisión D00 — entrega de red, 2026-10-13

Estado de revisión: **REQUIERE_CORRECCION de evidencia**, sin fallo nuevo de
código demostrado. Se inspeccionaron los cambios SSE de ambos proxies Vite,
el fixture, informe y siete capturas nuevas. El revisor repitió las regresiones
de API/ActivityPanel: **20 tests / 2 archivos, exit 0**. Typecheck, lint, suite
completa de 137 tests y build son resultados reportados por el implementador,
no repetidos por el revisor. Los servicios se reportan cerrados; no se arrancaron
recursos de prueba en esta revisión.

V03 confirma desconexión visible y vuelta a LIVE. Sin embargo, la captura
RECONNECTING ya muestra LIVE-044; tras reiniciar el daemon, el mismo trabajo
queda FAILED por recuperación de trabajo huérfano. Consultar los 44 LIVE
persistidos no prueba que ActivityPanel recupere eventos generados durante
el corte. Pendiente: interrumpir únicamente el transporte del navegador/proxy
aislado, manteniendo activo el productor, demostrar secuencias nuevas durante
el intervalo y recorrer en UI el hueco recuperado sin duplicados. El test nuevo
EventSource cubre callbacks; no reproduce por sí solo el defecto del proxy.

V04 demuestra error inicial recuperable, pero se seleccionó estando Offline
y luego se recargó la actividad al seleccionar/abrir Logs. Falta el escenario
de una petición inicial pendiente invalidada por reconexión sin cambiar de
tarjeta ni remontar el panel. Mantener el loader visible antes del corte,
reconectar en la misma selección y comprobar recuperación; si la petición vieja
responde tarde, no debe sobrescribir el resultado nuevo.

V01/V02/V06/V08 conservan su evidencia previa; V05 y V07 se revisaron sobre el
recorrido reportado y capturas. No repetir el conjunto completo. Reabrir solo
los dos escenarios pendientes, usando herramientas autorizadas y preservando
las capturas anteriores como evidencia parcial/histórica. No iniciar D01.

### Revisión D00 — fallo manual V03 y siguiente recorrido, 2026-10-09

D00 **REQUIERE_CORRECCION** por V03: el usuario reportó solicitudes `stream`
fallidas durante Offline mientras el encabezado permanecía LIVE. Se revisaron
el informe y las dos capturas conservadas en `docs/evidence/D00/`. La causa no
está demostrada: `api.ts` ya notifica desconexión en `EventSource.onerror` y
`app.tsx` ya renderiza RECONNECTING cuando `connected` es falso. No prescribir
añadir un handler que ya existe; investigar el flujo efectivo y la versión
servida. La captura del indicador incluye un borde de ventana personal: repetir
la evidencia con solo el fixture visible antes de usarla como captura saneada.

Orden de continuación: completar manualmente **V04 → V05 → V07** con los
servicios de aceptación que el implementador mantiene activos; registrar cada
resultado sin modificar código durante el recorrido. Restaurar conexión normal
y quitar los bloqueos al terminar; cerrar solo recursos propios. Después,
corregir V03 y cualquier fallo adicional dentro de D00, con regresiones, gates
del repositorio/build y revalidación visual de los casos afectados. V03 no se
repite para redescubrir el fallo; sí requiere validación posterior al cambio,
incluida recuperación de eventos sin huecos ni duplicados.

V01/V02/V06/V08 conservan su evidencia aprobada/parcial anterior. No iniciar D01
hasta aceptación completa. Este registro no ejecutó pruebas ni alteró servicios.

### Revisión D00 — cierre visual V02, 2026-10-09

V02 **ACEPTADO** como criterio parcial, revisando el fixture y la evidencia
aportada: `D00:controlled` produce 12 LIVE a intervalos de 500 ms, pausa 30 s
y produce otros 12. El cambio está limitado al fixture de aceptación.
La evidencia nueva documenta apertura histórica, retorno a recientes y seguimiento
posterior hasta LIVE-024/finalización con diez filas; complementa la observación
anterior de estabilidad mientras llegaban eventos. No se repitió el recorrido
por el revisor ni la suite completa: el implementador reporta typecheck, lint,
136 tests y build, exit 0. El informe ahora confirma el cierre de sus recursos.

D00 sigue **pendiente de aceptación completa**: V01/V02/V06/V08 pasaron según
la evidencia documentada; V03/V04/V05/V07 requieren un recorrido con controles
de red autorizados. La limitación de capturas portables permanece declarada.
Siguiente acción: ejecutar los cuatro pasos manuales del
[informe D00](delegation-results/D00.md), registrar resultados y conservar
capturas saneadas cuando sea posible. No reenviar V02 al mismo agente ni iniciar
D01. Las revisiones siguientes son checkpoints anteriores conservados.

### Revisión D00 — corrección V02, 2026-10-09

Resultado de revisión: corrección de código **ACEPTADA**; D00 completo sigue
pendiente de aceptación. El cambio fija el ancla antes de esperar la página
REST y desactiva el seguimiento al fondo. La regresión añadida mantiene la
petición pendiente mientras llegan eventos LIVE, condición ausente en el test
anterior. El revisor inspeccionó el diff y repitió ActivityPanel: **12/12 tests,
exit 0**. El primer intento falló al iniciar esbuild con `spawn EPERM`; el mismo
comando fuera del sandbox autorizado pasó. No se repitió la suite completa:
el implementador reporta typecheck, lint, 136 tests/15 archivos y build, exit 0.

Estado visual reportado: V01 y V08 revalidados; V06 conserva evidencia histórica;
V02 confirma estabilidad de la página, pero falta observar en navegador el
retorno al presente y la llegada del siguiente LIVE. V03, V04, V05 y V07 siguen
pendientes por ausencia de controles de red en la herramienta utilizada.
No hay capturas portables de esta reanudación; las mediciones no las sustituyen.
Detalles: [informe D00](delegation-results/D00.md) y
[observaciones](evidence/D00/2026-10-09-browser-observations.md).

Siguiente acción: completar el retorno activo V02 con un fixture fake de ritmo
controlado, sin cambiar producción, y ejecutar los cuatro casos de red mediante
controles autorizados o un recorrido manual documentado. Confirmar el cierre
de recursos en el informe, cuya sección final todavía usa futuro. No iniciar D01.
Los párrafos siguientes conservan el checkpoint histórico anterior a esta revisión.

Estado actualizado el 2026-10-09: D00 pendiente de aceptación visual completa;
handoff reproducible completado el 2026-10-07. El bloqueo de navegador de esa
fecha no es un bloqueo actual comprobado: Chrome cargó el fixture para validar
DASHBOARD-SCROLL-01, sin completar V01–V08.

La cobertura automatizada de ActivityPanel confirma paginación, recuperación
REST/SSE, cambio de tarjeta y seguimiento en vivo. La suite completa repetida a
las 16:16:17 locales del 2026-10-07 terminó con exit 0: **135 pruebas en 15 archivos**,
incluidas 11 de ActivityPanel. El intento anterior tuvo un timeout de worktree
(134 aprobadas y una fallida); el reporte conserva ambos resultados.

Se añadió un fixture aislado reproducible y se corrigió la raíz de Vite de
aceptación. Por HTTP se verificaron dashboard 200, 250 eventos distintos en 25
páginas, BLOCKED con duración de 42 segundos y nuevo trabajo sintético DONE.
Falta observar V01–V08 en navegador: el intento anterior de abrir la URL de
aceptación con el navegador integrado devolvió ERR_BLOCKED_BY_CLIENT. No se
usó la instancia personal ni Antigravity real. Procesos de prueba cerrados.
Evidencia, comandos de arranque, cierre y checkpoint:
[`delegation-results/D00.md`](delegation-results/D00.md).

## P1a-CONTRACTS-PERSISTENCE-01

Estado: base implementada; correcciones de revisión verificadas el 2026-10-07.
La integración del historial con daemon/MCP sigue en P1b y el recorrido visual
de P0 continúa pendiente.

Cambios:

- `taskSessionId` y `attemptIndex` en trabajos; trabajos nuevos generan sesión y
  continuaciones/reintentos conservan la sesión raíz. SQLite asigna el número
  definitivo dentro de `BEGIN IMMEDIATE`, con índice único por tarea/intento.
  Los constructores de core generan borradores: los clientes deben usar el
  registro devuelto por `saveJob` o `saveJobWithTaskMessage`. El daemon ya lo hace.
- Metadatos explícitos de modelo/esfuerzo solicitados y efectivos, fuente de
  metadatos, orquestador y snapshot de perfil. Los valores no reportados quedan
  como `unknown`/`null`.
- Contratos Zod para mensajes de tarea y paginación.
- Migración SQLite que añade e indexa sesión/intento, recupera sesiones mediante
  relaciones explícitas parent/retry y conserva trabajos históricos.
- Tablas `task_sessions` y `task_messages`; persistencia paginada de mensajes y
  operación atómica para crear un job junto con su primer mensaje.

Evidencia:

```text
npm.cmd run typecheck  -> OK
npm.cmd run lint       -> OK
npm.cmd test           -> OK (15 archivos, 135 pruebas)
```

Pruebas añadidas: conservación de sesión/índice en core, consulta por sesión,
migración de base antigua, escritura atómica job+mensaje y paginación cronológica
de mensajes.

Correcciones tras revisión:

- Los mensajes validan pertenencia del job a su tarea, y un ID existente no
  puede cambiar sesión, job, rol, fuente ni fecha de creación. El contenido,
  estado de entrega y fecha de actualización siguen siendo editables.
- La migración 7 repara números duplicados de versiones anteriores, mantiene
  los índices que ya eran únicos y persiste la identidad en el payload. La
  actualización de esquema se ejecuta en una transacción; no modifica la base
  personal del usuario durante estas verificaciones.
- Los intentos nuevos no heredan la identidad del orquestador del turno anterior.
  Su snapshot independiente refleja modelo, esfuerzo y comandos de verificación
  del nuevo intento, manteniendo el registro original intacto.
- Se prueba un rollback real: una colisión de mensaje falla después de insertar
  job, sesión y dependencias, y todos esos cambios se revierten.
- Se verifican reintentos del mismo original desde dos conexiones SQLite,
  estabilidad al actualizar/reiniciar, migración de cadenas históricas sin unir
  revisores/dependencias, conservación de mensajes/resultados y números que
  devuelve la API HTTP (incluido replay idempotente).

## Después de aceptar D00: P1b-DAEMON-MCP-01

Conectar estos contratos al daemon, adaptador y MCP: persistir la instrucción
inicial y respuestas públicas, exponer consultas paginadas de tarea/intentos/chat,
informar metadatos runtime solo cuando el adaptador los entregue y reutilizar la
operación atómica al continuar. No rediseñar aún la UI; eso corresponde a P2.

## Preparación de delegación — 2026-10-07

Estado inicial: documentación preparada. Actualización: D00 ejecutado parcialmente,
fixture y handoff entregados; aceptación visual pendiente. D01–D21 no iniciados.
El [plan de delegación](delegation-plan.md) divide la continuación en D00–D21,
con roles, archivos, dependencias, aceptación e informes por entrega. La siguiente
acción concreta es reanudar D00 con su fixture y ejecutar V01–V08. Una vez
aceptado, D01–D05 integran la base existente sin rehacer P1a. El primer hito de
uso es D07 + D11 (chat/continuidad y Kanban acotado). La última batería completa
confirmada pasó 135 pruebas; el historial del timeout se conserva en D00.

## DASHBOARD-SCROLL-01 — 2026-10-09

Implementado y verificado: scroll propio de detalle/Result, layout acotado y
teclado; sin cambios de contratos/daemon/MCP. Typecheck, lint y build: exit 0;
suite completa: 135 pruebas en 15 archivos, exit 0. Chrome y límites responsive
comprobados con fixture aislado. Procesos/pestaña propios cerrados.

Evidencia, métricas, limitaciones y captura portable:
[DASHBOARD-SCROLL-01.md](delegation-results/DASHBOARD-SCROLL-01.md).
Solo acepta el ajuste de scroll; V01–V08 y D01–D21 siguen pendientes.

## Traspaso documental — 2026-10-09

Preparados [índice](README.md), [handoff](handoff.md) y
[método de validación visual](visual-validation.md). Captura sintética conservada
en `docs/evidence/DASHBOARD-SCROLL-01/`, sin depender de archivos ignorados/Temp.
AGENTS y planes enlazan estas guías; informes anteriores se identifican como
históricos. Corregidas referencias desactualizadas a falta de HEAD y bloqueo
actual del navegador; se conserva evidencia de fallos anteriores.

Esta entrega es solo documental: no se repitieron tests ni pruebas visuales y
no se iniciaron agentes/servicios. Próxima asignación: agente C completa D00
V01–V08 y entrega evidencia para revisión; no empezar D01 sin aceptación.
Verificación documental: 71 enlaces locales válidos en 13 documentos (excluidos
ejemplos de plantilla), captura copiada con hash idéntico al original y
`git diff --check` sin errores.
