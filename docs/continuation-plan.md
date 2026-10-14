# Orquest: guía de continuación

Fecha: 2026-10-07; checkpoint actualizado el 2026-10-13. Estado: en desarrollo;
este documento no implica que las nuevas
funciones estén implementadas ni activa agentes.

## 1. Punto de partida y resultado

El puente, daemon, persistencia y dashboard ya existen. D00, D01 y D02 están
aceptados. D00 cuenta con aceptación de navegador; tras D02 el agente ejecutó
typecheck, lint y **154 pruebas en 15 archivos**, todos exitosos. El revisor
repitió independientemente **48 pruebas de contratos/persistencia**, exit 0.
Sigue pendiente una comprobación integrada con proveedores reales. No confundir
una prueba con fake-agy con una ejecución real.

La base P1a ya incorpora identidad estable de tarea, intentos, contratos de
mensajes, persistencia y metadatos con procedencia. Falta conectar esa base al
flujo completo del daemon/adaptador/MCP (P1b), construir el chat navegable y
continuar desde la UI. Profiles todavía requiere cambios fuera de la interfaz.

Objetivo: **una tarjeta representa una tarea con historial**, no un proceso de
agente permanente. Podrá contener varios intentos y turnos, conservar sus
resultados y recibir nuevas instrucciones desde Orquest o desde un chat externo
con MCP. El orquestador integrado será una vía adicional, no una sustitución.

Jerarquía: `AGENTS.md` fija las reglas de seguridad;
[product-evolution-plan.md](product-evolution-plan.md) define el producto;
esta guía fija las entregas y su aceptación. El plan original del MVP sigue
siendo referencia técnica donde no haya sido actualizado.

Para asignar el trabajo a un modelo económico, usar
[delegation-plan.md](delegation-plan.md): entregas pequeñas, dependencias, alcance,
pruebas y prompt reutilizable. El estado real está en
[continuation-progress.md](continuation-progress.md).
Para traspasar a otro agente, empezar por [handoff.md](handoff.md); para
validación UI, seguir [visual-validation.md](visual-validation.md).

## 2. Orden de ejecución

| Orden | Entrega | Resultado comprobable |
| --- | --- | --- |
| 1 | P0 — aceptación | Actividad, reconexión y navegación sin regresiones en navegador. |
| 2 | P1a — base implementada | Tareas, intentos, mensajes y procedencia guardados; revisión verificada. |
| 3 | P1b — daemon, adaptadores y MCP | Una misma tarea se consulta y continúa con identificadores estables. |
| 4 | P2 — chat de tarea | Leer, responder, continuar y reintentar desde Orquest. |
| 5 | P3 — Kanban y navegación | Siete tarjetas por columna, historial paginado y Result compacto. |
| 6 | P4 — Profiles dinámicos | Crear, editar y archivar perfiles sin YAML manual ni reinicio. |
| 7 | P5a / P5b — orquestador | Compatibilidad demostrada, después chat de Codex integrado. |
| 8 | P6 — vistas y operación | Módulos útiles y arranque/diagnóstico fiables en Windows. |

**Primer hito de producto:** terminar P2 y P3. Ya se podrá conversar con las
tareas y navegar cómodamente sin esperar a la integración de Codex.

P5a admite una exploración breve después de P1a para descubrir incompatibilidades
temprano, sin abrir sesiones de pago ni retrasar el primer hito. P5b requiere
P2, P4 y P5a aprobadas. El orden no supone trabajo paralelo automático.

## 3. Entregas y criterios de aceptación

### P0-ACCEPTANCE-01 — cerrar la base actual

Estado: aceptado mediante D00 el 2026-10-13; véanse
[progreso](continuation-progress.md) e [informe](delegation-results/D00.md).
Los siguientes criterios se conservan como referencia de aceptación.

- Preparar un entorno fake-agy, almacenamiento y puertos de prueba separados.
  No detener ni modificar el daemon que el usuario esté utilizando.
- Recorrer en navegador una tarea con 250 eventos: últimos diez inicialmente,
  páginas anteriores/siguientes y retorno a seguimiento en vivo.
- Comprobar que eventos nuevos no desplazan una página histórica y que la vista
  reciente sigue las novedades. Mantener como máximo diez eventos visibles.
