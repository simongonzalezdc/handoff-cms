# Publicación y versionado

> [English version](release-versioning.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo *pull request* (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).
>
> **Audiencia:** contribuidoras que cortan una publicación, operadoras que planifican una actualización e integradoras que siguen la versión del contrato del adaptador del host. Esta página es informativa (proyecto Diátaxis). La línea de publicación es 0.x, el proyecto es pre-1.0 y la página registra la forma publicada de la línea de versiones, las reglas para cortar una etiqueta de publicación y la ventana de soporte.

Esta página se apoya en la evidencia canónica del repositorio: el informe de verificación V1 en `artifacts/g008/workspace-test-report.json`, las tres limitaciones en [`../evidence/limitations.md`](../evidence/limitations.md), las uniones cerradas y las versiones de contrato en el código fuente, y el contrato del adaptador en [`../../packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts). No inventa una política de soporte más amplia de lo que la fuente soporta.

## Línea de publicación (0.x, pre-1.0)

Handoff CMS está en una **línea de publicación 0.x** y es **pre-1.0**. La línea 0.x es la prueba interna (*dogfood*) V1; el despliegue de referencia Cerafica es la evidencia V1. La línea se publica con tres limitaciones deliberadas registradas en [`../evidence/limitations.md`](../evidence/limitations.md):

1. **La ejecución del *daemon* de Docker no estuvo disponible.** La validación de interpolación/configuración Compose, las pruebas de paquetes en tiempo de ejecución y la comprobación sintáctica del *healthcheck* pasaron. Una compilación / ejecución respaldada por un *daemon* de Docker en vivo no es parte de V1.
2. **La accesibilidad es "neurodivergente-accesible por diseño".** Postura interna de diseño V1 (WCAG 2.2 AA + ATAG 2.0 + patrones COGA); la validación externa con participantes es un objetivo v1.1.
3. **Un segundo adaptador independiente es el criterio de conformidad v1.1.** V1 envía un adaptador de referencia; los campos de extensión / capacidad específicos del host del contrato del adaptador siguen siendo provisionales (1.0-beta / RC) hasta que un segundo adaptador los ejercite.

Se cortará una publicación 1.0 cuando se cierre el criterio del segundo adaptador y la afirmación más amplia del tiempo de ejecución Docker quede respaldada por una ejecución respaldada por *daemon* registrada en el artefacto de evidencia. Hasta entonces, la regla de última publicación 0.x es toda la política de soporte.

## Reglas de versionado (0.x → 1.x)

La línea 0.x sigue semántica pre-1.0: el `0` inicial señala una superficie en desarrollo. Dentro de la línea, el proyecto usa la forma `0.x.y` donde:

- **0.x** — un salto menor (p. ej. `0.1.0` → `0.2.0`) es una publicación que añade capacidad tras un contrato existente, abre un nuevo contrato que no rompe el núcleo congelado o envía una revisión verificada de evidencia. Un salto menor puede cambiar comportamiento tras una unión cerrada y marcar una extensión previamente provisional como estable.
- **0.x.y** — un salto de parche (p. ej. `0.1.0` → `0.1.1`) es una publicación que corrige comportamiento dentro del contrato existente sin cambiar ninguna unión cerrada, elimina una limitación documentada o refresca el artefacto de evidencia V1.
- **1.0.0** — un salto mayor es una publicación que congela el contrato 0.x como 1.0, marca el criterio del segundo adaptador como cerrado y envía un artefacto de evidencia de tiempo de ejecución Docker. El salto mayor es la primera publicación en la que el proyecto no es pre-1.0.

La línea 0.x es permisiva en saltos menores y restrictiva en saltos de parche: un salto menor puede introducir una nueva unión cerrada (el barrido de descubrimiento en [`docs-qa.es.md`](docs-qa.es.md) §"Contrato de descubrimiento" audita la nueva fila en el mismo *pull request*) y marcar una extensión provisional como congelada. Un salto de parche no debe introducir una nueva unión cerrada ni cambiar el inventario del barrido de descubrimiento.

El estado pre-1.0 significa que el proyecto puede enviar cambios incompatibles dentro de un salto menor. El inventario de cambios incompatibles es la tabla de uniones cerradas en [`docs-qa.es.md`](docs-qa.es.md) §"Las doce uniones exactas"; una revisora que aprueba un salto menor está aprobando implícitamente un cambio en esa tabla cuando ocurre.

## Ventana de soporte

Se aceptan parches contra la **última etiqueta de publicación 0.x** en el repositorio canónico de Forgejo en <https://git.kyanitelabs.tech/simon/handoff-cms>. El repositorio no mantiene ramas 0.x más antiguas en paralelo: una publicación 0.x.y es la rama soportada hasta que una publicación 0.x.(y+1) la sustituya. La misma política se registra en [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) §"Versiones soportadas y política de versionado" y en [`../../SECURITY.md`](../../SECURITY.md) §"Versiones soportadas y política 0.x".

| Línea de publicación | Soportada | Dónde reportar |
| --- | --- | --- |
| 0.x (solo la última etiqueta de publicación) | Sí | Esta página, a través del canal en [`../../SECURITY.md`](../../SECURITY.md) |
| 0.x más antigua | No — por favor actualiza | Esta página, a través del canal en [`../../SECURITY.md`](../../SECURITY.md) |

La superficie soportada en la última etiqueta de publicación 0.x es la documentación, el código fuente, el artefacto de evidencia y el registro de verificación. El alcance verificado exacto se registra en [`../evidence/verification.md`](../evidence/verification.md) y se reproduce literalmente desde `artifacts/g008/workspace-test-report.json`. Cualquier cosa más allá de ese registro no es una afirmación "soportada".

## Cortar una etiqueta de publicación

Las etiquetas de publicación se cortan en el repositorio canónico de Forgejo. El flujo de publicación es:

1. **Congelar.** Una mantenedora con autoridad de publicación abre una rama `release/<siguiente-versión>` sobre la última `main` que pase la verificación V1. La rama de publicación se corta desde la punta verificada de `main`; el informe de verificación en `artifacts/g008/workspace-test-report.json` es la fuente de verdad de la superficie soportada.
2. **Refrescar la evidencia V1.** La verificación V1 (los siete comandos en [`../how-to/quickstart.es.md`](../how-to/quickstart.es.md) · [EN](../how-to/quickstart.md)) se vuelve a ejecutar sobre la rama de publicación. El informe sustituye al `artifacts/g008/workspace-test-report.json` previo. Las notas de publicación citan los siete comandos literalmente y registran la marca temporal de verificación.
3. **Actualizar la versión.** Cada `package.json` en `packages/*/` se incrementa a la nueva versión `0.x.y`. El `package.json` raíz no rastrea una versión de publicación (es `0.0.0` y `private: true`); la versión de publicación vive en las versiones de los paquetes del *workspace*. El *commit* es un único *commit* atómico sobre la rama de publicación.
4. **Actualizar las uniones cerradas y la evidencia de calidad documental.** Si se introduce una nueva unión cerrada, el *lint* de paridad por descubrimiento en [`docs-qa.es.md`](docs-qa.es.md) §"Contrato de descubrimiento" regenera la tabla de uniones; la página de calidad documental y el catálogo en [`../reference/error-codes.es.md`](../reference/error-codes.es.md) · [EN](../reference/error-codes.md) se actualizan en el mismo *pull request*. Las ediciones manuales del inventario están prohibidas.
5. **Etiquetar y publicar.** Una mantenedora con autoridad de publicación firma la etiqueta usando la clave SSH canónica de Forgejo. El mensaje de la etiqueta registra los siete comandos verificados, las limitaciones trasladadas desde [`../evidence/limitations.md`](../evidence/limitations.md) y el salto de versión. Las notas de publicación son una copia literal del mensaje de la etiqueta más el *diff* de versión por paquete.
6. **Espejo.** El espejo en <https://github.com/simongonzalezdc/handoff-cms> recibe la etiqueta y las notas de publicación por *push* desde Forgejo. El espejo es de solo lectura y no corta etiquetas.

Una publicación que toca código de gobernanza, código de auditoría o la fachada de autoridad lleva la regla explícita de aprobación humana de fusión registrada en [`contributing.es.md`](contributing.es.md) §"Aprobación humana explícita de fusión". Ningún bot, automatización o política de *merge-on-green* puede fusionar una rama de publicación.

## Núcleo congelado frente a extensiones provisionales

El contrato del adaptador es el ejemplo más claro de la división pre-1.0 entre un núcleo congelado y extensiones provisionales. De [`../../packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts):

- **Núcleo congelado (`ADAPTER_SDK_FROZEN_VERSION = "1.0.0"`).** Los campos del contrato `RegionBinding` `canonical_source`, `derived_artifacts[]` y `regeneration_contract`, el modo de regeneración `'alias_symlink'` y las nueve cadenas de `AdapterCapability`. Un cambio en el núcleo congelado es un salto mayor.
- **Extensiones provisionales (`ADAPTER_SDK_EXTENSIONS_VERSION = "1.0.0-rc.1"`).** Las extensiones `FieldCapability` y `DeployCapability` están marcadas como `1.0-beta/RC` y pueden moverse dentro de la línea mayor `1.0.0`. Un cambio que promueve una extensión provisional al núcleo congelado es un salto menor en el SDK y un salto menor en el proyecto.

La misma división se refleja en los paquetes en tiempo de ejecución: el núcleo de gobernanza en `@cms/core` se publica en `0.1.0` y el transporte de API en `@cms/api` se publica en `0.1.0`. Un cambio en el núcleo de gobernanza es un salto menor; un cambio en la unión cerrada `ERROR_CODES` es un cambio de contrato y un salto menor. El paquete de auditoría en `@cms/audit` envía el sobre de auditoría inmutable y no se le permite ampliar la forma del evento de auditoría sin un salto mayor.

## Implementación abierta Apache-2.0 frente a garantías no bloqueables por *paywall*

La publicación V1 es la **implementación abierta Apache-2.0** del sistema. La licencia Apache-2.0 cubre el código bajo `packages/*/src/**`, la documentación bajo `docs/`, el archivo `LICENSE` y la configuración bajo `compose.yaml` y `Dockerfile`. El archivo `LICENSE` es la copia autoritativa; el proyecto no envía una segunda licencia para la implementación abierta. La licencia se documenta en detalle en [`licensing.es.md`](licensing.es.md) · [EN](licensing.md).

Tres garantías en la publicación V1 **no están bloqueadas por *paywall*** y no son separables de la implementación abierta Apache-2.0:

1. **Aprobación humana.** Los ocho invariantes en [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.es.md) · [EN](../concepts/governance-and-human-authority.md) requieren un evento fresco de autorización humana por cada aplicar, publicar y revertir. Una publicación futura puede añadir comodidades de pago alrededor del flujo humano, pero el requisito de que aprobar / publicar / revertir sea solo humano es una propiedad de la implementación abierta y no es separable de ella.
2. **Gobernanza.** El ciclo de vida `proponer → validar → aprobar → publicar → canonical_written → (propagación viva opcional) → revertir`, los ocho invariantes y el motor de política / máquina de estados en `@cms/core` son parte de la implementación abierta. Una publicación futura puede añadir comodidades de pago alrededor de la gobernanza, pero el ciclo de vida, las puertas de política y la máquina de estados no son separables de ella.
3. **Auditoría.** El paquete `@cms/audit`, la exportación NDJSON canónica y el sobre Ed25519 JWS separado son parte de la implementación abierta. El sobre de auditoría se documenta en [`../reference/audit-envelope.es.md`](../reference/audit-envelope.es.md) · [EN](../reference/audit-envelope.md). Una publicación futura puede añadir comodidades de pago alrededor del análisis de auditoría, pero la garantía de auditoría inmutable y la firma verificable sin conexión no son separables de ella.

Las tres garantías no son una lista de excepciones. Son la propiedad que la implementación abierta protege; el núcleo abierto se envía con las protecciones, no detrás de una opción de inclusión. El README en [`../../README.md`](../../README.md) §"Licencia" lleva la misma redacción: la aprobación humana, la gobernanza y la auditoría no están bloqueadas por *paywall*.

## Actualización y reversión

Una actualización es un salto de línea de publicación: 0.x.y → 0.x.(y+1). La ruta de actualización soportada es un `pnpm install` limpio contra la nueva etiqueta, una re-ejecución de la verificación V1 y una transición manual documentada en [`../how-to/operate.es.md`](../how-to/operate.es.md) · [EN](../how-to/operate.md). La ruta de downgrade soportada es revertir la etiqueta de publicación; el estado durable bajo `cms_postgres_data` y `cms_minio_data` es independiente de la versión de la aplicación y se preserva a través del salto. La copia de seguridad y la restauración se documentan en [`../how-to/backup-restore.es.md`](../how-to/backup-restore.es.md) · [EN](../how-to/backup-restore.es.md).

Una reversión gobernada de una propuesta publicada es distinta de una reversión de línea de publicación. La reversión gobernada termina en `canonical_written` (el límite de escritura del adaptador), transita el ciclo de vida de la propuesta gobernada al estado terminal `rolled_back` y se audita como `proposal.rolled_back`. El límite se documenta en [`../concepts/content-boundary.es.md`](../concepts/content-boundary.es.md) · [EN](../concepts/content-boundary.md) y la ruta específica del adaptador Cerafica se documenta en [`../adapters/cerafica.es.md`](../adapters/cerafica.es.md) · [EN](../adapters/cerafica.md).

## Limitaciones

La política de publicación de esta página es acotada. La página no afirma:

- Una fecha de publicación 1.0. El corte 1.0 está condicionado al criterio de conformidad del segundo adaptador y a un artefacto de evidencia de tiempo de ejecución Docker.
- Una línea de soporte a largo plazo anterior a la última 0.x. El repositorio no mantiene ramas 0.x más antiguas en paralelo.
- Un SLA, una fecha de corrección o un cronograma de parche-en-el-día-N. El reporte de vulnerabilidades es privado y se documenta en [`../../SECURITY.md`](../../SECURITY.md) §"Reportar una vulnerabilidad de forma privada".
- Un contrato de soporte comercial. El proyecto envía la implementación abierta Apache-2.0; las comodidades comerciales alrededor de ella están fuera del alcance de esta página.

Las tres limitaciones registradas en [`../evidence/limitations.md`](../evidence/limitations.md) son parte de la política de publicación. No se debilitan ni se resumen por la línea 0.x.

## Citaciones primarias (consultadas el 2026-07-28)

| Tema | Fuente | URL |
| --- | --- | --- |
| Semántica pre-1.0 | Semantic Versioning 2.0.0 | <https://semver.org/spec/v2.0.0.html> |
| Versiones del contrato del adaptador | Metadatos del paquete `@cms/adapter-sdk` | [`../../packages/adapter-sdk/src/index.ts`](../../packages/adapter-sdk/src/index.ts) |
| Alcance verificado V1 | `artifacts/g008/workspace-test-report.json` | artefacto confirmado en la raíz del repositorio |
| Tres limitaciones registradas | [`../evidence/limitations.md`](../evidence/limitations.md) | |
| Aplicación solo humana | [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.es.md) · [EN](../concepts/governance-and-human-authority.md) | |
| Sobre de auditoría | [`../reference/audit-envelope.es.md`](../reference/audit-envelope.es.md) · [EN](../reference/audit-envelope.md) | |
| Tabla de uniones del barrido de descubrimiento | [`docs-qa.es.md`](docs-qa.es.md) §"Las doce uniones exactas" | |
| Licencia | [`../../LICENSE`](../../LICENSE); [`licensing.es.md`](licensing.es.md) · [EN](licensing.md) | |

Una afirmación que depende de una fuente primaria pero no la cita es una falla de calidad documental (DR5).

## Dónde ir a continuación

- Cortar una publicación: esta página, el flujo de salto de versión y el contrato de paridad del barrido de descubrimiento en [`docs-qa.es.md`](docs-qa.es.md) §"Contrato de descubrimiento".
- Auditar la evidencia: [`../evidence/verification.md`](../evidence/verification.md) y [`../evidence/limitations.md`](../evidence/limitations.md) para los siete comandos verificados y las tres limitaciones.
- Detalles de la licencia: [`licensing.es.md`](licensing.es.md) · [EN](licensing.md) para la lista permitida exacta, el comando del guarda, las excepciones MPL-2.0 solo de desarrollo de axe y el límite de implementación abierta Apache-2.0.
- Reportar una vulnerabilidad: [`../../SECURITY.md`](../../SECURITY.md).
