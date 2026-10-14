# Referencia MCP de Orquest Bridge

El servidor `@orquest/mcp-server` expone 10 herramientas. Todas hablan con el
daemon local autenticado; el servidor MCP no conserva estado propio.

| Herramienta | Uso |
|---|---|
| `orquest_health` | Comprueba daemon, autenticación y ejecutor activo. |
| `orquest_submit_jobs` | Envía de 1 a 8 trabajos. |
| `orquest_list_jobs` | Lista trabajos paginados y filtrados. |
| `orquest_get_job` | Devuelve el registro completo de un trabajo. |
| `orquest_wait_job` | Espera hasta 60 s por actividad o estado final/bloqueado. |
| `orquest_get_transcript` | Lee eventos paginados. |
| `orquest_send_message` | Crea una continuación de una conversación terminada. |
| `orquest_cancel_job` | Cancela un trabajo en cola o ejecución. |
| `orquest_retry_job` | Crea un intento nuevo de un trabajo terminal o bloqueado. |
| `orquest_get_diff` | Lee el diff paginado de un worktree; nunca lo integra. |

## `orquest_submit_jobs`

Cada elemento de `jobs` usa estos campos principales:

```json
{
  "title": "Implementar validación",
  "task": "Implementa la validación y ejecuta sus pruebas.",
  "workspacePath": "C:\\ruta\\al\\repo",
  "profileId": "implementer",
  "agent": "implementer",
  "model": "auto",
  "effort": "high",
  "accessMode": "worktree",
  "acceptanceCriteria": ["La prueba pasa"],
  "verificationCommands": ["npm.cmd test"],
  "priority": 50
}
```

`model` puede ser `auto` o un slug aceptado por `agy`. `effort` acepta `low`,
`medium`, `high` y `max`. `agent` es opcional y se transmite como `agy --agent`.

### Perfiles

`profileId` selecciona una política local: `quick`, `researcher`,
`implementer` o `reviewer`. Sus valores efectivos se consultan con la API local
autenticada `GET /api/profiles`; se configuran mediante
`ORQUEST_PROFILES_PATH` y `config/profiles.example.yaml`. El perfil
`implementer` requiere un workspace Git para aislar cambios en un worktree.

### Dependencias

Añade `dependsOnJobIds` con UUIDs existentes. El trabajo queda en `READY` hasta
que todos estén en `DONE`; si uno termina en `FAILED`, `CANCELED` o `BLOCKED`,
pasa a `BLOCKED` con código `DEPENDENCY_FAILED`.

```json
{
  "dependsOnJobIds": ["11111111-2222-3333-4444-555555555555"]
}
```

### Flujo escritor ? revisor

1. Envía el implementador con `accessMode: "worktree"`.
2. Envía el revisor con `accessMode: "read-only"` y `reviewOfJobId` igual al
   UUID del implementador.

El daemon añade la dependencia al escritor y ejecuta al revisor dentro del
mismo worktree, siempre en modo `plan`. El revisor no recibe `accept-edits`.

## Paginación y seguridad

`orquest_list_jobs`, `orquest_get_transcript` y `orquest_get_diff` devuelven
`nextCursor` y `hasMore`. Solicita páginas pequeñas y no vuelques una
transcripción completa en un solo mensaje.

El puente sólo escucha en loopback, exige token para `/api`, redacta secretos en
los errores y no permite merge, push, despliegue, migraciones ni el flag de
permisos peligrosos de Antigravity.
## Verificación y subagentes

`verificationCommands` se ejecuta sin shell al completar el worker. La política
actual admite únicamente `npm.cmd test`, `npm.cmd run test`, `npm.cmd run lint`,
`npm.cmd run build` y `git diff --check`. Un fallo hace fallar el trabajo y deja
la salida acotada en el resultado o evento correspondiente.

Cuando Antigravity emite `subagent_info`, Orquest lo normaliza y lo conserva en
la transcripción. El panel de detalle muestra esos subagentes en la sección
**Agents**, sin inventar razonamiento que la CLI no haya expuesto.