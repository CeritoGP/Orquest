# Guía de uso de Orquest Bridge

## Qué abrir

- `http://127.0.0.1:4317` es el daemon/API. No tiene página web: ver `{"error":"Route not found"}` en esa dirección es normal.
- `http://127.0.0.1:4318` es el dashboard que debes dejar abierto.
- El chat de Codex es donde das las órdenes. Codex usa el MCP para crear y gestionar trabajos; no hace falta copiar ni pegar mensajes a Antigravity.

## Arranque diario

La forma recomendada en Windows es hacer doble clic en `iniciar-orquest.bat`.
La terminal queda abierta, inicia daemon y dashboard y muestra la URL local
exacta. En el primer inicio también instala la política operativa base de
Antigravity: lectura, búsqueda, Git de consulta y pruebas locales permitidas.
No habilita escritura fuera del proyecto, red, push, merge, despliegues ni
permisos universales.

Como alternativa de desarrollo, desde la raíz de Orquest abre dos terminales.

Terminal 1, daemon y trabajadores reales:

```powershell
$env:ORQUEST_RUNNER = 'agy'
$env:ORQUEST_ALLOWED_ROOTS = (Get-Location).Path
npm.cmd run dev:daemon
```

Terminal 2, dashboard:

```powershell
npm.cmd run dev:dashboard
```

Si quieres probar el puente sin gastar Antigravity, omite `ORQUEST_RUNNER = 'agy'`; se usará el worker falso.

## Flujo normal en Codex

1. Dime el objetivo en lenguaje natural. Por ejemplo:

   > Analiza este repositorio y divide el trabajo entre tres agentes de solo lectura: arquitectura, pruebas y riesgos. Después resume sus hallazgos.

2. Codex crea los trabajos con `orquest_submit_jobs`, espera lo necesario y reúne las respuestas. Los trabajos aparecen enseguida en Kanban.
3. Haz clic en una tarjeta para abrir el detalle de actividad, resultado, agentes reportados, pruebas y cambios.
4. Si quieres intervenir, dímelo aquí: “cancela el trabajo X”, “reintenta X” o “continúa X y revisa también las pruebas”. Codex usa el MCP; no necesitas manejar IDs manualmente salvo que quieras ser específico.

## Perfiles

| Perfil | Uso | Acceso |
|---|---|---|
| `quick` | consultas cortas | solo lectura, esfuerzo bajo |
| `researcher` | análisis e investigación | solo lectura |
| `implementer` | cambios de código | worktree aislado |
| `reviewer` | revisión de cambios | solo lectura |

Puedes pedirme, por ejemplo: “crea un implementador con esfuerzo alto y luego un revisor para ese trabajo”. Los cambios del implementador ocurren en un worktree; Orquest nunca hace merge ni push automáticamente.

Para cambiar los valores por defecto, copia `config/profiles.example.yaml` a una ruta privada, define `ORQUEST_PROFILES_PATH` antes de iniciar el daemon y reinícialo. La vista **Profiles** muestra lo que el daemon cargó realmente.

## Qué muestra cada módulo

- **Kanban:** estado de cada trabajo. Selecciona una tarjeta para abrir detalle.
- **Agents:** trabajador principal y subagentes que Antigravity haya emitido para el trabajo seleccionado. No inventa razonamiento privado.
- **Sessions:** continuaciones y reintentos enlazados a una conversación.
- **Logs:** línea de eventos persistida y redactada del trabajo seleccionado.
- **Profiles:** modelo, esfuerzo, agente y acceso por perfil.
- **Settings:** rutas y límites operativos del puente local.

## Si un trabajo queda BLOCKED

Un bloqueo de permisos de `agy` no significa que Orquest haya fallado. Las sesiones headless no pueden contestar diálogos. El lanzador instala una política base para las operaciones habituales; si el trabajo requiere una capacidad nueva, Orquest debe informar la regla estrecha faltante antes de reintentarlo.

No agregues `command(*)`, `unsandboxed(*)` ni `--dangerously-skip-permissions`.