- Interrumpir/reconectar SSE, también durante la carga inicial, y verificar que
  se recuperan huecos sin duplicados ni carga infinita.
- Cambiar de tarjeta con peticiones pendientes; verificar que no aparecen datos
  del trabajo anterior. Probar errores recuperables, avisos tras F5 y duración
  congelada de BLOCKED.

Aceptación: evidencia del recorrido con resultado por caso; cualquier fallo se
corrige y prueba antes de dar P0 por cerrada. El historial recuperado en memoria
no equivale a un DOM limitado: medir crecimiento y registrar límites pendientes.

### P1a-CONTRACTS-PERSISTENCE-01 — identidad e historial

Ámbito: contratos Zod y persistencia SQLite; todavía sin rediseñar el dashboard.

- Incorporar `taskSessionId`, intentos y turnos/mensajes con identidad estable,
  orden y marcas temporales. Separar conversación del proveedor de tarea local.
- Guardar modelo/esfuerzo solicitados y efectivos, proveedor, identificador de
  sesión y procedencia de cada dato: runtime, cliente, configuración o desconocido.
- Registrar quién encargó cada turno, incluido modelo/esfuerzo del orquestador
  cuando esté disponible. Un dato declarado por un cliente no es verificación
  del runtime. No inferir identidad de Codex a partir del texto de un prompt.
- Preparar snapshots de perfiles/configuración por intento para que cambios
  futuros no reescriban el historial.
- Diseñar migraciones aditivas/versionadas y operaciones transaccionales que
  eviten tareas, mensajes o intentos parcialmente creados. No anidar las
  transacciones independientes que ya usan algunos métodos de persistencia.
- Agrupar históricos solo mediante relaciones explícitas de continuación o
  reintento. No agrupar por título, dependencia o `reviewOfJobId`; un revisor puede
  ser otra tarea. Mantener casos ambiguos como desconocidos y preservar job IDs.

Aceptación: abrir una copia de una base antigua, migrar y reiniciar sin perder
jobs/eventos/resultados; probar idempotencia, rollback y agrupación correcta.
Las pruebas de migración usan fixtures, no la base personal del usuario.

### P1b-DAEMON-MCP-01 — conectar la nueva identidad

Ámbito: daemon/core, adaptadores AGY y servidor MCP, con contratos de P1a.

- Exponer consultas paginadas de tareas, intentos y chat; resolver tanto un
  `taskSessionId` como un job ID existente sin romper clientes actuales.
- Persistir instrucciones, respuestas públicas, llamadas de herramientas y
  resultados relevantes; deduplicar deltas y mensajes finales. No solicitar ni
  mostrar razonamiento privado del modelo.
- Capturar metadatos efectivos si el protocolo los informa; mostrar desconocido
  si no lo hace. `auto` es una preferencia, no el nombre del modelo ejecutado.
- Mantener continuación y reintento como operaciones diferentes. Continuar
  reutiliza contexto del proveedor si es posible; reintentar crea otro intento.
  Si no se puede reanudar, informar y ofrecer recuperación explícita de contexto.
- Aplicar validación, autorización, idempotencia y exclusión de escritores a las
  operaciones UI/MCP por igual. Persistir antes de emitir SSE.
- Mantener asociación con workspace, permisos y worktree originales; no ampliar
  privilegios ni cambiar modelos silenciosamente al continuar.

Aceptación: crear una tarea por MCP, leer mensajes, continuarla, reiniciar el
daemon y recuperar la misma tarea con sus intentos. Probar errores y duplicados
con fake-agy; validar por separado el protocolo AGY realmente instalado.

### P2-TASK-CHAT-01 — conversación dentro de Orquest

- Añadir «Abrir chat» en tarjeta/detalle, ruta enlazable y breadcrumb
  `Kanban > Tarea > Chat`; conservar filtros, columna y página al volver.
- Mostrar mensajes paginados con Markdown seguro, herramientas plegables,
  resultados completos, tiempos y metadatos por intento/turno.
- Mostrar un destinatario inequívoco: trabajador o, cuando exista P5b,
  orquestador. Escribir aquí no significa abrir un chat de Codex Desktop.
- Incorporar «Continuar», «Reintentar» y «Cancelar», explicando su efecto.
  Mantener la tarjeta principal y permitir elegir intentos históricos.
