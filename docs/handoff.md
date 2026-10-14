# Handoff de desarrollo — Orquest

Actualizado: 2026-10-14. Este documento permite retomar sin el historial del chat.
Checkpoint actual: D00/D01/D02 aceptados; D03 requiere corrección según su informe. No iniciar D04.
Este documento no inicia agentes ni sesiones reales.

## 1. Lectura y autoridad

1. Leer completo [AGENTS.md](../AGENTS.md).
2. Leer [continuation-progress.md](continuation-progress.md), este handoff y
   [visual-validation.md](visual-validation.md).
3. Leer reglas comunes, dependencias y la ficha asignada en
   [delegation-plan.md](delegation-plan.md). D00 ya fue aceptado: consultar
   [su informe](delegation-results/D00.md) como evidencia, no repetirlo.
4. Leer completo [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) antes de
   tocar contratos, persistencia, procesos, MCP o seguridad.
5. Inspeccionar solamente código/tests necesarios; usar las skills aplicables
   del entorno del agente, leyéndolas antes de actuar.

Mapa documental: [índice](README.md). El progreso central registra el estado;
las fichas fijan alcance/aceptación, los informes guardan evidencia y los planes
de producto describen objetivos. Ninguna hoja de ruta demuestra que una función
esté implementada. Ante contradicción, preservar las reglas de seguridad,
inspeccionar código/evidencia y documentar la resolución antes de ampliar alcance.

## 2. Estado comprobado

- Puente MCP, daemon loopback autenticado, SQLite, runner AGY/fake y dashboard
  existentes. Hay continuación/reintento por job en backend/MCP; no equivalen
  todavía a un chat navegable de tarea en la UI.
- P1a: contratos/persistencia de `taskSessionId`, `attemptIndex`, mensajes,
  procedencia de modelos/orquestador y snapshots. Reutilizar, no reconstruir.
  Falta completar integración daemon/adaptador/MCP y exposición en la interfaz.
- D01: contrato de continuidad aceptado el 2026-10-13. Retry por tarea, contexto
  por turno, identidad de proveedor, cursores y enlace de despacho definidos en
  [continuity-contract.md](continuity-contract.md); conservar API/payloads legacy.
  Revisión independiente: 38 tests de contratos/persistencia, exit 0. El agente
  reporta typecheck/lint y 144 tests completos exitosos. D02 también aceptado.
- D02: lecturas paginadas, reservas por tarea, despacho único y escrituras
  atómicas aceptados el 2026-10-13. Submit inicial conserva la clave legacy
  opcional; las mutaciones por tarea no contaminan ese índice ni sobrescriben
  intentos existentes. Revisión final: 48 tests contratos/persistencia, exit 0;
  agente: typecheck/lint y 154 tests completos, exit 0. Véase [D02](delegation-results/D02.md).
- P0: paginación de Activity, recuperación REST/SSE, novedad y tiempos con tests.
  **D00 ACEPTADO el 2026-10-13 con evidencia acumulada V01–V08.**
  V02 corregido; V03 recupera el hueco con productor activo y V04 incluye carga
  pendiente sustituida por reconexión, sin cambiar selección ni pulsar Reintentar.
  El revisor ejecutó ese último recorrido en el navegador integrado y repitió
  los gates completos. Proxies SSE corregidos; ESLint excluye artefactos
  `.orquest/**`. Fixture, Vite y pestañas propios cerrados; puertos de aceptación
  y 9222 sin listeners comprobados.
  Consultar el progreso y la matriz D00 antes de repetir casos.
- DASHBOARD-SCROLL-01: scroll nativo separado para tablero, navegación, detalle
  y Result; resultado largo acotado y acceso por teclado. Verificado en Chrome
  y con límites responsive; [informe y captura](delegation-results/DASHBOARD-SCROLL-01.md).
- Última batería completa repetida por el revisor para D00, 2026-10-13: typecheck, lint
  y build dashboard con exit 0; `npm.cmd test`: **137 pruebas / 15 archivos,
  exit 0**. Son pruebas locales/fake,
  no una certificación de ejecución real con Antigravity.

El bloqueo del navegador integrado observado el 2026-10-07 es histórico.
Chrome conectado cargó el fixture el 2026-10-09; comprobar herramientas actuales,
no asumir que continúan disponibles ni que todos los navegadores están bloqueados.
La prueba de scroll **no acepta** los ocho casos de D00.

Pendientes de producto: chat por tarea/continuidad UI y MCP por identidad estable,
siete tarjetas por columna con paginación, resultados completos en chat con
breadcrumb, modelos/orquestador con procedencia, Profiles editables, vistas
operativas y posible orquestador interno. El último requiere D15 antes de D16/D17;
no asumir compatibilidad, login ni cobertura de API por una suscripción.

## 3. Workspace y código que no debe perderse

Ruta actual: `C:\Users\Usuario\Documents\Orquest_Github`.
HEAD observado el 2026-10-09: `14f0d5eb105c6b1369cf8ad43f12c369a91f33bd`.
Es un checkpoint observado, **no** una orden de checkout/reset. Hay cambios sin
commit y archivos nuevos; volver a ejecutar `git status --short` al empezar.

Cambios existentes al preparar el traspaso:

- Dashboard: `src/app.tsx`, `src/styles.css`, `vite.acceptance.config.ts` y la
  carpeta nueva `apps/dashboard/fixtures/`.
- Documentación: planes, progreso y `docs/delegation-results/D00.md`, además de
  los documentos de este traspaso.
- `Nueva carpeta/` no pertenece a la asignación: no modificar ni borrar.

No limpiar el árbol, hacer un commit global ni atribuir todos los diffs al nuevo
agente. No arrancar otra implementación en paralelo sobre archivos compartidos.

