# Visión general

> **Audiencia:** todas. Esta página es el *elevator pitch* del proyecto, el modelo mental del límite del contenido y el mapa de paquetes. Léela una vez y luego entra en una ruta de audiencia.

[English version](overview.md) · Las versiones inglesa y española se envían en el mismo *pull request*.

## Qué es Handoff CMS

Handoff CMS es un sistema de gobernanza *open-core* bajo Apache-2.0, autoalojable, para una tarea concreta: mover cambios de contenido aprobados desde quienes editan (clientes, editores de agencia, autores no técnicos) al **host** que posee la verdad canónica (un sitio web, un repositorio, una base de datos, un CMS destino), preservando la autoridad del host y produciendo un registro de auditoría a prueba de manipulaciones.

Es la respuesta a un fallo recurrente en la relación agencia / cliente: el contenido del sitio web vive en una base de código mediada por desarrolladores, en un CMS externo o en un híbrido, y no existe una forma segura y gobernada de que un cliente no técnico edite contenido del host sin un *visual builder* inseguro, una revisión de código hostil o un CMS propietario gestionado que encierra los datos.

El producto preserva dos invariantes innegociables de extremo a extremo:

1. **El host permanece canónico.** El sitio web / repositorio / base de datos / CMS destino del host posee cada byte de contenido y cada recurso. Handoff CMS posee solo la **proyección de traspaso gobernada** — *deltas* propuestos, revisiones aprobadas, vinculaciones de región, permisos, auditoría, vistas previas, reconciliación y reversión con una sola acción.
2. **Los agentes proponen; los humanos aprueban.** Cada transición de aplicar, publicar o revertir requiere un evento fresco de autorización humana. Las identidades MCP y de servicio nunca aprueban ni publican. La reversión es un clic del operador contra la autoridad capturada en el momento de aprobación; el clic es el evento de autorización humana, no una aprobación sintética.

## El límite del contenido

El límite entre *lo que el host posee* y *lo que el CMS gobierna* es el concepto arquitectónico central. El CMS no es una nueva fuente de verdad; es una capa gobernada que produce cambios auditables y reversibles contra el host.

| Cuestión | En manos del host | Gobernado por Handoff CMS |
| --- | --- | --- |
| Contenido canónico (HTML, JSON estructurado, datos vía API) | sí | no |
| Recursos (imágenes, derivados, vídeo) | sí | no |
| Vinculaciones de región (qué superficie del host mapea a qué `RegionBinding`) | declaradas por el desarrollador; el CMS verifica | sí — `canonical_source`, `derived_artifacts[]`, `regeneration_contract`, `field_capabilities` |
| *Deltas* propuestos | no | sí — *content-addressable*, referencias antes/después, actor, aprobador |
| Aprobaciones | no | sí — un evento de autorización humana por cada aplicar / publicar / revertir |
| Registro de auditoría | no | sí — append-only, *content-hashed*, firma Ed25519 JWS separada |
| Despliegue / propagación | específica del host (`DeployCapability`) | el CMS rastrea `canonical_written` vs `live_propagated` y los reconcilia |
| Reversión | no | sí — un clic del operador contra el objetivo de reversión capturado |
| OIDC bearer / sesiones humanas delegadas | el operador del host las configura | el CMS verifica, nunca las omite |

El despliegue de referencia de Cerafica hace concreto el límite. Cerafica tiene tres superficies editables — páginas HTML en duro, productos en JSON estructurado en el canónico `inventory/products.json` (servido al sitio web mediante un alias de symlink verificado en `website/data/products.json`), y una API de bitácora Kyanite — y un único adaptador `@cms/adapter-cerafica` media las tres.

Algunas particularidades del límite que conviene señalar de entrada:

- **Los aliases de symlink servidos se verifican, no se escriben.** El CMS escribe solo la ruta canónica; nunca escribe a través de un alias. En la activación de la región y en la reconciliación, la vinculación verifica la resolución del objetivo, el confinamiento en el repositorio, el comportamiento sin ciclos y la integridad del objetivo. Un alias faltante, roto, reorientado, que se escapa o reemplazado por un archivo regular falla de forma visible y nunca informa éxito.
- **Los campos vinculados al comercio están *coordinator-gated*.** Los campos de Cerafica vinculados a Stripe (`price`, `stripe_payment_link`, `available`, `one_of_one`) son por defecto de solo lectura / *coordinator-gated*. Editar libremente `price` sin regenerar el *Payment Link* provoca un desajuste entre el *checkout* y lo mostrado; alternar `available` / `one_of_one` sin coordinación de inventario provoca riesgo de sobreventa.
- **La accesibilidad es "neurodivergente-accesible por diseño".** Postura interna de diseño V1 (WCAG 2.2 AA + ATAG 2.0 + patrones COGA), aplicada en CI; la validación externa con participantes es un objetivo v1.1. Consulta [`docs/evidence/limitations.md`](evidence/limitations.md) y la declaración de accesibilidad en [`docs/accessibility/statement.es.md`](accessibility/statement.es.md) · [English](accessibility/statement.md).
- **El segundo adaptador es el criterio de conformidad v1.1.** V1 envía un adaptador de referencia; los campos de extensión / capacidad específicos del host del contrato de adaptador siguen siendo provisionales (1.0-beta / RC) hasta que un segundo adaptador los ejercite. Consulta [`docs/evidence/limitations.md`](evidence/limitations.md).
- **El tiempo de ejecución Docker no está verificado.** Solo pasaron la validación de interpolación/configuración Compose, las pruebas de paquetes y la comprobación sintáctica del healthcheck. No afirmes un despliegue Docker en vivo. Consulta [`docs/evidence/limitations.md`](evidence/limitations.md).

