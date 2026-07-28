# Contribución

> [English version](contributing.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo *pull request* (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).
>
> **Audiencia:** contribuyentes que abren *pull requests* contra el repositorio canónico de Forgejo. Esta página amplía el contrato breve en [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) con el detalle del flujo de trabajo — modelo de ramas, convenciones de *commit*, regla del revisor independiente y regla explícita de aprobación humana de fusión — que el archivo raíz resume. Donde ambas páginas se solapan, el archivo raíz es el contrato breve y esta página es el detalle.

Esta página no introduce nueva política. Apunta a las páginas fuente de verdad que el flujo de contribución ya hereda: los ocho invariantes aprobados en [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.es.md) · [EN](../concepts/governance-and-human-authority.md), la disciplina de fuente y afirmación en [`../README.md`](../README.md), la política source-safe en [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md) y el contrato de calidad documental en [`docs-qa.es.md`](docs-qa.es.md) · [EN](docs-qa.md).

## Repositorio canónico y espejo

| Rol | Ubicación |
| --- | --- |
| Repositorio canónico (issues, pull requests, releases) | <https://git.kyanitelabs.tech/simon/handoff-cms> |
| Espejo público (referencia solo-lectura) | <https://github.com/simongonzalezdc/handoff-cms> |

Todos los *pull requests* — incluidos los cambios de documentación, seguridad y de proceso solo en inglés — se abren en la instancia canónica de Forgejo. El repositorio de GitHub es un espejo de descubribilidad; recibe los cambios por *push* desde Forgejo y no se usa como *issue tracker*. Las ramas, etiquetas y notas de publicación se cortan en Forgejo. Las superficies de descubribilidad en todo el repositorio etiquetan la URL de GitHub como espejo; por favor haz lo mismo cuando escribas una nueva página o modifiques una insignia de estado.

## Resumen del flujo de trabajo

1. Abre un *issue* en el repositorio canónico de Forgejo describiendo el cambio. Etiqueta la audiencia (`docs`, `security`, `integrator`, `operator`, `self-hoster`, `client`) para que la persona revisora adecuada siga el hilo.
2. Haz un *fork* del repositorio canónico y corta una rama temática. Los nombres de rama son `topic/<descripción-corta-kebab>` para documentación y `feat/<descripción-corta-kebab>` o `fix/<descripción-corta-kebab>` para código; las ramas de publicación llevan el prefijo `release/<versión>` y las corta una mantenedora con autoridad de publicación.
3. Realiza el cambio en *commits* atómicos. Un *commit* = un cambio lógico. Un *pull request* que mezcla un refactor con un cambio de comportamiento no es atómico y la persona revisora pedirá que se separe.
4. Abre un *pull request* contra `main` en el repositorio canónico. El cuerpo del *pull request* enlaza el *issue*, nombra la audiencia y lista los ocho invariantes que el cambio toca (si los hay). El *lint* de paridad por descubrimiento se ejecuta sobre el *pull request* antes de la asignación de revisor.
5. Una persona revisora humana independiente — distinta de la autora — revisa el cambio y la salida del *lint* de paridad. La revisión registra la identidad de la persona revisora y la marca temporal.
6. El botón de *merge* es un **evento fresco de autorización humana** registrado contra la identidad de la persona revisora. Ningún bot, automatización o política de *merge-on-green* puede fusionar un *pull request* en una rama de publicación.

## Cero desfase EN/ES en el mismo PR

Para cada página de prosa dirigida al usuario que cambies o añadas:

- Toca la página en inglés (`*.md`) **y** su par en español (`*.es.md`) en el mismo *commit* y en el mismo *pull request*. La página en español es un par coautor, nunca una traducción posterior al hecho.
- Usa español neutro. La persona revisora hispanohablante que aprueba el *pull request* firma el uso del glosario; no inventes un registro regional que el glosario no cubra. La convención de español neutro se registra en [`../project/glossary.es.md`](../project/glossary.es.md) · [EN](../project/glossary.md).
- No recurras al silencio. Si la página en español no puede enviarse en el mismo *pull request* por una razón que no sea "la página aún no tiene par", abre la cuestión en el repositorio canónico antes de que el cambio se fusione.

El alcance del *lint* de paridad y las reglas del barrido de descubrimiento viven en [`docs-qa.es.md`](docs-qa.es.md) · [EN](docs-qa.md); la justificación de la paridad se documenta en [`../README.md`](../README.md) §"Desfase cero EN/ES en el mismo PR" y §"Disciplina de fuente y afirmación". La verificación de paridad en tiempo de ejecución de `@cms/i18n` `assertCatalogParity` es el contrato que el *lint* refleja.

## Revisora independiente distinta de la autora

Cada *pull request* — incluidas las correcciones documentales de un solo *commit* — requiere una **revisora independiente** que **no sea la autora**. La revisión puede realizarla una persona o un agente de revisión aprobado, pero debe inspeccionar el diff real y devolver hallazgos trazables. La autorrevisión no es una revisión independiente.

La revisión documental abarca inglés y español. Las puertas mecánicas comprueban estructura y enlaces; una persona revisora hispanohablante valida el significado en español neutral y el uso del glosario. La revisión automatizada o por agente nunca sustituye la autorización humana explícita requerida para fusionar.

## Pull requests atómicos

Un *pull request* es atómico cuando la revisora puede fusionarlo sin estado parcial. El proyecto rechaza:

- Un *pull request* que mezcla un refactor con un cambio de comportamiento.
- Un *pull request* que toca código de gobernanza, código de auditoría o la fachada de autoridad junto con un cambio solo de documentación.
- Un *pull request* que introduce una nueva unión cerrada sin actualizar el inventario documentado al mismo tiempo.
- Un *pull request* que toca la par en inglés sin tocar la par en español.

La regla de atomicidad es *fail-closed*: una revisora a la que se le pide fusionar un cambio no atómico debe solicitar una división antes de que se habilite el botón de *merge*. La justificación se registra en [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.es.md) · [EN](../concepts/governance-and-human-authority.md): los ocho invariantes asumen un único evento de autorización humana por aplicar / publicar / revertir, y un cambio mixto es más difícil de razonar bajo auditoría.

## Aprobación humana explícita de fusión

Ningún bot, automatización o política de *merge-on-green* puede fusionar un *pull request* en una rama de publicación. El botón de *merge* es un **evento fresco de autorización humana** registrado contra la identidad de la persona revisora. La revisora que pulsa el botón de *merge* es la misma humana nombrada en la revisión del *pull request*; el evento de fusión y el evento de revisión están vinculados. Esto coincide con los ocho invariantes aprobados en [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.es.md) · [EN](../concepts/governance-and-human-authority.md), donde la autoaprobación se permite solo cuando la política vigente lo admite y nunca se infiere.

Si tienes derechos de automatización en el repositorio canónico, no configures un *auto-merge* para ramas que toquen código de gobernanza, código de auditoría o la fachada de autoridad. Si un *hot-fix* parece requerir *auto-merge*, trátalo como un incidente de seguridad bajo [`../../SECURITY.md`](../../SECURITY.md).

## Disciplina de fuente y afirmación

Cada afirmación de una página que añadas o modifiques cita una de tres fuentes:

1. Código fuente bajo `packages/*/src/**`. Las uniones cerradas `*_ERROR_CODES` y `*_REFUSAL_CODES` son la fuente de verdad del catálogo de códigos de error; un cambio que introduce un nuevo código sin nombrar la unión de tiempo de ejecución a la que pertenece es una falla de calidad documental. El contrato del barrido de descubrimiento se registra en [`docs-qa.es.md`](docs-qa.es.md) §"Contrato de descubrimiento".
2. El artefacto de evidencia `artifacts/g008/workspace-test-report.json`. Una oración que comience con "verificado", "aprobado" o "probado" cita este informe en línea o apunta a [`../evidence/verification.md`](../evidence/verification.md).
3. El libro de limitaciones [`../evidence/limitations.md`](../evidence/limitations.md). Las tres limitaciones se enuncian allá donde una afirmación, de otro modo, se extralimitaría: el *daemon* de Docker no se ejecutó, accesibilidad neurodivergente por diseño con validación externa con participantes diferida a v1.1, el segundo adaptador independiente es el criterio de conformidad v1.1.

Los adjetivos de "*marketing rot*" están prohibidos por el *lint* de calidad documental: `production-hardened`, `fully validated`, `deployed at scale`, `battle-tested`, `enterprise-grade`, `mission-critical`. Una página que use uno de ellos falla DR4. La lista cerrada vive en [`docs-qa.es.md`](docs-qa.es.md) §"DR4 — Frases prohibidas".

## Secretos y revisión *source-safe*

Los *pull requests* no deben contener un secreto real o un valor que pueda identificar un despliegue real: tokens *bearer*, credenciales OIDC o de base de datos, claves de *object-store*, claves privadas, cookies, URLs firmadas, identificadores de inquilino o cliente, identificadores de cuenta, identificadores de propuesta, UUIDs o valores copiados de peticiones o registros. La política cerrada *source-safe* está en [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md); el tiempo de ejecución redacta `accessKeyId`, `secretAccessKey` y la contraseña de la URL de base de datos antes de cualquier registro del operador (ver [`../../packages/server/src/config.ts`](../../packages/server/src/config.ts)), pero el límite de la documentación no es una afirmación de que el tiempo de ejecución detecte cada secreto en prosa. Las autoras y las revisoras son responsables de mantener la fuente segura antes de la publicación.

Los ejemplos usan marcadores `replace-with-*`. El *lint* de calidad documental (DR6) marca literales tipo Bearer / JWT / AWS / Database-URL / UUID que no sean marcadores `replace-with-*`; la lista de comprobación cerrada *source-safe* es la versión para revisoras de la misma regla.

Si se encuentra un valor real durante la revisión, detén el cambio, elimina el valor de la copia de trabajo y de los artefactos de revisión y notifica a la propietaria de seguridad del repositorio mediante el proceso de respuesta a credenciales establecido por el operador, descrito en [`../../SECURITY.md`](../../SECURITY.md).

## Pruebas y verificación

La verificación V1 ejecuta los siete comandos en [`../how-to/quickstart.es.md`](../how-to/quickstart.es.md) · [EN](../how-to/quickstart.md) y los registra literalmente en `artifacts/g008/workspace-test-report.json`. Un cambio que afecta al alcance verificado debe actualizar la unión cerrada relevante, la página de evidencia de calidad documental y la cita de los siete comandos cuando se complete la siguiente ejecución de verificación. Los siete comandos no son un objetivo al que añadir; son la traza canónica de ejecución que el proyecto cita, y un *pull request* que introduce una nueva afirmación sobre el comportamiento del tiempo de ejecución debe venir con el siguiente informe g00x.

El *daemon* de Docker no se ejecutó durante la verificación V1. Un *pull request* que dependa de una ejecución respaldada por un *daemon* de Docker en vivo no es elegible para V1.

## Versiones soportadas y política de versionado

Handoff CMS está en una **línea de publicación 0.x**. La superficie soportada se documenta en [`../../README.md`](../../README.md) y se verifica de extremo a extremo contra `artifacts/g008/workspace-test-report.json`. Las tres limitaciones registradas en [`../evidence/limitations.md`](../evidence/limitations.md) (el *daemon* de Docker no se ejecutó, accesibilidad neurodivergente por diseño con validación externa con participantes diferida a v1.1, el segundo adaptador independiente es el criterio de conformidad v1.1) son parte del contrato soportado; no se debilitan ni se resumen. La semántica 0.x pre-1.0 se documenta en [`release-versioning.es.md`](release-versioning.es.md) · [EN](release-versioning.md).

Se aceptan parches contra la **última etiqueta de publicación 0.x** en el repositorio canónico. El repositorio no mantiene ramas 0.x más antiguas en paralelo. Un cambio de comportamiento debe incluir la actualización de paridad en ambas pares `en` y `es`, el cambio a la unión cerrada relevante si toca un código de rechazo y la página de evidencia de calidad documental.

## Reportar problemas

- **Bugs y solicitudes de funcionalidad** — abre un *issue* en el repositorio canónico de Forgejo en <https://git.kyanitelabs.tech/simon/handoff-cms/issues>.
- **Vulnerabilidades de seguridad** — sigue el proceso de divulgación privada en [`../../SECURITY.md`](../../SECURITY.md). No abras un *issue* público.
- **Preguntas de documentación y proceso** — abre un *issue* en el repositorio canónico de Forgejo y etiqueta `docs` / community.
- **Preguntas de soporte** — sigue [`../../SUPPORT.md`](../../SUPPORT.md).

## Antes de abrir un pull request

1. Lee [`../../README.md`](../../README.md) y la página de audiencia relevante bajo §"Para quién es — elige una ruta".
2. Lee esta página y el contrato breve en [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
3. Lee la guía de calidad documental: [`docs-qa.es.md`](docs-qa.es.md) · [EN](docs-qa.md) para el *lint* de paridad, las reglas del barrido de descubrimiento, la disciplina de fuente y afirmación y los adjetivos de *marketing* prohibidos.
4. Lee [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md) y la lista de comprobación de revisión *source-safe* dentro de ella.
5. Para cambios de gobernanza, auditoría o SDK de adaptador, lee también [`../security/reviewer-on-ramp.md`](../security/reviewer-on-ramp.es.md) · [EN](../security/reviewer-on-ramp.md) y [`../security/threat-model.md`](../security/threat-model.es.md) · [EN](../security/threat-model.md) antes de redactar.

## Licencia

Handoff CMS está licenciado bajo la Apache License, Version 2.0. Al enviar una contribución aceptas que tu contribución se licencia bajo la misma licencia Apache-2.0 y que tienes el derecho de enviarla bajo esos términos. Véase [`../../LICENSE`](../../LICENSE) y [`licensing.es.md`](licensing.es.md) · [EN](licensing.md). No se requiere un Contributor License Agreement separado.

## Atribución

Esta página amplía el contrato breve en [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) con el detalle del flujo de trabajo. Los ocho invariantes y la regla explícita de aprobación humana de fusión se registran en [`../concepts/governance-and-human-authority.md`](../concepts/governance-and-human-authority.es.md) · [EN](../concepts/governance-and-human-authority.md). La política de pares bilingüe EN/ES y la regla de cero desfase en el mismo *pull request* se registran en [`../README.md`](../README.md).
