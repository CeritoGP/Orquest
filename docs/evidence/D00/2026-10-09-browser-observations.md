# D00 browser observations — 2026-10-09

Environment: Chrome extension through CUA, `http://127.0.0.1:4418/`, fake-agy
fixture on `127.0.0.1:4417`; viewport observed at 1366 × 800. No user data,
Antigravity process, or personal daemon was used.

The CUA browser run rendered and visually inspected the dashboard. The browser
tool emitted screenshots for the final historical page, the reloaded BLOCKED
detail, and the board after acknowledging the notice. Its supported page-asset
export only bundles page files, not browser screenshots, so it supplied no
writable screenshot path. This document preserves the associated sanitized
read-only measurements; it does not represent a screenshot substitute.

| Case | Browser interaction and read-only measurement | Outcome |
| --- | --- | --- |
| V01 | Selected A; traversed backwards to `HIST-001`–`HIST-010`, then pressed “Mostrar eventos más recientes” 24 times. Final DOM: `HIST-241`–`HIST-250`, 10 `li`, status `Eventos 241–250 de 250 cargados`. Historical DOM: 10 `li`, panel `clientHeight=286`, `scrollHeight=566`, `scrollTop=0`. | Passed |
| V02 | Selected live job after >10 events and chose older activity. Before a 1.5 s wait, the visible page was `LIVE-163`–`LIVE-172`; after it it was `LIVE-179`–`LIVE-188`, while the job remained active. | Failed: a historical page advanced with incoming LIVE events. |
| V06 | Created synthetic quick job while A remained selected. `NUEVO` appeared once, persisted through reload, and disappeared after its card was selected and the board reloaded. A had no `NUEVO`. | Passed |
| V08 | Selected C, waited 10 seconds, reloaded, then selected C again. Card and detail still showed `42s`; detail labelled the timestamp `Última parada`. | Passed |

Unavailable controls in this CUA Chrome session: Offline/Online, slow-network
throttling, and request blocking. Browser capability inventory exposed only
`viewport`; the tab exposed only `pageAssets`. Therefore V03, V04, V05 and V07
were not executed or inferred from HTTP/jsdom.

## V02 correction run

The earlier V02 observation measured the view while the previous-page request
was still pending. The regression test now holds that request and demonstrates
the race: before the correction, LIVE 21–30 replaced the page 11–20; afterward
the page remains 11–20 until REST supplies 1–10.

Chrome/CUA reproduction after the correction selected the synthetic active job
`D00 V02 corregido`, opened earlier activity, and observed LIVE-165 through
LIVE-174 unchanged over 1.5 seconds while the number of loaded events grew from
153 to 169. The panel rendered ten `li` and exposed both earlier/recent controls.
CUA's one-page-at-a-time action rate could not return to the last page before
the 250-event runner ended, so active follow-after-return remains covered by the
unit regression/existing resume test rather than a completed browser observation.

## V02 controlled browser completion

The fixture now also accepts `task: D00:controlled` only for D00 acceptance. It
emits LIVE-001 through LIVE-012 at 500 ms intervals, pauses 30 seconds, then
emits LIVE-013 through LIVE-024. Chrome selected the active job during the
pause, opened the historic page containing `created`, `queued`, `started`, and
LIVE-001 through LIVE-007, and observed the same ten items after one second.
After clicking “Mostrar eventos más recientes”, the panel displayed LIVE-003
through LIVE-012. Once the pause ended it followed LIVE-016 through LIVE-024
and the completion event, always with ten `li`.

CUA emitted a visual screenshot of that final browser state. Its available
export capability still returns page assets only, not a screenshot file path,
so no portable image file can be retained without fabricating one.

## V03 manual — primer recorrido no concluyente

El usuario abrió DevTools Network, eligió Offline y observó que el dashboard
seguía mostrando `LIVE`; no apareció `RECONNECTING`. La captura portátil
aportada por el usuario muestra el tablero con el trabajo `D00 V03 reconexión`
en `DONE` y la solicitud `stream` con estado 200. Por ello el corte pudo haber
ocurrido después de finalizar el stream: no permite concluir si falló el
indicador o la interrupción. Se conserva como resultado pendiente, no aprobado.
Para la repetición se añadió únicamente al fixture fake el modo
`D00:long-live`: 360 eventos a 500 ms, unos tres minutos de stream activo.

## V03 manual — repetición con stream activo

Durante `D00 V03 stream prolongado`, el usuario eligió Offline en DevTools.
Las capturas portables `v03-offline-stream-retries.png` y
`v03-offline-live-indicator.png` muestran varias solicitudes EventSource
`stream` fallidas con `net::ERR…`, mientras el indicador superior sigue
mostrando `LIVE`. Esto prueba que el corte alcanzó el transporte y que el
indicador de conexión no representa el estado de reconexión. V03 falló; no se
acepta hasta que el handler de error de EventSource muestre `RECONNECTING` y
una repetición confirme el retorno a `LIVE` desde `onopen`.

## V04 manual — carga inicial y recuperación

