# Validación UI con navegador y capturas

Método adoptado por el usuario el 2026-10-09. Aplica a cambios del dashboard y
a las entregas UI del [plan de delegación](delegation-plan.md). Complementa tests
y build; una captura por sí sola no demuestra funcionamiento ni aceptación.

## 1. Ciclo de trabajo

1. **Definir el caso.** ID, comportamiento esperado, datos, viewport y pasos.
   Ejemplo: resultado largo desplazable sin mover el Kanban.
2. **Preparar aislamiento.** Fixture determinista, base privada y puertos de
   prueba. [D00](delegation-results/D00.md) contiene comandos completos de
   arranque, creación de trabajos sintéticos y cierre. No usar datos personales.
3. **Observar antes.** Tomar una captura inicial si se reproduce un defecto;
   anotar qué falla. Si ya está corregido, no fabricar una captura «antes».
4. **Implementar el mínimo.** Preservar diseño/funciones existentes. Para scroll,
   preferir CSS nativo y límites de altura; no añadir librerías o handlers si
   no hacen falta. No sustituir funcionalidad pendiente por un mock decorativo.
5. **Interactuar y medir.** Ejecutar los pasos reales, comprobar estado fresco
   después de cada interacción y capturar el resultado. Registrar fallos.
6. **Verificar código.** Tests focalizados cuando corresponda, después los gates
   del repositorio y build dashboard. Obtener el exit code final de cada proceso.
7. **Cerrar y entregar.** Restaurar ajustes temporales, cerrar solo recursos
   propios, registrar evidencia/pendientes y pedir revisión de la entrega.

Para esta entrega documental no es necesario volver a arrancar el fixture ni
repetir capturas; la evidencia del 2026-10-09 se conserva como histórica.

## 2. Cómo usar el navegador de forma fiable

- Leer la skill aplicable y la documentación de las herramientas disponibles
  **en el entorno del agente**. No copiar APIs supuestas de otro runtime.
- Abrir una pestaña propia para el fixture y nombrar la sesión. Usar controles
  semánticos (rol/nombre/label); volver a inspeccionar si cambia la página.
- Para UI, usar la herramienta de navegador autorizada; no montar otro driver
  para eludir sus restricciones. Evaluación DOM de solo lectura para métricas;
  acciones reales para clicar, desplazar, recargar y usar teclado.
- Verificar que se cargó la aplicación, no solo que Vite imprimió una URL:
  título, controles, conexión y fixture correctos. No fotografiar un error 404
  como si fuera el dashboard operativo.
- Capturas: tras el cambio y en estados que permitan comprobar el criterio.
  No fotografiar cada clic; suficiente evidencia representativa de éxito/error,
  sin sustituir el recorrido. Mantener contexto del panel/tablero.
- Fijar viewport solo para comprobar breakpoints, no para mejorar artificialmente
  la captura. Registrar dimensiones; restaurar el tamaño al terminar.
- Ante bloqueo de navegador, comprobar alternativas permitidas. No desactivar
  seguridad ni esquivar barreras. Dejar el caso pendiente si no puede ejecutarse.
- Los escenarios de Offline, red lenta o request blocking de D00 requieren
  herramientas realmente disponibles. No fingir un corte SSE por ocultar un
  mensaje, ni cambiar código de producción para simular éxito.

## 3. Qué comprobar además de la imagen

Para scroll:

- `clientHeight`, `scrollHeight` y `scrollTop` del panel y resultado; altura y
  desplazamiento de página/tablero antes y después. No exigir valores exactos
  de otro navegador: tipografía, scrollbars y viewport pueden cambiarlos.
- Acceder al principio y al final sin perder texto, con mouse y teclado cuando
  sea aplicable. Confirmar foco visible y regiones con nombre accesible.