- En tareas activas, diseñar una cola persistente de mensajes pendientes y su
  retirada. Entregar solo en un punto seguro soportado por el adaptador;
  si no existe, esperar al final del turno y no prometer interrupción inmediata.
- Hacer visibles los estados pendiente/enviado/fallido y bloquear envíos
  duplicados, incluidas carreras entre UI y MCP. Evitar escritores simultáneos.

Aceptación: una tarea finalizada se continúa desde UI y luego desde MCP, sin
borrar su resultado anterior ni crear otra tarjeta independiente. Recarga,
doble clic, cancelación, conflicto y fallo de reanudación tienen pruebas.

### P3-KANBAN-NAVIGATION-01 — tablero compacto

- Mostrar **las siete tareas más recientes por columna**, con total real y
  paginación/historial. La consulta no debe depender de los primeros 100 jobs
  globales ni ocultar tareas de columnas menos activas.
- Definir orden estable por actividad relevante e ID de desempate, sin mover
  tarjetas por cada evento técnico. No duplicar ni saltar tareas al paginar.
- Avisar de novedades fuera de la página visible sin cambiarla automáticamente.
- Sustituir Result largo por un resumen acotado y «Ver resultado en el chat»;
  el texto íntegro seguirá disponible y enlazable.
- Preservar luces de estado/novedad, fechas y duración. Revisar teclado,
  accesibilidad, responsive y contraste de tarjeta seleccionada.

Aceptación: fixture con al menos 40 tareas en cada columna; navegar todo el
historial y abrir/enlazar/volver al chat manteniendo la ubicación del usuario.

### P4-DYNAMIC-PROFILES-01 — configuración editable

- CRUD persistente de perfiles con validación Zod, versiones, control de edición
  concurrente y archivado. Mostrar errores accionables, no guardar parcialmente.
- Importar YAML inicial de forma idempotente; después editar desde Orquest sin
  reinicio. Separar perfiles, configuración operativa y secretos.
- Ofrecer catálogos/capacidades reales por proveedor; distinguir configuración
  guardada de disponibilidad comprobada. Rechazar combinaciones no soportadas.
- Aplicar cambios a intentos futuros; los activos/históricos conservan snapshot.
- Mostrar acceso y permisos claramente; modificar un perfil no concede por sí
  solo acceso a cualquier directorio o comandos elevados.

Aceptación: crear/editar/archivar desde UI, reiniciar y conservar cambios;
dos editores reciben conflicto explícito, y un intento antiguo conserva su modelo
y permisos. No queda una instrucción obligatoria de editar YAML a mano.

### P5a-CODEX-COMPATIBILITY-01 — prueba antes de integrar

La documentación oficial describe `codex app-server` con transporte stdio,
inicialización, turnos, eventos y autenticación ChatGPT administrada por Codex.
Es el candidato para un cliente local; no es una prueba de compatibilidad de
nuestra instalación o cuenta. Fuente: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

- Comprobar versión instalada, esquema/protocolo, inicialización, cuenta,
  catálogo, capacidades de reanudación, aprobaciones y conexión MCP de Orquest.
- Preferir login administrado por Codex si está soportado. No copiar cookies,
  extraer tokens del escritorio ni guardar credenciales en SQLite/logs de Orquest.
- No introducir una API de pago como fallback silencioso. Mostrar el estado de
  cuenta/cuota y pedir intervención del usuario si el login la necesita.
- Implementar un adaptador falso para turnos/eventos/aprobaciones/cancelación,
  antes de consumir cuota. Documentar incompatibilidades sin simular éxito.
- Cerrar con una prueba real mínima, acotada y visible del flujo de cuenta elegido.

Aceptación: informe de capacidad real y prueba repetible. Si no es viable, el
producto continúa usando el orquestador externo por MCP; P5b queda pendiente.

### P5b-EMBEDDED-ORCHESTRATOR-01 — vía adicional de entrada

- Añadir un chat del orquestador con sesiones propias, modelos/esfuerzos
  soportados, streaming, cancelación, errores y aprobaciones visibles.
- Conectar sus herramientas a los mismos contratos/servicios MCP y tareas.
  Guardar procedencia del orquestador por turno y vincular trabajos delegados.