Con Offline, la selección del trabajo sintético `D00 V04 carga inicial` produjo
fallos de red para `events` y `diff`, visibles en
`v04-offline-initial-request.png`; el dashboard mostró el error y no dejó un
loader permanente. Con `No throttling`, la actividad volvió a cargar: la
captura `v04-recovered-activity.png` muestra los ocho eventos `created`,
`queued`, `started`, LIVE-001–004 y `completed`. Resultado: pasó.

## V05 manual — cambio rápido de tarjeta

Con Slow 3G, el usuario seleccionó `D00 A - historial 250` e inmediatamente
`D00 B - selección alternativa`. Al volver a No throttling, Logs conservó B
como título y su actividad mostró ALT-001 a ALT-010, sin un evento HIST de A;
véase `v05-rapid-switch-b-only.png`. Resultado: pasó.

## V07 automatizado — bloqueo recuperable

Chrome aislado aplicó mediante CDP el mismo filtro que DevTools Network Request
Blocking: `*://127.0.0.1:4418/api/jobs/*/events*`. Dos solicitudes fallaron y
el panel mostró `Failed to fetch` y `REINTENTAR`
(`v07-blocked-events.png`). Después de quitar la regla y pulsar Reintentar,
renderizó precisamente HIST-241 a HIST-250, con diez elementos y sin loader
persistente (`v07-recovered-events.png`). Resultado: pasó.

## V03 revalidado — corte SSE real

La emulación Offline sobre loopback no desconectaba el SSE activo, por lo que
no disparaba `EventSource.onerror`. El problema real estaba en el proxy Vite:
registraba `ECONNRESET` del upstream pero dejaba vivo el response downstream.
La corrección destruye el response SSE ante `proxyRes.close` y `proxy.error`.
Con Chrome aislado y el fixture reiniciado con el mismo estado y token efímeros,
el encabezado cambió `LIVE → RECONNECTING → LIVE`; véanse
`v03-reconnecting.png` y `v03-recovered-live.png`. La consulta REST posterior
recibió LIVE-001 a LIVE-044: 44 secuencias, cero duplicados y cero huecos.
La regresión de `api.test.ts` cubre `onopen → onerror → onopen` y exige los
cambios de estado `true, false, true` junto con el callback de recuperación.

## Revisión 2026-10-13 — V03 con productor activo

Se inició `D00 V03 productor continuo` y se interrumpió únicamente la primera
respuesta SSE downstream del proxy de aceptación, con el daemon y runner fake
activos. Antes del corte, ActivityPanel mostraba LIVE-044–053. Mientras el
indicador mostraba `RECONNECTING`, la consulta REST ya contenía LIVE-055,
demostrando producción durante el corte; la captura es
`v03-active-producer-reconnecting.png`. Tras la reconexión, ActivityPanel mostró
LIVE-048–057 (`v03-active-producer-recovered.png`). La revisión REST de
LIVE-001–057 obtuvo 57 secuencias, cero duplicados y cero huecos. Resultado:
pasó.

## Revisión 2026-10-13 — V04 con la misma tarjeta y vista

CDP mantuvo pendientes dos solicitudes `/api/jobs/<id>/events` después de
seleccionar `D00 V04 corte pendiente` y abrir Logs. La medición de la vista
activa fue `loading=true`, título de esa tarjeta y cero eventos
(`v04-pending-load.png`). Al fallar ambas solicitudes se mostró `Failed to
fetch` y `REINTENTAR`, con `loading=false`, sin cambiar tarjeta ni vista
(`v04-interrupted-pending-load.png`). Después de desactivar la intercepción y
pulsar Reintentar, Logs siguió en la misma tarjeta y cargó ocho eventos sin
loader (`v04-recovered-same-view.png`). Resultado: pasó.

## Revisión final 2026-10-13 — V04 automático, navegador integrado

El revisor abrió su propia pestaña en 4418, con base fake nueva y el proxy
de revisión que retiene la primera carga REST 30 s y destruye solo SSE a los
ocho segundos. Chrome conectado no estaba disponible; el navegador integrado
cargó la aplicación. Se seleccionó `D00 A - historial 250` y se mantuvo esa
selección/vista hasta terminar. No se pulsó Reintentar ni se recargó la página.

La primera observación AX mostró Cargando actividad. Tras reconectar, DOM
mostró LIVE, `loading=false`, cero filas y Recuperando eventos perdidos. Después
de resolver las cargas, DOM mostró la misma A, LIVE, HIST-241–250 y diez filas;
sin error, loader ni cambio de tarjeta. La respuesta vieja tardía no alteró ese
resultado. Captura original de página completa, viewport por defecto:
[V04 automático](2026-10-13-v04-auto-recovered-review.png). La imagen acompaña
las mediciones; no se usa para inferir el conteo de filas fuera del viewport.

Código portable: `apps/dashboard/fixtures/d00-pending-load.config.ts`.
Se cerraron pestaña y procesos propios; 4417/4418/9222 sin listeners. ESLint
falló primero por extensiones del perfil temporal de otro recorrido; tras
excluir `.orquest/**`, lint/typecheck y 137 tests pasaron, igual que build.