- En escritorio, panel y resultado deben desplazarse independientemente. En
  móvil, puede desplazarse la página para llegar al panel, pero su contenido
  debe seguir acotado/accesible. Comprobar tablet/móvil sin recortes horizontales
  inesperados; el Kanban puede tener su scroll horizontal propio.
- Cambiar tarjeta: resultado correspondiente y desplazamiento reiniciado. No
  confundir `isVisible` con tener un elemento dentro del área visible del panel.

Para actividad/novedad/continuidad:

- Máximo diez eventos renderizados por ActivityPanel; historial accesible,
  identidad/secuencia/orden sin duplicados. Medir DOM, no contar solo por foto.
- Página histórica no salta por eventos nuevos; reconexión recupera huecos,
  errores permiten recuperación y respuestas tardías no mezclan tarjetas.
- Aviso NUEVO persiste antes del clic y se reconoce después; duración de BLOCKED
  permanece congelada. Recarga y estados vacíos/error/en curso también importan.
- Cuando exista chat: identidad de tarea, historial de intentos, breadcrumb,
  envío idempotente y modelos con fuente. No aceptar solo la apariencia.

## 4. Archivos de evidencia y privacidad

Trabajo temporal: `.orquest/d00-<sufijo>/evidence/` (ignorado por Git). Al
entregar, conservar las capturas necesarias y saneadas en
`docs/evidence/<ID>/YYYY-MM-DD-<caso>-<viewport>-<estado>.<ext>` y enlazarlas desde
`docs/delegation-results/<ID>.md`. Así el traspaso no depende de una carpeta Temp
ni de archivos ignorados. No incluir bases SQLite, tokens, manifests sensibles
ni logs completos. No crear archivos vacíos para cubrir evidencia pendiente.

Usar la extensión real del formato generado (p. ej. JPG si la herramienta
devuelve JPEG). Mantener la captura original; cualquier recorte debe conservar
lo necesario para juzgar el resultado. No retocar el estado/error observado.

Evitar correos, nombres de cuenta, tokens, headers, rutas privadas ajenas y
pestañas personales. Si algo sensible aparece, repetir con fixture limpio o
redactar antes de conservar/compartir, declarando la redacción. La evidencia
aprobada del scroll usa exclusivamente datos sintéticos.

En el informe usar enlaces relativos portables; en la respuesta del chat,
enlaces/imagenes con ruta absoluta al archivo. Mostrar la captura clave cuando
aporte verificación al usuario, no solo mencionarla en una salida de herramienta.

## 5. Plantilla mínima para informe visual

```markdown
# [ORQUEST][AGENTE C][ID][ESTADO: ENTREGADO]

Fecha, navegador/herramienta, entorno fake/real, versión/checkpoint probado.
Objetivo y archivos propios modificados.

| Caso | Pasos/datos | Esperado | Observado y métricas | Estado | Evidencia |
| --- | --- | --- | --- | --- | --- |
| VXX | ... | ... | ... | PASÓ / FALLÓ / PENDIENTE | enlace o motivo |

Comandos: resultado y exit code final, incluidos intentos fallidos.
Captura clave: ![Descripción](../evidence/ID/archivo.jpg)
Limitaciones: lo no probado; distinguir fake/HTTP/jsdom/navegador/proveedor real.
Cierre: procesos/pestañas propios cerrados; ajustes restaurados o pendientes.
Checkpoint: próxima acción exacta; no iniciar la siguiente entrega sin asignación.
```

El implementador entrega evidencia; el orquestador acepta o requiere corrección.
Guardar avances parciales no obliga a repetir casos ya probados sin cambios;
si un cambio afecta esos casos, volver a validarlos y fechar la nueva evidencia.

## 6. Ejemplo real conservado

[DASHBOARD-SCROLL-01](delegation-results/DASHBOARD-SCROLL-01.md): navegador real,
resultado largo sintético, mediciones, teclado y límites responsive. Solo acepta
ese ajuste: los casos V01–V08 de D00 siguen pendientes.
