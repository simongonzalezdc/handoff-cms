# Licencias

> [English version](licensing.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo *pull request* (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).
>
> **Audiencia:** operadoras, integradoras, revisoras de seguridad y contribuyentes que necesitan el límite exacto de la licencia, la lista permitida que el *workspace* aplica, el comando del guarda de licencias que la aplica y las excepciones documentadas solo de desarrollo. Esta página es informativa (proyecto Diátaxis). La copia autoritativa de la licencia del núcleo abierto es el archivo [`../../LICENSE`](../../LICENSE) en la raíz del repositorio; esta página resume el límite y apunta a la lista permitida y al guarda.

La página se apoya en tres artefactos fuente de verdad:

- El texto Apache-2.0 en [`../../LICENSE`](../../LICENSE).
- La lista permitida enviada en [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json), cargada en tiempo de ejecución como la única fuente de política autoritativa por [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts).
- El comando del guarda de licencias y su alcance verificado en `artifacts/g008/workspace-test-report.json` y en [`../how-to/quickstart.es.md`](../how-to/quickstart.es.md) §"Los siete comandos verificados".

La página no inventa una lista permitida más amplia, una lista de excepciones más amplia ni un comando de guarda diferente. La lista permitida enviada, el comando del guarda y las excepciones solo de desarrollo de axe son el contrato.

## Licencia del núcleo abierto (Apache-2.0)

Handoff CMS está licenciado bajo la Apache License, Version 2.0. El texto autoritativo es [`../../LICENSE`](../../LICENSE); el proyecto no envía una segunda licencia para la implementación abierta. La licencia Apache-2.0 cubre el código bajo `packages/*/src/**`, la documentación bajo `docs/`, el propio archivo `LICENSE` y la configuración bajo `compose.yaml` y `Dockerfile`. Cada `package.json` bajo `packages/*/package.json` declara `"license": "Apache-2.0"` (las líneas relevantes están en `packages/*/package.json:6`); el `package.json` raíz declara la misma licencia en la línea 6. El `Dockerfile` etiqueta la imagen de tiempo de ejecución con `org.opencontainers.image.licenses="Apache-2.0"` (ver `Dockerfile:158-159`).

El README en [`../../README.md`](../../README.md) §"Licencia" lleva la misma redacción: el núcleo Apache-2.0 agrupa la API, CLI, MCP, autoalojamiento, Handoff Beat, accesibilidad, gobernanza de proponer / aprobar y auditoría. La aprobación humana, la gobernanza y la auditoría **no** están bloqueadas por *paywall*; el núcleo abierto se envía con las protecciones, no detrás de una opción de inclusión. La misma afirmación se reitera en [`release-versioning.es.md`](release-versioning.es.md) §"Implementación abierta Apache-2.0 frente a garantías no bloqueables por *paywall*" con una explicación por garantía.

La pregunta sobre el Contributor License Agreement se responde en [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) §"Licencia": no se requiere un CLA separado, y al enviar una contribución la contribuyente acepta que la contribución se licencia bajo los mismos términos Apache-2.0. La misma redacción se refleja en [`contributing.es.md`](contributing.es.md) §"Licencia".

## La lista permitida exacta

La lista permitida de licencias en tiempo de ejecución es el conjunto cerrado de identificadores SPDX que el guarda de licencias acepta. La lista autoritativa es el archivo JSON en [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json), enviado con el guarda y cargado como la única fuente de verdad. La lista permitida actual (confirmada en el repositorio) es:

| Identificador SPDX | Notas |
| --- | --- |
| `Apache-2.0` | La licencia del proyecto y la licencia dominante en tiempo de ejecución. |
| `MIT` | Permitida para dependencias en tiempo de ejecución. |
| `BSD-2-Clause` | Permitida para dependencias en tiempo de ejecución. |
| `BSD-3-Clause` | Permitida para dependencias en tiempo de ejecución. |
| `ISC` | Permitida para dependencias en tiempo de ejecución. |

La lista permitida es un conjunto cerrado. El predeterminado conservador documentado del guarda es que cualquier excepción `SPDX-WITH` cuyo identificador de excepción no esté en la matriz `withExceptions` hace que el paquete sea rechazado; la matriz `withExceptions` enviada es `[]` (vacía). Añadir una nueva entrada a la matriz `allowed` o a la matriz `withExceptions` es un cambio de contenido que aterriza en el mismo *pull request* que el cambio que lo requiere. El contrato en tiempo de ejecución se aplica en [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) `loadAllowlist` y `expressionAllowed`; la prueba en [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"ships a conservative empty WITH exception list that pins documented rejection" afirma el invariante de `withExceptions` vacío.

La lista de rechazo del guarda es el conjunto conservador que la política del núcleo abierto rechaza de forma predeterminada, incluso cuando la lista permitida se amplía por error. La lista de rechazo es el conjunto cerrado declarado en [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) y reproducido aquí:

- `GPL-2.0-only`, `GPL-2.0-or-later`
- `GPL-3.0-only`, `GPL-3.0-or-later`
- `AGPL-3.0-only`, `AGPL-3.0-or-later`
- `SSPL-1.0`
- `Proprietary`

Un paquete que declara cualquiera de los identificadores de la lista de rechazo falla de forma cerrada bajo el guarda con `reason: "denied-license"`. Un paquete que declara un identificador de licencia que el guarda no reconoce falla de forma cerrada con `reason: "unknown-license"`. Un paquete sin metadatos de licencia falla de forma cerrada con `reason: "missing-license"`. Un paquete que el guarda no puede inspeccionar falla de forma cerrada bajo modo estricto con `reason: "uninspectable"`. Los cuatro modos de fallo son la unión cerrada declarada en [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) como `FindingReason = "missing-license" | "unknown-license" | "denied-license" | "uninspectable"`.

## El comando exacto del guarda

El comando del guarda de licencias es la costura verificada entre la lista permitida enviada y la evidencia de la publicación V1. El comando exacto, copiado literalmente de [`../how-to/quickstart.es.md`](../how-to/quickstart.es.md) §"Los siete comandos verificados" y de `artifacts/g008/workspace-test-report.json` `results[3]`, es:

```sh
node packages/licensing-guard/dist/index.js --root . --json
```

El alcance verificado registrado en el informe V1 es **14 paquetes, 0 hallazgos**. El comando se ejecuta desde la raíz del repositorio y escribe un informe JSON en stdout cuando se establece el indicador `--json`; sin `--json` el guarda escribe un informe legible para humanos. El guarda sale con `0` en una ejecución limpia y con `1` cuando hay un hallazgo. El indicador `--root` acepta un directorio raíz personalizado; el predeterminado es el directorio de trabajo actual. El indicador `--non-strict` desactiva el hallazgo `uninspectable` de fallo cerrado para dependencias declaradas pero ausentes; la ejecución verificada V1 usa el modo estricto (el predeterminado).

El guarda escanea cada `package.json` del *workspace* alcanzable desde la raíz elegida (incluyendo `packages/*/package.json`) y recorre los cierres de `dependencies`, `devDependencies`, `optionalDependencies` y `peerDependencies` de cada paquete. El recorrido resuelve cada dependencia declarada a su `package.json` real mediante resolución consciente de pnpm (las mismas reglas de resolución que usaría `createRequire` de la importadora) e inspecciona el campo `license` del manifiesto contra la lista permitida. El recorrido es seguro frente a ciclos mediante un conjunto `visited` indexado por la ruta del manifiesto resuelto; la prueba en [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"follows a workspace cycle A→B→A without infinite recursion" ancla este comportamiento.

## Las excepciones MPL-2.0 solo de desarrollo de axe

La lista permitida en tiempo de ejecución es Apache/MIT/BSD/ISC. Dos paquetes en el workspace — `@axe-core/playwright` y `axe-core` — se admiten como excepciones documentadas **MPL-2.0 solo de desarrollo** a esa lista permitida, con la justificación exacta que registra la declaración de accesibilidad V1. La lista de excepciones es la matriz `devToolExceptions` en [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json):

| Paquete | Licencia | Justificación |
| --- | --- | --- |
| `@axe-core/playwright` | `MPL-2.0` | Herramienta de auditoría del navegador WCAG 2.2 AA solo de pruebas; no se envía en el núcleo funcional. |
| `axe-core` | `MPL-2.0` | Motor transitivo de la auditoría del navegador WCAG 2.2 AA solo de pruebas; no se envía en el núcleo funcional. |

La excepción se admite solo en la ruta solo de desarrollo. El guarda reconoce una excepción de herramienta de desarrollo cuando se cumplen tres condiciones: (a) la dependencia es alcanzable exclusivamente a través de un cierre `devDependencies` propiedad del *workspace*, (b) la licencia declarada coincide con el campo `license` de la excepción y (c) el nombre de dependencia solicitado coincide exactamente con el campo `package` de la excepción. Una dependencia con licencia incorrecta, nombre parecido o promovida a tiempo de ejecución es rechazada (ver los casos de prueba en [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"rejects wrong-license and lookalike dev tools instead of broadening the exception" y §"rejects the audited Axe packages when promoted to a runtime dependency"). La excepción está acotada al desarrollo; el tiempo de ejecución de producción no incluye ninguno de los dos paquetes, y el cliente de autoría desplegado no envía una dependencia MPL-2.0. La misma redacción se lleva en [`../accessibility/statement.es.md`](../accessibility/statement.es.md) §"Evidencia del navegador (axe)".

## Límite entre el núcleo abierto y el proyecto

La implementación abierta Apache-2.0 cubre:

- El código fuente bajo `packages/*/src/**` y la configuración `tsconfig.json` del *workspace*.
- El código de pruebas bajo `packages/*/test/**` y el arnés e2e bajo `packages/web/e2e/**`.
- La documentación bajo `docs/**` y los archivos raíz `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` y `SUPPORT.md`.
- La configuración de compilación bajo `Dockerfile`, `compose.yaml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` y el `package.json` raíz.
- El propio guarda de licencias: la lista permitida, la fuente del guarda y la prueba del guarda.

Lo siguiente está fuera del límite Apache-2.0 y no es parte de la publicación V1:

- **Sitios web de terceros.** La declaración de accesibilidad y la página de arquitectura apuntan a fuentes primarias (W3C, IETF, Diátaxis, OWASP, RFC 9457); el proyecto no redistribuye esas fuentes y la licencia Apache-2.0 no las cubre.
- **Despliegues del host del operador.** El despliegue del sitio web / repositorio / base de datos / CMS destino del host es propiedad de la operadora y no es parte del núcleo abierto Apache-2.0. El CMS envía la garantía de gobernanza y auditoría; el contenido canónico permanece en el host.
- **Módulos que no son Apache-2.0.** Un módulo que no está bajo Apache-2.0 no es parte del núcleo abierto. La herramienta axe MPL-2.0 solo de desarrollo se admite bajo la política `devToolExceptions` anterior y está ausente del tiempo de ejecución de producción.
- **Comodidades comerciales alrededor del núcleo abierto.** Una publicación futura puede añadir comodidades de pago alrededor de la aprobación humana, la gobernanza o la auditoría, pero las protecciones en sí mismas — aplicar / publicar / revertir solo humano, los ocho invariantes, el sobre de auditoría inmutable — son propiedades de la implementación abierta y no son separables de ella. El límite se afirma en [`../../README.md`](../../README.md) §"Licencia" y en [`release-versioning.es.md`](release-versioning.es.md) §"Implementación abierta Apache-2.0 frente a garantías no bloqueables por *paywall*".

## Verificar el límite de la licencia

Ejecuta el comando del guarda de licencias desde la raíz del repositorio y verifica que el resultado es `0 hallazgos`:

```sh
node packages/licensing-guard/dist/index.js --root . --json
```

Una ejecución limpia escribe un objeto JSON con `ok: true`, `findings: []` y `packages: 14` (el conteo de archivos `package.json` del *workspace* alcanzables desde la raíz). Una ejecución no limpia escribe un objeto JSON con `ok: false` y una matriz `findings`; cada hallazgo lleva `package`, `version`, `path`, `license` (cuando está disponible) y `reason` (`missing-license`, `unknown-license`, `denied-license` o `uninspectable`). El código de salida del comando es `0` en una ejecución limpia y `1` cuando hay un hallazgo. El comando es uno de los siete comandos verificados registrados en [`../how-to/quickstart.es.md`](../how-to/quickstart.es.md) §"Los siete comandos verificados" y en `artifacts/g008/workspace-test-report.json` `results[3]`. El mismo comando se ejecuta en la secuencia de inicio rápido de siete comandos; el proyecto no envía un segundo script de verificación de licencias.

Los invariantes de conteo de paquetes y de hallazgos del guarda se anclan mediante la prueba en [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) §"exposes the shipped allowlist as the authoritative policy source" (la lista permitida es la única fuente de verdad y las excepciones solo de desarrollo de axe son la única forma de excepción). El alcance verificado V1 es `14 paquetes del workspace, 0 hallazgos`; cualquier deriva de ese alcance es un fallo del guarda de licencias y un bloqueador de publicación.

## Límite *source-safe* (sin secretos, sin afirmación)

El límite de la licencia no se extiende a secretos de la operadora, *hostnames* de la operadora o trazas copiadas del tiempo de ejecución. La política cerrada *source-safe* está en [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md); el tiempo de ejecución redacta `accessKeyId`, `secretAccessKey` y la contraseña de la URL de base de datos antes de cualquier registro del operador (ver [`../../packages/server/src/config.ts`](../../packages/server/src/config.ts) `describeServerConfig`). Una página que envíe una credencial real, un identificador de inquilino real o una línea de registro copiada no es una violación de "licencia" sino una violación *source-safe*, y la puerta de seguridad de secretos ([`docs-qa.es.md`](docs-qa.es.md) §"DR6 — Fuente segura de secretos") bloquea el *pull request*.

## Citaciones primarias (consultadas el 2026-07-28)

| Tema | Fuente | URL |
| --- | --- | --- |
| Texto Apache-2.0 | [`../../LICENSE`](../../LICENSE) | <https://www.apache.org/licenses/LICENSE-2.0> |
| Lista permitida enviada | [`../../packages/licensing-guard/allowlist.json`](../../packages/licensing-guard/allowlist.json) | |
| Fuente del guarda | [`../../packages/licensing-guard/src/index.ts`](../../packages/licensing-guard/src/index.ts) | |
| Pruebas del guarda | [`../../packages/licensing-guard/test/license.test.ts`](../../packages/licensing-guard/test/license.test.ts) | |
| Alcance verificado V1 | `artifacts/g008/workspace-test-report.json` | artefacto confirmado en la raíz del repositorio |
| Justificación de axe solo de desarrollo | [`../accessibility/statement.es.md`](../accessibility/statement.es.md) §"Evidencia del navegador (axe)" | |
| Garantías no bloqueables por *paywall* | [`../../README.md`](../../README.md) §"Licencia" y [`release-versioning.es.md`](release-versioning.es.md) §"Implementación abierta Apache-2.0 frente a garantías no bloqueables por *paywall*" | |
| Política *source-safe* | [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md) | |
| Espejo de descubribilidad | `LICENSE` y el repositorio canónico en <https://git.kyanitelabs.tech/simon/handoff-cms> | |

Una afirmación que depende de una fuente primaria pero no la cita es una falla de calidad documental (DR5).

## Dónde ir a continuación

- Verificar el límite: ejecuta el comando del guarda anterior y compara el resultado con el alcance verificado V1 de `14 paquetes, 0 hallazgos`.
- Cortar una publicación: [`release-versioning.es.md`](release-versioning.es.md) para el flujo de salto de versión y la semántica pre-1.0.
- Revisión *source-safe*: [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md) y la lista de comprobación de revisión segura de secretos dentro de ella.
- Reportar una pregunta sobre la licencia o una dependencia que no sea Apache-2.0: abre un *issue* en el repositorio canónico de Forgejo.