- No prometer importar automáticamente este chat externo; ofrecer traspaso
  explícito de contexto/resumen y conservar su procedencia.
- Operar localmente, supervisar el proceso hijo y recuperarse de su caída sin
  cancelar ni duplicar a ciegas los trabajos ya registrados.

Aceptación: el usuario pide una tarea dentro de Orquest; el orquestador delega
dos trabajos de prueba, observa resultados y continúa uno. Mismo historial
consultable desde MCP externo; luego una prueba real de alcance reducido.

### P6-OPERATIONS-VIEWS-01 — terminar la experiencia

- Agents: ejecuciones activas/capacidades y enlaces; no inventar subagentes si
  el proveedor no los reporta. Sessions: tareas y conversaciones navegables.
- Logs: filtros y paginación. Changes/Tests: evidencia y estados reales;
  «sin datos» no equivale a «sin cambios» ni «pruebas aprobadas».
- Settings: conexión, runner, raíces autorizadas, concurrencia y diagnóstico;
  sin presentar secretos ni privilegios ilimitados como configuración normal.
- Revisar `.bat`, URL impresa, puertos ocupados, health y apagado de procesos
  propios. No terminar procesos ajenos para liberar un puerto.
- Completar guía de primera instalación, uso desde UI/MCP, recuperación y límites.
  No publicar módulos decorativos como si fueran operativos.

Aceptación: arranque por doble clic, diagnóstico comprensible, reinicio conserva
datos y recorrido completo por las vistas. Los escritores con Git worktree
requieren un commit base: revisar/autorizar ese checkpoint, no crearlo a ciegas.

## 4. Método de trabajo y seguridad

Una entrega a la vez: revisar el estado actual, implementar, verificar y registrar
evidencia antes de avanzar. No volver a implementar algo que ya pase aceptación.
Ante una continuación, retomar la primera entrega incompleta de esta guía.

Para cada entrega de código:

```text
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
```

Además, build para dashboard y recorrido de navegador para flujos UI; fixtures
antiguos para persistencia, pruebas de contratos para MCP y Windows para procesos.
Separar resultados automáticos, manuales y reales; no afirmar que uno sustituye
a los otros. La entrega exclusivamente documental no necesita repetirlos.

Registrar en `docs/continuation-progress.md` al empezar ejecución: ID de entrega,
estado, archivos, comandos/resultados, evidencia, pendientes y siguiente paso.
No crear una lista de avances ficticios. Un fallo de gate se resuelve en la misma
entrega; una incompatibilidad externa se documenta y se avanza lo independiente.

No cambiar las reglas de AGENTS: loopback, credenciales redactadas, rutas
canonicalizadas, sin shell interpolado ni salto de permisos. Las migraciones
internas de formato SQLite se diseñan/probarán con respaldo; no habilitan
migraciones de proyectos del usuario, despliegues, push o merge automáticos.

Si se autoriza delegación posteriormente: A contratos/persistencia; B
daemon/adaptadores/MCP; C dashboard. Cada prompt llevará identificador de agente
y entrega, archivos permitidos y gate. No editarán simultáneamente contratos
compartidos. El orquestador revisa y acepta; esta guía no los pone a trabajar.

## 5. Criterio de proyecto funcional

1. Una tarea tiene chat, tres intentos conservados y continuación UI/MCP sin
   duplicados; reiniciar no pierde historial ni mensajes pendientes.
2. Kanban muestra siete por columna y permite recuperar todas las anteriores;
   Result abre el chat sin crecimiento lateral ilimitado.
3. Modelos/esfuerzos y orquestador se muestran con procedencia honesta; lo no
   reportado aparece desconocido. Profiles se cambia desde la aplicación.
4. Orquestador interno funciona solo si P5a lo demuestra; el externo por MCP
   sigue funcionando en cualquier caso.
5. Arranque/diagnóstico Windows, permisos y vistas principales se prueban con
   evidencia. No quedan fallos críticos conocidos ni éxito simulado.

**Siguiente acción al ejecutar:** D00/P0, D01 y D02 aceptados; iniciar D03 para
persistir mensajes y metadatos públicos según [el contrato](continuity-contract.md).
No rehacer P1a ni
empezar por el chat del orquestador integrado. La guía de delegación desglosa
estos pasos como D00–D05.
