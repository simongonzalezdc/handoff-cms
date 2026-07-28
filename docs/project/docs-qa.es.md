# Calidad documental (Docs QA)

> **Audiencia:** contribuyentes, revisores de código y revisores de seguridad que necesitan el contrato exacto, a prueba de deriva, que los comandos `pnpm docs:check` y `pnpm test:docs` aplican sobre el árbol documental. Esta página es de información orientada (proyecto Diátaxis). Las siete puertas de abajo son el contrato; los archivos de flujo de trabajo en [`.forgejo/workflows/docs-qa.yml`](../../.forgejo/workflows/docs-qa.yml) (canónico) y [`.github/workflows/docs-qa.yml`](../../.github/workflows/docs-qa.yml) (CI espejo) los ejecutan en cada pull request.

> [English version](docs-qa.md) · El inglés y el español son locales pares. Ambos hermanos se envían en el mismo pull request (regla de desfase cero). Ver [`../README.md#desfase-cero-enes-en-el-mismo-pr`](../README.md#desfase-cero-enes-en-el-mismo-pr).

## Alcance y no-objetivos

Esta página define el contrato de calidad documental para el árbol de Handoff CMS. Es la fuente de verdad para los scripts `pnpm docs:check` y `pnpm test:docs`. El alcance del *lint* es delimitado y nombrado:

- **En alcance.** Prosa en Markdown, pares pares EN/ES, estructura de encabezados, enlaces, paridad, frases prohibidas y la referencia cruzada de cada afirmación documentada a una fuente primaria.
- **Fuera de alcance.** Los veredictos de las pruebas en tiempo de ejecución (axe, tastecheck, Playwright) viven en [`../evidence/verification.md`](../evidence/verification.md). Las tres limitaciones reportadas en [`../evidence/limitations.md`](../evidence/limitations.md) se referencian aquí pero no se replantean como una afirmación nueva.

La página no inventa puertas más amplias que el contrato de descubrimiento de la sección siguiente. El barrido de descubrimiento es la única fuente autoritativa para la lista de uniones cerradas que documenta el manual.

## Contrato de descubrimiento

El *lint* de paridad por barrido de descubrimiento escanea `packages/**/src/**/*.ts` en busca de cada arreglo en tiempo de ejecución exportado de unión cerrada `*_ERROR_CODES` / `*_REFUSAL_CODES` y del alias de tipo `*ErrorCode` / `*RefusalCode` correspondiente. El barrido deduplica los *exports* descubiertos y afirma dos cosas:

1. Cada unión cerrada descubierta está documentada en [`../reference/error-codes.md`](../reference/error-codes.md) con el símbolo de fuente exacto y la cuenta exacta.
2. La pertenencia documentada es profundamente igual a la fuente: ninguna entrada documentada que la fuente carezca, ninguna entrada de la fuente que la documentación omita.

La exclusión de auditoría de la documentación es una y solo una: los arreglos en tiempo de ejecución y el agregador `ProblemCode` derivado en `packages/api/src/problem.ts` se declaran en [`../reference/error-codes.md`](../reference/error-codes.md) fila 13 como "derivado" y no se cuentan como una decimotercera unión. Cualquier otra unión no surgida del barrido se trata como no documentada.

## Las doce uniones exactas

La tabla de fuente de verdad vive en [`../reference/error-codes.md`](../reference/error-codes.md). La página de calidad documental refleja los nombres de las uniones y los símbolos de la fuente, no la pertenencia por código, porque la pertenencia es lo que verifica el barrido de descubrimiento.

| # | Unión | Paquete | Símbolo de fuente |
| --- | --- | --- | --- |
| 1 | Core | `@cms/core` | `ERROR_CODES` |
| 2 | Storage | `@cms/storage` | `StorageErrorCode` |
| 3 | API | `@cms/api` | `API_ERROR_CODES` |
| 4 | CLI | `@cms/cli` | `CliErrorCode` |
| 5 | Web store | `@cms/web` | `STORE_ERROR_CODES` |
| 6 | Media blob store | `@cms/media` | `BLOB_STORE_ERROR_CODES` |
| 7 | Media pipeline | `@cms/media` | `MEDIA_PIPELINE_ERROR_CODES` |
| 8 | Server runtime | `@cms/server` | `SERVER_ERROR_CODES` |
| 9 | Server config | `@cms/server` | `SERVER_CONFIG_ERROR_CODES` |
| 10 | Server auth | `@cms/server` | `SERVER_AUTH_ERROR_CODES` |
| 11 | Adapter SDK | `@cms/adapter-sdk` | `ADAPTER_REFUSAL_CODES` |
| 12 | Cerafica symlink | `@cms/adapter-cerafica` | `SYMLINK_REFUSAL_CODES` |

El *lint* descubridor es el único sistema que puede añadir una decimotercera fila. Las ediciones manuales a esta tabla no se aceptan; la tabla se regenera desde el barrido de descubrimiento en el mismo pull request que registra la nueva unión.

## Responsables de carril (nombrados para ambos locales)

Cada nombre de carril de abajo identifica a un responsable humano único para la versión inglesa y la versión en español de la página. El mismo responsable se nombra en la página en español; el responsable de la ES es un revisor hispanohablante que firma el uso neutral y de glosario del español. La convención de responsable refleja la regla de desfase cero EN/ES en el mismo PR en [`../README.md`](../README.md) §"Desfase cero EN/ES en el mismo PR". Los responsables se reconocen por el **carril** que custodian, no por un *@handle* de GitHub:

| Carril | Rol de responsable | Pares cubiertos |
| --- | --- | --- |
| `docs:parity` | Custodio de paridad documental | `docs/project/docs-qa.md`, `docs/project/docs-qa.es.md` |
| `docs:glossary` | Custodio de glosario | `docs/project/glossary.md`, `docs/project/glossary.es.md` |
| `docs:contributing` | Custodio de contribución | `docs/project/contributing.md`, `docs/project/contributing.es.md` |
| `docs:security` | Custodio de seguridad (emparejado con la audiencia de revisor de seguridad) | `docs/security/*.md`, `docs/security/*.es.md` |
| `docs:api` | Custodio de referencia de API | `docs/reference/api.md`, `docs/reference/api.es.md`, `docs/reference/error-codes.md`, `docs/reference/error-codes.es.md` |
| `docs:architecture` | Custodio de arquitectura | `docs/concepts/*.md`, `docs/concepts/*.es.md` |
| `docs:howto` | Custodio de guías prácticas | `docs/how-to/*.md`, `docs/how-to/*.es.md` |
| `docs:overview` | Custodio de visión general | `docs/overview.md`, `docs/overview.es.md`, `docs/README.md`, `docs/README.es.md` |

El rol de responsable es una responsabilidad nombrada, no un *@handle*. Un revisor que aprueba el cambio firma como el rol. La descripción del rol es el registro durable; el rol se registra en el árbol documental, no en un *tracker* aparte.

## SLO de desfase cero EN/ES en el mismo PR

El objetivo de nivel de servicio es **cero desfase en español**: cada página dirigida al usuario que cambie en un PR incluye su par EN/ES en ese mismo PR.

- **Desfase cero.** El trabajo de CI del PR pasa el commit base a `docs:check`; la puerta de archivos cambiados rechaza un par modificado sin su hermano.
- **Mismo PR.** Ambos pares se revisan y fusionan juntos. Los commits individuales pueden reorganizarse durante la revisión; el PR es el límite aplicado.
- **Sin fallback silencioso.** El español es un par coautor. La paridad mecánica no sustituye la revisión del significado en español neutral ni el uso del glosario.

Una ejecución local sin entrada base informa esta puerta como `SKIP`, nunca como `PASS`. Los flujos de PR de Forgejo canónico y del espejo GitHub proporcionan el commit base y tratan cualquier desajuste como bloqueante.

## Las siete puertas

`pnpm docs:check` aplica DR1–DR7 y SRC1. `pnpm test:docs` ejercita las implementaciones de las puertas con fixtures adversariales.

### DR1 — Integridad de enlaces

Cada enlace Markdown relativo y cada fragmento del árbol documental se resuelve:

- Un destino relativo `./` o `../` debe existir en el repositorio.
- Un fragmento interno o entre páginas debe coincidir con un encabezado renderizado.
- Los fragmentos de líneas de código como `#L82-L102` los valida el host de código, no se interpretan como encabezados Markdown.

El lint funciona sin red y omite deliberadamente destinos `http:`, `https:`, `mailto:` y `ftp:`. Las URL de fuentes primarias se revisan con su fecha de recuperación; CI no afirma ejecutar una sonda web en vivo.

### DR2 — Paridad EN/ES

Cada página dirigida al usuario dentro de `docs/` tiene un par `*.md` / `*.es.md`, salvo una lista pequeña de exclusiones revisadas. El lint comprueba:

- la misma forma y orden de niveles de encabezado, permitiendo texto traducido;
- prosa sustancialmente distinta con señales de español, no una copia inglesa;
- presencia del par y la topología de enlaces DR3 separada.

Los bloques de código pueden compartirse literalmente. Cualquier fallo bloquea el PR.

### DR3 — Paridad de enlaces

Los pares EN y ES exponen conjuntos equivalentes de destinos relativos después de normalizar `foo.es.md` a su par `foo.md` e ignorar fragmentos de encabezados traducidos. Un destino ausente o adicional es bloqueante.

### DR4 — Frases prohibidas

Se bloquean afirmaciones de runtime no acotadas que usen la lista cerrada de política del proyecto:

- `production-hardened`
- `fully validated`
- `deployed at scale`
- `battle-tested`
- `enterprise-grade`
- `mission-critical`

Las páginas de política pueden citar la lista como ejemplos negativos; `enterprise-grade documentation` describe el estándar documental, no evidencia del runtime.

### DR5 — Cita de afirmación / fuente

Una página que use términos de evidencia positiva como `verified`, `passed`, `tested` o `supported` debe contener una cita local de procedencia bajo `docs/`, `packages/`, `artifacts/` o `scripts/`. Encabezados, filas de listas de evidencia, bloques de código y citas negativas de política no se tratan como afirmaciones de capacidad. La ausencia de procedencia a nivel de página es bloqueante.

### DR6 — Fuente segura para secretos

El lint examina el árbol documental en busca de marcadores de clave privada, cadenas con forma de JWT, formas de token GitHub, claves de acceso AWS, URL de base de datos con credenciales, valores bearer y UUID que no sean placeholders. Se permiten placeholders documentados como el UUID de ceros y `replace-with-*`. Es una puerta regex conservadora, no una garantía de reconocer todo formato de secreto; sigue siendo obligatoria la revisión humana. Consulta [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md).

### DR7 — Descubrimiento OpenAPI

[`../reference/openapi.json`](../reference/openapi.json) es un artefacto derivado de conveniencia; `packages/api/src/openapi.ts` sigue siendo la fuente de verdad. La puerta valida:

- forma raíz JSON con declaración OpenAPI `3.1.x`, `info.title` / `info.version` no vacíos y objeto `paths`;
- paridad bidireccional exacta de método + ruta + `operationId` con las ocho operaciones API documentadas;
- rechazo de entradas ausentes, adicionales, con método incorrecto o ID de operación incorrecto.

Es una comprobación estructural y contractual enfocada, no un validador completo de JSON Schema OpenAPI de terceros.

### Puerta de código fuente (acompañante)

`SRC1` descubre arrays cerrados exportados `*_ERROR_CODES` / `*_REFUSAL_CODES` y alias de tipo `*ErrorCode` / `*RefusalCode` en `packages/**/src/**/*.ts`. Compara los 10 arrays de runtime y las 12 superficies de tipo descubiertas con el inventario revisado, falla ante cualquier unión nueva o ausente y verifica que cada miembro de array, más los miembros solo de tipo `StorageErrorCode` y `CliErrorCode`, aparezca en las referencias de códigos EN y ES. `@cms/audit` es la exclusión explícita basada en fuente porque no tiene una unión cerrada de códigos de error.

## Limitaciones

La puerta de calidad documental no establece:

- corrección sustantiva de la prosa más allá de comprobaciones mecánicas y de paridad con fuente;
- comportamiento del runtime más allá de la evidencia `g008` registrada por separado;
- que una persona concreta o una revisora hispanohablante haya realizado la revisión requerida;
- disponibilidad o contenido actuales de URL externas;
- runtime Docker respaldado por daemon, validación de accesibilidad con participantes externos ni validación de un segundo adaptador.

Son límites de evidencia, no fallbacks silenciosos.

## Citas primarias (recuperadas el 2026-07-28)

Las puertas de arriba se apoyan en un conjunto pequeño de fuentes primarias nombradas. La fecha de recuperación es 2026-07-28.

| Puerta | Fuente | URL |
| --- | --- | --- |
| Justificación de paridad DR2 | Contrato de paridad de `@cms/i18n` (`assertCatalogParity`) | `packages/i18n/src/index.ts` |
| Lista de adjetivos DR4 | Política del proyecto Handoff CMS | Este documento; la lista es una convención del repositorio, no un estándar de OWASP |
| Registro de evidencia DR5 | `artifacts/g008/workspace-test-report.json` | artefacto comprometido en la raíz del repositorio |
| Política de secreto seguro DR6 | OWASP — Secrets Management Cheat Sheet | <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html> |
| Esquema OpenAPI DR7 | OpenAPI Initiative — OpenAPI Specification 3.1.0 | <https://spec.openapis.org/oas/v3.1.0> |
| Contrato de descubrimiento | Diátaxis — modos de documentación | <https://diataxis.fr/> |
| Regla de desfase cero en el mismo PR | Política del proyecto Handoff CMS | Este documento; GitHub/Forgejo ofrecen la mecánica de PR, pero no definen la política de locales |

Una afirmación que depende de una fuente primaria pero no la cita es una falla de calidad documental. La fecha de recuperación es la fecha en que el enlace resolvió; la puerta es el contrato que requiere que el enlace esté ahí.

## Cómo correr la calidad documental localmente

Los dos scripts son el contrato para el motor de calidad documental. La rebanada del motor los implementa; esta página documenta lo que hacen:

```sh
pnpm docs:check   # DR1 integridad de enlaces, DR2 paridad, DR3 paridad de enlaces, DR4 frases prohibidas, DR5 citas, DR6 secretos, DR7 OpenAPI
pnpm test:docs    # paridad del barrido de descubrimiento + auditoría de pertenencia de las doce uniones (SRC1)
```

Ambos scripts devuelven un código de salida distinto de cero ante un fallo bloqueante. La salida de `pnpm docs:check` es una lista numerada de fallos de puerta; la salida de `pnpm test:docs` es la tabla de uniones descubiertas con estado. Los scripts no son corredores de pruebas; no tocan las pruebas en tiempo de ejecución en `packages/*/test/**`.

## Dónde ir a continuación

- Autorando una contribución: [`contributing.md`](contributing.md) · [`contributing.es.md`](contributing.es.md) para el flujo de trabajo, el modelo de rama y las convenciones de *commit*.
- Auditando la evidencia: [`../evidence/verification.md`](../evidence/verification.md) y [`../evidence/limitations.md`](../evidence/limitations.md) para los siete comandos verificados y las tres limitaciones.
- Revisando el vocabulario controlado del GLOSARIO: [`glossary.md`](glossary.md) · [`glossary.es.md`](glossary.es.md) para el contrato término por término EN/ES.
