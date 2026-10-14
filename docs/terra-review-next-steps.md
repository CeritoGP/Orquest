# Revisión de la entrega de Terra y siguientes pasos

Fecha: 2026-10-06.

Revisión histórica: sus conteos de pruebas y estado Git corresponden a su fecha.
Para retomar ahora, usar [handoff.md](handoff.md) y
[continuation-progress.md](continuation-progress.md), no sus prompts antiguos.

Continuación operativa actualizada el 2026-10-07:
[`continuation-plan.md`](continuation-plan.md). Primero cerrar la aceptación
en navegador de P0; el prompt de contratos/persistencia de este documento
corresponde a P1a, seguido de una entrega separada P1b de daemon/adaptadores/MCP.

## Dictamen

Las correcciones P0-REVIEW-FIX-01, P0-REVIEW-FIX-02 y P0-REVIEW-FIX-03 están
implementadas y pasan typecheck, lint, build y 123 pruebas en 15 archivos. Las pruebas jsdom de
ActivityPanel cubren identidad cambiante del callback, cambio de tarjeta con una
carga anterior pendiente, reconexión durante la carga inicial, recuperación de un
hueco con eventos SSE recientes y navegación limitada a diez eventos visibles de
un historial de 250, incluida la conservación de la página histórica cuando
llegan eventos nuevos. La
reconciliación REST/SSE tiene pruebas unitarias de estado.

El repositorio completo está sin seguimiento y no tiene HEAD. No hay un diff
de commits que permita atribuir cada cambio exclusivamente a Terra. La revisión
cubre el estado local que corresponde a su entrega P0.

## Lo que se conserva

- Paginación inversa en persistencia, orden cronológico en cada página y
  compatibilidad con la paginación ascendente de los clientes MCP existentes.
- Primera consulta de Activity con diez eventos recientes.
- Campo stoppedAt compatible con registros antiguos mediante un valor por defecto.
- Separación de BLOCKED y finalización irreversible; duración congelada si se
  conoce stoppedAt y dato desconocido explícito para históricos sin registro.
- Avisos vistos/pendientes en almacenamiento local y actualización al reconectar.

## Hallazgos prioritarios

### R1 — Corregido: ciclo de renderizado al abrir una tarjeta

Ubicaciones: apps/dashboard/src/app.tsx:419 y :489;
apps/dashboard/src/activity-panel.tsx:85.

App entrega una función nueva en onEventsChanged en cada render. El efecto del
panel depende de esa función y la ejecuta, aunque los eventos no hayan cambiado.
La función llama setActivityEvents con una copia nueva del array; esto vuelve a
renderizar App y crea otra función. El ciclo se repite al montar el detalle o Logs,
con consumo continuo de CPU y posibles avisos de profundidad máxima de React.

Corrección aplicada: App usa un callback estable y ActivityPanel conserva el
callback actual en una referencia. La publicación depende únicamente del cambio
del historial; por tanto, un render del padre no vuelve a publicar los mismos
eventos. La prueba de componente cambia la identidad del callback y comprueba que
no recibe una nueva publicación.

### R2 — Corregido: carga anterior bloqueada al cambiar de tarjeta

Ubicación: apps/dashboard/src/activity-panel.tsx:62 y :101.

Si se cargan eventos anteriores de A, loadingOlder pasa a true. Al seleccionar B,
ese indicador no se reinicia. Cuando responde A, su finally no lo limpia porque
currentJobIdRef ya apunta a B. B conserva loadingOlder=true y no puede cargar su
historial anterior. Volver rápidamente A -> B -> A también permite aceptar una
respuesta de la visita anterior a A, porque el control compara solo el jobId.

Corrección aplicada: cada consulta de Activity recibe una generación. Cambiar de
tarjeta invalida todas las solicitudes anteriores, limpia cursor, indicadores y
anclas; una respuesta tardía no puede mutar el trabajo nuevo. El mismo patrón
protege el diff del detalle. La prueba de componente reproduce A -> B con una
página anterior de A pendiente y confirma que B aún puede cargar su propia página.