## Los trece paquetes

El monorepo V1 es un *workspace* de pnpm (`packages/*`) con trece paquetes `@cms/*`. Su DAG de dependencias es aproximadamente `core` → {`storage`, `audit`} → `api` → {`server`, `cli`, `mcp`, `web`}; `adapter-sdk` → `adapter-cerafica`; `media`, `i18n`, `licensing-guard` son hermanos usados por las capas superiores. El DAG completo, el modelo de autoridad de transporte y la razón de cada capa están documentados en [`docs/concepts/architecture.md`](concepts/architecture.md) (EN) y su par `.es`.

| Paquete | Función | Notas |
| --- | --- | --- |
| `@cms/core` | Núcleo de gobernanza puro, sin E/S | Modelo de dominio, máquina de estados, motor de políticas — autoridad única |
| `@cms/storage` | Persistencia Drizzle / Postgres | Inquilinos, actores, vinculaciones de región, propuestas, aprobaciones, revisiones, publicaciones, auditoría, idempotencia |
| `@cms/audit` | Auditoría inmutable + exportación portable | NDJSON canónico, Ed25519 JWS separado, verificable sin conexión |
| `@cms/api` | Transporte Hono / OpenAPI 3.1 | Transporte delgado; Problem Details RFC 9457; escrituras con *idempotency-key* |
| `@cms/server` | Ejecutable ESM Node 22 autoalojable | Verificación OIDC *bearer*, `/health/live`, `/health/ready`, `/metrics` |
| `@cms/cli` | Proyección CLI delgada sobre la API | Proponer y leer usan credenciales configuradas; aprobar / publicar / revertir requiere sesión humana interactiva |
| `@cms/mcp` | Proyección servidor MCP | Herramientas de proponer / previsualizar / sugerir; `submitApprovalRequest` solo señala disponibilidad; **sin** superficie de aprobar / publicar / aplicar / revertir |
| `@cms/web` | Aplicación de autoría Handoff Beat | Bilingüe (locales pares EN / ES), superficie de autoría alineada con ATAG, modelo de baja distracción; cliente delgado sobre un `AuthoringApi` inyectado |
| `@cms/adapter-sdk` | Contrato de adaptador congelado portador de invariantes + arnés de conformidad | `canonical_source` / `derived_artifacts[]` / `regeneration_contract` son parte del núcleo congelado; `field_capabilities`, `DeployCapability` son extensiones específicas del host (1.0-beta / RC) |
| `@cms/adapter-cerafica` | Adaptador de referencia Cerafica | HTML + canónico `inventory/products.json` (servido vía alias de symlink verificado) + API de bitácora Kyanite + `DeployCapability` GitHub-Pages + *gating* de campos Stripe |
| `@cms/media` | *BlobStore* conectable + tubería de medios gobernada | ICC preservado, EXIF eliminado, cuarentena *fail-closed* ante malware, derivados de imagen, vídeo de solo lectura en V1 |
| `@cms/i18n` | Catálogos de mensajes pares EN / ES | Sin dependencias; `assertCatalogParity` exige paridad de claves |
| `@cms/licensing-guard` | Guarda de política de licencias *fail-closed* | Recorre el grafo de dependencias del *functional-core* e informa contra una única lista de permisos autoritativa |

El grafo de dependencias mantiene a `@cms/core` sin E/S para que siga siendo verificable en aislamiento. `@cms/api` es la única superficie de autoridad; `@cms/cli` y `@cms/mcp` son proyecciones delgadas que comparten las decisiones de `@cms/api` en lugar de reimplementarlas. `@cms/web` es un cliente delgado sobre un `AuthoringApi` inyectado y nunca reimplementa la autorización.

## Dónde ir a continuación

- Nuevo en el proyecto: lee [`README.md`](../README.md) (inglés) / [`README.md#handoff-cms-en-español`](../README.md#handoff-cms-en-español) (español) y elige una ruta de audiencia.
- Los puntos de entrada específicos por audiencia están listados en [`docs/README.md`](README.md) bajo "Matriz audiencia → sección".
- Detalle arquitectónico: [`docs/concepts/architecture.md`](concepts/architecture.md) (EN) · [`docs/concepts/architecture.es.md`](concepts/architecture.es.md) (ES).
- Gobernanza y autoridad humana: [`docs/concepts/governance-and-human-authority.md`](concepts/governance-and-human-authority.md) (EN) · [`docs/concepts/governance-and-human-authority.es.md`](concepts/governance-and-human-authority.es.md) (ES).
- El adaptador de referencia Cerafica: [`docs/adapters/cerafica.es.md`](adapters/cerafica.es.md) · [English](adapters/cerafica.md).
- Libro de evidencia: [`docs/evidence/verification.md`](evidence/verification.md); libro de limitaciones: [`docs/evidence/limitations.md`](evidence/limitations.md).