| Área | Entrada de código |
| --- | --- |
| UI / scroll | `apps/dashboard/src/app.tsx`, `styles.css` |
| Actividad / reconciliación | `apps/dashboard/src/activity-panel.tsx`, `dashboard-state.ts` y tests |
| Cliente HTTP | `apps/dashboard/src/api.ts` |
| Contratos / SQLite | `packages/contracts/src/index.ts`, `packages/persistence/src/index.ts` y tests |
| Backend / MCP / worker | `apps/daemon/src/`, `packages/mcp-server/src/`, `packages/agy-adapter/src/` |
| Entorno visual aislado | `apps/dashboard/fixtures/d00-acceptance.ts`, `vite.acceptance.config.ts` |

## 4. Próxima asignación y secuencia

**Primero: agente B, D03.** Persistir instrucciones y respuestas públicas del
worker, reconciliar deltas/finales y registrar solo metadatos reportados.
Usar las operaciones aceptadas D02; para submit inicial, guardar job, mensaje
y evento antes de publicar. Excluir razonamiento privado y redactar secretos
antes de persistir o publicar. Fake determinista y SQLite privado; no tocar
base personal ni ejecutar proveedores reales. Sin UI, endpoints nuevos ni
herramientas MCP nuevas. No rehacer P1a ni reabrir D00/D01/D02.

Secuencia después de D00 aceptado:

1. D01–D05: inventario/contratos, operaciones persistentes, mensajes/metadatos,
   HTTP y MCP por tarea estable.
2. D06–D07 y D10–D11: chat navegable/continuación y Kanban de siete por columna.
   Este es el primer hito utilizable pedido por el usuario.
3. D08–D09: cola persistente de instrucciones durante ejecución.
4. D12–D14: Profiles versionados y editor.
5. D15: compatibilidad oficial vigente; D16–D17 solo si es viable y se asignan.
6. D18–D21: vistas, operación Windows y aceptación integrada.

Roles A=contratos/datos, B=backend/adaptadores/MCP, C=dashboard. Un agente puede
asumirlos sucesivamente. Una entrega por vez; las dependencias requieren revisión
aceptada, no solo informe recibido. No lanzar agentes ni sesiones reales por el
simple hecho de leer esta guía.

## 5. Verificación, evidencia y límites

Código: `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`.
UI: además `npm.cmd run build --workspace=@orquest/dashboard` y recorrido visual
con [la metodología de capturas](visual-validation.md). Registrar exit codes,
versiones/fecha relevantes y cualquier intento fallido; no aumentar timeouts ni
ocultar fallos para declarar éxito. Para cambios solo documentales, comprobar
enlaces/consistencia y `git diff --check`, sin repetir toda la suite.

Usar base/puertos fake aislados 4417/4418; no detener los servicios personales
4317/4318, cambiar autenticación ni consumir cuota real. Cada arranque del fixture
crea otra carpeta y actualiza el manifest: reiniciar Vite para leer su nuevo token.
No imprimir secretos. Si hay conflicto de puerto, informar; no matar por nombre
o puerto. Cerrar únicamente procesos/pestañas propios y registrar el cierre.

Reglas críticas: sin salto de permisos, `shell: true`, bind externo, tokens en
logs/reportes/capturas, push/merge/deploy ni borrados amplios. Rutas de cliente
canonicalizadas; persistir antes de SSE. Mantener requested/effective/unknown y
no inventar modelo, razonamiento, agentes ni identidad del orquestador.

## 6. Prompt listo para traspasar

```text
[ORQUEST][AGENTE B][D03][ESTADO: EN_PROGRESO]

Trabaja en C:\Users\Usuario\Documents\Orquest_Github.
Lee AGENTS.md, docs/handoff.md, docs/continuation-progress.md,
IMPLEMENTATION_PLAN.md completo, docs/continuity-contract.md y las reglas/ficha
D03 de docs/delegation-plan.md. D00/D01/D02 están aceptados; no los repitas.

Tu única asignación es D03: conversación y metadatos públicos del worker.
Preserva el árbol sucio y el ajuste DASHBOARD-SCROLL-01. No rehagas P1a.
No uses la instancia personal,
Antigravity real ni sesiones Codex reales. Usa las skills aplicables.

Trabaja en packages/agy-adapter, packages/fake-agy e integración mínima del
daemon y sus tests. Persiste instrucciones y respuestas públicas, reconcilia
deltas/finales repetidos con identidad estable y registra efectivo solo cuando
el protocolo lo informa; en otro caso, desconocido. Usa la escritura inicial
atómica D02 y sus registros normalizados. Redacta secretos antes de guardar o
publicar y excluye razonamiento privado. No abras endpoints/tools de D04/D05,
UI ni cola D08. Si falta una capacidad en contratos/persistencia, informa al
orquestador antes de ampliar el alcance aceptado.

Prueba streams fragmentados/repetidos, final sin resumen, cancelación,
identidad desconocida y secretos, usando fake determinista. Ejecuta
typecheck, lint y tests; entrega informe docs/delegation-results/D03.md con
inventario, contratos, decisiones, resultados y checkpoint. Registra
ENTREGADO o BLOQUEADO según corresponda y detente, sin aceptar tu propia
entrega ni iniciar D04. El orquestador revisará antes del siguiente paso.
```

## 7. Qué dejar en cada relevo

Informe por ID con objetivo, archivos propios, pruebas y capturas, fallos/
limitaciones, casos pendientes, procesos aún abiertos y siguiente acción exacta.
Actualizar progreso central y este resumen si cambió el checkpoint. Nunca usar
un screenshot de una versión anterior como validación de cambios posteriores.
