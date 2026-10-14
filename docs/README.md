# Documentación de Orquest

Punto de entrada actualizado el 2026-10-13. Para continuar el desarrollo sin
leer todo el chat, empezar por [el handoff actual](handoff.md).

## Desarrollo y traspaso

| Documento | Para qué sirve |
| --- | --- |
| [handoff.md](handoff.md) | Qué existe, qué falta y primera asignación del siguiente agente. |
| [continuation-progress.md](continuation-progress.md) | Estado y evidencia de las entregas; fuente central de avance. |
| [continuity-contract.md](continuity-contract.md) | Contrato D01 aceptado: tarea/intentos/mensajes, cursores e idempotencia para D02–D05. |
| [delegation-plan.md](delegation-plan.md) | Fichas D00–D21: responsables, dependencias, archivos y aceptación. |
| [continuation-plan.md](continuation-plan.md) | Hoja de ruta por fases y criterio de producto funcional. |
| [product-evolution-plan.md](product-evolution-plan.md) | Objetivos del producto y decisiones de experiencia. |
| [visual-validation.md](visual-validation.md) | Método obligatorio para cambios UI: fixture, navegador, capturas y verificación. |
| [delegation-results/](delegation-results/) | Informes por entrega; no equivalen automáticamente a aceptación. |

Antes de cambiar contratos, persistencia, procesos, MCP o seguridad, leer
[IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md), además de
[AGENTS.md](../AGENTS.md). Si un documento discrepa del código, inspeccionar la
diferencia y registrar el hallazgo; no tomar una propuesta como implementación.

## Uso y operación

- [user-guide.md](user-guide.md): uso diario del puente/dashboard.
- [operations.md](operations.md): operación y diagnóstico.
- [codex-setup.md](codex-setup.md): conexión MCP.
- [mcp-tools.md](mcp-tools.md): herramientas del puente.
- [README principal](../README.md): instalación y comandos.

## Referencias históricas

[agent-handoff-phase-3.md](agent-handoff-phase-3.md),
[phase-3-mcp-plan.md](phase-3-mcp-plan.md) y
[terra-review-next-steps.md](terra-review-next-steps.md) conservan decisiones y
revisiones anteriores. **No son la siguiente asignación**: no repetir fases ni
usar sus conteos de pruebas/estado Git como si fueran actuales.

Mantener los archivos en sus rutas actuales para conservar enlaces. Actualizar
el progreso y el informe de la entrega antes de modificar el resumen de handoff;
no crear varios planes alternativos ni pegar transcripciones completas.
