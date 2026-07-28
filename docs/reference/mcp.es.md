# Referencia de MCP

El servidor MCP es una proyección restringida sobre la API autoritativa. Versión del protocolo: **2024-11-05**. No ofrece una vía de mutación para agentes: el host sigue siendo canónico y las identidades MCP solo pueden leer o proponer.

## Inventario exacto de la interfaz

### Cinco herramientas

| Herramienta | Operación API | Efecto |
| --- | --- | --- |
| `proposeEdit` | `POST /v1/proposals` | Crea una propuesta en `proposed`; una persona debe aprobarla. |
| `suggestAltText` | `GET /v1/proposals/{id}` | Devuelve una sugerencia de texto alternativo; no modifica la propuesta. |
| `suggestCrop` | `GET /v1/proposals/{id}` | Devuelve una sugerencia de foco/recorte; no modifica la propuesta. |
| `generatePreview` | `GET /v1/proposals/{id}` | Deriva una vista previa; nunca avanza aprobación, publicación ni despliegue. |
| `submitApprovalRequest` | `GET /v1/proposals/{id}` | Señala disponibilidad para una persona fuera de banda; no cambia el estado y nunca llama a aprobar, publicar o revertir. |

### Dos recursos

| URI | Operación API | Propósito |
| --- | --- | --- |
| `proposal://{id}` | `GET /v1/proposals/{id}` | Leer una fila de propuesta. |
| `health://` | `GET /v1/health` | Comprobación de vida. |

El inventario es cerrado: el registro y la invocación solo aceptan estos cinco nombres y dos URI. No existen herramientas de aprobar, publicar, aplicar, desplegar o revertir, y MCP no puede invocar esas transiciones indirectamente.

Inventario fuente: [`ALLOWED_TOOL_NAMES` y `ALLOWED_RESOURCE_URIS`](../../packages/mcp/src/server.ts#L152-L165); la versión del protocolo la devuelve el manejador de inicialización en [`server.ts:515`](../../packages/mcp/src/server.ts#L515).

## Cortafuegos de nombres y argumentos

Los nombres de herramientas se normalizan sin distinguir mayúsculas tras colapsar guiones, guiones bajos, espacios, barras, puntos y dos puntos. Los nombres vacíos y todas las grafías o alias prohibidos se rechazan tanto al registrar como al invocar. El conjunto prohibido incluye nombres de aprobación/publicación/aplicación/despliegue/reversión y variantes force/admin/bypass/override/sign, nombres de HTTP/request/proxy/fetch/exec/run/invoke/send arbitrarios y nombres de patch/transition de propuestas.

Los argumentos se validan como objetos planos. El servidor rechaza claves que puedan sobrescribir el descriptor o introducir una transición, incluidas `method`, `path`, `url`, `endpoint`, `target`, `action`, `op`, `operation`, `verb`, `route`, `request`, `raw`, `override`, `bypass`, `force`, `patch`, `transition`, `forward`, `proxy`, `exec`, `run`, `invoke`, `http`, `fetch`, `send`, `approver`, `approve`, `publish`, `apply`, `rollback`, `deploy` y variantes de `ifmatch`. El método y la ruta de la API siempre proceden del descriptor cerrado; nunca se aceptan datos de encaminamiento o acción enviados por quien llama.

El cortafuegos de claves de argumentos es el conjunto cerrado `FORBIDDEN_ARG_KEYS` en [`packages/mcp/src/server.ts:261-295`](../../packages/mcp/src/server.ts#L261-L295).

La aprobación se delega a una persona fuera de MCP. Por ello, los efectos privilegiados y de comercio siguen bloqueados por el coordinador; la reconciliación es asíncrona y se observa mediante la API canónica, no mediante una herramienta de mutación MCP.