### R3 — Corregido: snapshot antiguo puede sobrescribir SSE reciente

Ubicación: apps/dashboard/src/app.tsx:172 y :220.

refreshDashboard reemplaza todos los jobs al terminar listJobs. Si esa consulta
capturó RUNNING y llega DONE por SSE antes de su respuesta, el reemplazo restaura
RUNNING. Si no llega otro evento, la tarjeta queda mostrando un estado obsoleto.
Solicitudes de Refresh y reconexión solapadas presentan el mismo riesgo.

Corrección aplicada: las solicitudes de snapshot llevan una generación y se
descartan si una actualización más reciente comenzó después. El resultado REST se
reconcilia con los trabajos ya vistos por SSE mediante updatedAt; ante empate se
conserva el dato ya recibido. También se conservan trabajos creados por SSE que
no figuraban en el snapshot. Dos pruebas cubren ambos casos.

### Seguimiento de P0

- Una reconexión obtiene los diez eventos finales y, si aún no enlazan con el
  historial mostrado, recupera páginas inversas hasta encontrar el primer evento
  conocido. El cursor de páginas antiguas se conserva; así no queda un hueco entre
  ambos tramos ni se pierde la navegación anterior.
- Activity muestra diez eventos por página, con navegación hacia eventos
  anteriores y recientes. El historial puede crecer en memoria sin crecer el DOM.
- La página histórica conserva su ancla al recibir actividad nueva. Al regresar
  a la última página se libera el ancla y vuelve a seguir eventos en vivo, incluso
  cuando la última página no está completa.

## Orden de las próximas entregas

| Orden | Entrega | Criterio de aceptación |
|---|---|---|
| 1 | P1: sesiones, mensajes y procedencia | Una identidad estable agrupa intentos; mensajes y vínculos sobreviven reinicios; modelos solicitados/efectivos y orquestador tienen fuente identificada |
| 2 | P2 + P3: chat y Kanban compacto | Abrir chat con breadcrumb; continuar desde UI y MCP en la misma tarea; siete tarjetas por columna con navegación completa; Result es una vista previa |
| 3 | P4: Profiles editables | Crear/editar/archivar desde UI sin reiniciar; validación y versiones; ejecuciones anteriores conservan su configuración |
| 4 | P5a, después P5b: Codex integrado | Primero comprobar protocolo/login/catálogo local; luego integrar chat, delegación y continuación con metadatos por turno |
| 5 | P6: vistas y entrega | Agents, Sessions, Logs y Settings muestran datos reales; guía de uso y recorrido completo verificado |

P5a puede investigarse mientras avanza P1, sin mezclar su adaptador con cambios
de contratos aún no acordados. No estimar la integración como terminada por usar
fake workers: la autenticación y delegación reales requieren validación propia.

## Siguiente asignación para Terra

```text
[ORQUEST][TERRA][P1-CONTRACTS-PERSISTENCE-01][ESTADO: ASIGNADO]

Lee AGENTS.md, IMPLEMENTATION_PLAN.md, docs/product-evolution-plan.md y
docs/terra-review-next-steps.md. Implementa P1 de
docs/product-evolution-plan.md.

Alcance: packages/contracts, packages/persistence y sus pruebas. Coordina cualquier
cambio de contrato con el daemon, pero no edites dashboard, adaptador AGY ni MCP en
esta entrega.

Introduce taskSessionId, intentos, mensajes persistentes y los metadatos de modelo
solicitado/efectivo y orquestador definidos en el plan. Diseña una migración
aditiva y compatible con la base histórica. Entrega schemas Zod, repositorios y
pruebas de reinicio, batch, eventos repetidos y valores desconocidos.

Ejecuta typecheck, lint y test. Reporta los archivos, compatibilidad, migración,
evidencia de las pruebas y limitaciones. Identifica tu entrega con esta cabecera.
```

Esta es una asignación preparada; no se ha enviado a un agente ni se han iniciado
workers en esta revisión.
