# Documentación

Este directorio es el mapa autoritativo de cada página de prosa que envía el proyecto. Úsalo como puerta de entrada al sistema documental; el README es la puerta de entrada al proyecto.

> [English version](README.md) · Las versiones inglesa y española se envían en el mismo *pull request* (regla de desfase cero). Ver [Desfase cero EN/ES en el mismo PR](#desfase-cero-enes-en-el-mismo-pr) más abajo.

## Disciplina de fuente y afirmación

Cada afirmación de cada página se rastrea hasta una de tres fuentes:

1. **Código fuente bajo `packages/*/src/**`.** Las páginas de referencia nombran la unión exacta que reflejan (`API_ERROR_CODES` en `packages/api/src/problem.ts:38-62`, `STORE_ERROR_CODES` en `packages/web/src/model.ts:111-133`, etc.). El *lint* de paridad, dirigido por un descubrimiento, explora `packages/**/src/**/*.ts` en busca de *arrays* de tiempo de ejecución exportados y cerrados `*_ERROR_CODES` / `*_REFUSAL_CODES`, y de alias de tipo `*ErrorCode` / `*RefusalCode`; los deduplica y exige que **cada** unión cerrada descubierta esté documentada aquí y que la membresía documentada sea idéntica a la del código fuente.
2. **El artefacto de evidencia `artifacts/g008/workspace-test-report.json`.** Cualquier oración que comience con "verificado", "aprobado" o "probado" o cita este informe en línea o apunta a la página de evidencia documental. Las afirmaciones de capacidad coinciden con el informe. Los siete comandos verificados aparecen literalmente en la página de inicio rápido.
3. **El libro de limitaciones `docs/evidence/limitations.md`.** Las tres limitaciones se enuncian allá donde una afirmación, de otro modo, se extralimitaría: el *daemon* de Docker no se ejecutó, accesibilidad neurodivergente por diseño (validación externa v1.1), el segundo adaptador es el criterio de conformidad v1.1.

Las páginas no inventan capacidades, contratos, ubicaciones de código ni códigos de error de auditoría. Los adjetivos de "*marketing rot*" ("endurecido en producción", "plenamente validado", "desplegado a escala") están ausentes por convención; un *lint* de calidad documental los prohíbe.

## Matriz audiencia → sección

Seis audiencias disjuntas se asignan al árbol documental. Cada página declara una audiencia en su encabezado; el README nunca mezcla audiencias en una sola página.

| Audiencia | Entrada principal | Páginas de apoyo |
| --- | --- | --- |
| Cliente / usuario final (autor en Handoff Beat) | [`docs/concepts/handoff-beat.md`](concepts/handoff-beat.md) (EN) · [`docs/concepts/handoff-beat.es.md`](concepts/handoff-beat.es.md) | [`docs/how-to/authoring.md`](how-to/authoring.md) (EN) · [`docs/how-to/authoring.es.md`](how-to/authoring.es.md) |
| Operador de agencia (pila Compose gestionada) | [`docs/how-to/self-host.es.md`](how-to/self-host.es.md) · [EN](how-to/self-host.md) | [`docs/how-to/configure.es.md`](how-to/configure.es.md) · [EN](how-to/configure.md), [`docs/how-to/operate.es.md`](how-to/operate.es.md) · [EN](how-to/operate.md) |
| Auto-hospedador (puesta en marcha completa y endurecimiento) | [`docs/how-to/self-host.es.md`](how-to/self-host.es.md) · [EN](how-to/self-host.md) | [`docs/security/hardening.es.md`](security/hardening.es.md) · [EN](security/hardening.md), [`docs/how-to/migrate.es.md`](how-to/migrate.es.md) · [EN](how-to/migrate.md), [`docs/how-to/backup-restore.es.md`](how-to/backup-restore.es.md) · [EN](how-to/backup-restore.md) |
| Integrador / constructor de adaptadores (`@cms/adapter-sdk` congelado) | [`docs/reference/adapter-sdk.es.md`](reference/adapter-sdk.es.md) · [EN](reference/adapter-sdk.md) | [`docs/adapters/cerafica.es.md`](adapters/cerafica.es.md) · [EN](adapters/cerafica.md) |
| Contribuyente (Forgejo canónico) | [`docs/project/contributing.es.md`](project/contributing.es.md) · [EN](project/contributing.md) | [`docs/project/docs-qa.es.md`](project/docs-qa.es.md) · [EN](project/docs-qa.md), [`docs/project/glossary.es.md`](project/glossary.es.md) |
| Revisor de seguridad (pruebas de autoridad) | [`docs/security/reviewer-on-ramp.es.md`](security/reviewer-on-ramp.es.md) · [EN](security/reviewer-on-ramp.md) | [`docs/security/threat-model.es.md`](security/threat-model.es.md) · [EN](security/threat-model.md), [`docs/security/hardening.es.md`](security/hardening.es.md) · [EN](security/hardening.md), [`docs/reference/audit-envelope.es.md`](reference/audit-envelope.es.md) · [EN](reference/audit-envelope.md), [`docs/reference/media-pipeline.es.md`](reference/media-pipeline.es.md) · [EN](reference/media-pipeline.md) |

La segmentación se aplica: una página solo puede etiquetarse con **una** de las seis audiencias. El README hace el enrutamiento cruzado de audiencias en la parte superior del proyecto; las páginas bajo el README se mantienen acotadas.

## Leyenda Diátaxis

El árbol documental sigue [Diátaxis](https://diataxis.fr/) (consultado 2026-07-28). Cuatro directorios albergan los cuatro modos:

- [`docs/overview.md`](overview.md) (EN) · [`docs/overview.es.md`](overview.es.md) — orientación; qué es Handoff CMS, dónde está el límite del contenido, qué contiene el monorepo.
- [`docs/concepts/`](concepts/) — material explicativo; el porqué de la arquitectura, gobernanza, accesibilidad, Handoff Beat y las ocho invariantes del producto.
- [`docs/how-to/`](how-to/) — guías orientadas a tareas; inicio rápido, autoría, autoalojamiento, configuración, operación, migración, copia de seguridad / restauración.
- [`docs/reference/`](reference/) — material informativo: uniones cerradas de códigos de error, superficies API / CLI / MCP, SDK del adaptador, tubería de medios, sobre de auditoría, configuración, máquina de estados y observabilidad.

Tres directorios **no** son carriles Diátaxis pero sí dan seguimiento a preocupaciones que cruzan los cuatro modos:

- [`docs/security/`](security/) — pruebas de autoridad, modelo de amenaza, endurecimiento, política de secretos en la documentación y rampa del revisor.
- [`docs/adapters/`](adapters/) — documentación del adaptador de referencia Cerafica y su relación con [`docs/reference/adapter-sdk.es.md`](reference/adapter-sdk.es.md).
- [`docs/project/`](project/) — salud de la comunidad: contribución, código de conducta, política de seguridad, soporte, publicación / versionado / licencias, calidad documental, glosario.

[`docs/evidence/`](evidence/) y [`docs/accessibility/`](accessibility/) albergan respectivamente el libro de evidencia (verificación y limitaciones) y la declaración de accesibilidad.

Una página nunca tiene más de un modo. Una página de "concepto" no se convierte en "cómo hacerlo"; un "cómo hacerlo" no se transforma en "referencia".

## Desfase cero EN/ES en el mismo PR

Inglés y español son **locales pares**. La regla:

1. Cada página de prosa dirigida al usuario existe como pares hermanos `*.md` + `*.es.md`. Las páginas de referencia pueden compartir bloques de código pero traducen la prosa.
2. Ambos hermanos se envían en el **mismo pull request**. El español es un par coautor, nunca una traducción posterior al hecho.
3. Un *lint* de paridad refleja la comprobación de paridad en tiempo de ejecución de `@cms/i18n` (`assertCatalogParity`). Fallar el *lint* bloquea el PR.
4. Cada carril en [`docs/project/docs-qa.es.md`](project/docs-qa.es.md) · [EN](project/docs-qa.md) nombra a una persona responsable de ambos pares EN y ES. Una persona revisora hispanohablante valida el español neutral y el uso del glosario.

Si cambias la página EN, cambia la página ES en el mismo commit. Si traduces un concepto nuevo, archiva ambas páginas juntas.

## Tabla de citaciones de buenas prácticas

El árbol documental se apoya en un conjunto pequeño de fuentes primarias nombradas. Las citaciones son en línea con fecha de consulta 2026-07-28.

| Área de la página | Fuente | URL |
| --- | --- | --- |
| Leyenda Diátaxis, diseño documental | Diátaxis | <https://diataxis.fr/> |
| Propósito del README y orientación por audiencia | GitHub Docs — About READMEs | <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes> |
| Conformidad WCAG 2.2 | W3C — Web Content Accessibility Guidelines (WCAG) 2.2 | <https://www.w3.org/TR/WCAG22/> |
| Accesibilidad de la herramienta de autoría (Handoff Beat) | W3C — Authoring Tool Accessibility Guidelines (ATAG) 2.0 | <https://www.w3.org/TR/ATAG20/> |
| Patrones de diseño de accesibilidad cognitiva | W3C — Making Content Usable for People with Cognitive and Learning Disabilities (COGA) | <https://www.w3.org/TR/coga-usable/> |
| Formato de errores de API (Problem Details RFC 9457) | IETF — RFC 9457 | <https://www.rfc-editor.org/rfc/rfc9457> |
| Política de secretos en la documentación para contribuyentes | OWASP — Secrets Management Cheat Sheet | <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html> |

Una afirmación que depende de una fuente primaria pero no la cita es una falla de calidad documental.

## Dónde ir a continuación

- Nuevo en el proyecto: [`overview.md`](overview.md) (EN) · [`overview.es.md`](overview.es.md), y luego la puerta de entrada del README.
- Eligiendo una ruta de audiencia: ver la [matriz de audiencias del README](../README.md#para-quién-es--elige-una-ruta).
- Editando la documentación: [`project/contributing.es.md`](project/contributing.es.md) · [EN](project/contributing.md) y [`project/docs-qa.es.md`](project/docs-qa.es.md) · [EN](project/docs-qa.md).
- Auditando el sistema documental: [`evidence/verification.md`](evidence/verification.md) y [`evidence/limitations.md`](evidence/limitations.md) distinguen la evidencia ejecutada de las limitaciones explícitas.
