# Declaración de accesibilidad

> [English version](statement.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

Esta página es la declaración de accesibilidad de V1 de Handoff CMS. Describe los estándares que el proyecto asume, las referencias de diseño que guiaron la superficie de autoría, la evidencia automatizada que respalda la afirmación y las limitaciones de v1.1 que la acotan. No es una página de marketing; no reclama validación externa del diseño neurodivergente-accesible.

## Alcance

Esta declaración cubre la superficie de autoría del núcleo abierto: el Handoff Beat, los pares inglés/español con conmutación de locale, los contratos del árbol de accesibilidad y las verificaciones automáticas que se ejecutan sobre ellos. No cubre sitios de terceros, el despliegue del operador en el host, ni módulos que no sean Apache-2.0.

## Estándares y referencias de diseño

La superficie de autoría se construye contra las siguientes fuentes primarias, consultadas el 2026-07-28.

- **Conformidad con WCAG 2.2.** Las Pautas de Accesibilidad para el Contenido Web 2.2 del W3C son el objetivo de conformidad para el cliente de autoría. El nivel objetivo es AA. <https://www.w3.org/TR/WCAG22/>
- **ATAG 2.0 (Pautas de Accesibilidad para Herramientas de Autoría).** Dado que el Handoff Beat es una herramienta de autoría, el proyecto sigue ATAG 2.0 para la superficie de autor. <https://www.w3.org/TR/ATAG20/>
- **W3C COGA — Hacer que el contenido sea utilizable para personas con discapacidades cognitivas y de aprendizaje.** Los patrones de diseño de accesibilidad cognitiva del W3C COGA inspiran las ayudas de baja distracción, movimiento reducido, lenguaje claro y operaciones reversibles. <https://www.w3.org/TR/coga-usable/>

Las citas siguen el mismo patrón disciplinado que el resto del árbol documental; véase [`../README.md`](../README.md). Toda afirmación que dependa de una fuente primaria se cita en línea.

## Texto literal de V1

El estado del proyecto se captura en el catálogo de i18n. El texto literal utilizado en todo el producto es:

> **"neurodivergent-accessible by design"** (accesible para personas neurodivergentes por diseño)

Es una postura de diseño, no un reclamo de validación externa con participantes. El texto literal del catálogo en español es:

> **"Diseñado para uso con teclado, lector de pantalla y baja distracción. La validación externa está prevista para la v1.1."**

El catálogo y los archivos de evidencia del navegador citan estas dos frases de forma textual; no las parafrasee en material derivado. Véase el catálogo en inglés en `packages/i18n/src/index.ts` y la evidencia del navegador en `artifacts/g008/desktop/handoff-beat-en.json` (y los artefactos equivalentes en `tablet` y `mobile`).

## Evidencia del navegador (axe)

El recorrido del Handoff Beat V1 lo ejecuta Playwright Chromium en tres tamaños de viewport (escritorio, tableta, móvil) y dos locales (inglés, español). Cada ejecución captura:

- un escaneo de axe-core con el conjunto de reglas publicado por `@axe-core/playwright`,
- una instantánea del árbol de accesibilidad,
- una captura de pantalla completa,
- una transcripción de la automatización,
- una verificación de `html[lang]` adaptado al locale,
- un veredicto de Tastecheck.

El estado verificado en `2026-07-27T21:18:49.543Z` (artefacto `artifacts/g008/workspace-test-report.json`) reporta **cero infracciones de axe** en los seis proyectos (escritorio/tableta/móvil × en/es). Los artefactos equivalentes del navegador están en `artifacts/g008/{desktop,tablet,mobile}/handoff-beat-{en,es}.{json,png}`.

La dependencia de primer nivel, solo-nodo, usada para el escaneo de axe es `@axe-core/playwright`. El grafo de dependencias es intencional: la lista permitida de licencias en tiempo de ejecución es Apache/MIT/BSD/ISC, y tanto `@axe-core/playwright` como la herramienta subyacente `axe-core` se admiten como excepciones documentadas solo de desarrollo bajo MPL-2.0 a esa lista permitida. El guardia de licencias forma parte de la evidencia verificada del monorepo (`node packages/licensing-guard/dist/index.js --root . --json` — 14 paquetes, 0 hallazgos). Ambas excepciones se limitan al desarrollo y están ausentes del entorno de producción; ninguna dependencia MPL-2.0 se publica con el cliente de autoría desplegado. Véase [`../how-to/quickstart.md`](../how-to/quickstart.md) para el comando del guardia de licencias y el resto del conjunto verificado.

## Qué hace la superficie V1

- **Puntos de referencia semánticos nativos y controles etiquetados reales.** La plantilla de autoría usa controles de formulario reales con etiquetas, puntos de referencia nativos y la misma superficie en inglés y español. El árbol de accesibilidad es el contrato que verifica la evidencia del navegador.
- **Alcance por teclado y gestión del foco.** El recorrido es completo por teclado: mueve el foco, lo restaura tras los comandos y lo lleva al resumen de errores cuando una acción se bloquea.
- **Paridad de locales pares.** El inglés y el español son pares; los valores faltantes se rechazan, nunca se completan silenciosamente. La verificación de paridad del traductor (`assertCatalogParity` en `@cms/i18n`) falla la compilación si faltan claves.
- **Operaciones reversibles.** Un deshacer local, con límites claros, revierte ediciones no enviadas; una reversión (rollback) autorizada por separado revierte una propuesta confirmada. Son dos operaciones distintas y la superficie de autoría nunca ofrece la reversión gobernada como un botón.
- **Lenguaje claro y preferencias de baja distracción.** Las preferencias de movimiento reducido y baja distracción son ajustes explícitos del autor; el recorrido las respeta.
- **Anuncios en regiones en vivo.** Los estados de éxito y error se anuncian por regiones en vivo con cortesía; los errores se resumen en una sola región y el foco salta a esa región.

## Lo que V1 no afirma

- **Sin afirmación de accesibilidad externa.** El producto no se presenta como externamente validado para ninguna población específica de accesibilidad. El texto literal del catálogo es “neurodivergent-accessible by design” y la limitación de v1.1 es “External validation is planned for v1.1.” No exhiba en marketing frases que vayan más allá.
- **Sin conformidad de un segundo adaptador.** Un segundo adaptador independiente es la puerta de conformidad de v1.1, no un reclamo de cierre de V1. El núcleo invariante del contrato del adaptador está congelado, pero la evidencia del segundo adaptador no está en V1.
- **Sin cobertura certificada externa.** La conformidad con WCAG 2.2 AA es el objetivo; se afirma mediante verificaciones automatizadas y de CI (axe-core, alcance por teclado, paridad de locales), no por una auditoría externa de accesibilidad.

## Seguimientos en v1.1

1. Validación externa con participantes para el diseño neurodivergente-accesible.
2. Un segundo adaptador independiente que lleve los campos del contrato (`field_capabilities`, `DeployCapability`) de 1.0-beta/RC a 1.0.
3. Cualquier hallazgo de la revisión del sobre de auditoría del revisor de seguridad que afecte a las afirmaciones de accesibilidad.

## Evidencia

- W3C — Web Content Accessibility Guidelines (WCAG) 2.2 — <https://www.w3.org/TR/WCAG22/>
- W3C — Authoring Tool Accessibility Guidelines (ATAG) 2.0 — <https://www.w3.org/TR/ATAG20/>
- W3C — Making Content Usable for People with Cognitive and Learning Disabilities (COGA) — <https://www.w3.org/TR/coga-usable/>
- Texto literal del catálogo V1 — `packages/i18n/src/index.ts`
- Evidencia del navegador — `artifacts/g008/{desktop,tablet,mobile}/handoff-beat-{en,es}.{json,png}`
- Informe de verificación del monorepo — `artifacts/g008/workspace-test-report.json`
- Guardia de licencias — `packages/licensing-guard/`
