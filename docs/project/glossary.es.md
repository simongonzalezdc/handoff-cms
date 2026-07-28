# Glosario

> [English version](glossary.md) · El inglés y el español son locales pares. Ambos archivos se publican en el mismo pull request (regla de cero desfase). Véase [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

Este glosario es el vocabulario controlado del árbol documental. Cada entrada indica el término, ofrece una definición de una línea en inglés, una definición de una línea en español y apunta a la fuente que lo ancla. La versión en español usa español neutro para que el concepto técnico se traduzca 1:1 y un lector de cualquiera de los dos idiomas encuentre la misma forma.

Para la pauta de español neutro, este glosario sigue las mismas convenciones del resto del árbol: evitar localismos, preferir calcos que reflejen el inglés sin guionizar y confiar en el término técnico hispanizado solo cuando el árbol ya lo empareja con el original inglés en su primera aparición.

## A — fuente canónica (canonical source)

- **EN (canonical source):** The single authoritative host reference for a content region. The CMS writes only this path; derived artifacts are served from it. Anchored at `packages/core/src/domain.ts` (RegionBinding `canonicalSource`).
- **ES (fuente canónica):** La referencia única y autoritativa del host para una región de contenido. El CMS escribe únicamente en esta ruta; los artefactos derivados se sirven desde ella. Anclado en `packages/core/src/domain.ts` (`canonicalSource` de RegionBinding).

## B — proyección gobernada (governed projection)

- **EN (governed projection):** The bounded CMS-owned view of the host: proposed deltas, approved revisions, mappings, permissions, audit, previews, reconciliation, and rollback. The projection is the only thing the CMS owns; the host remains canonical. Anchored at the architecture page (`docs/concepts/architecture.md`).
- **ES (proyección gobernada):** La vista acotada propiedad del CMS sobre el host: deltas propuestos, revisiones aprobadas, mapeos, permisos, auditoría, vistas previas, reconciliación y reversión. La proyección es lo único que posee el CMS; el host sigue siendo canónico. Anclado en la página de arquitectura (`docs/concepts/architecture.md`).

## C — vinculación de región (region binding)

- **EN (region binding):** A frozen descriptor that pairs exactly one canonical source with a non-empty derived-artifact list and an explicit regeneration contract. Today the only recognized regeneration mode is `alias_symlink`. Anchored at `packages/core/src/domain.ts` (`RegionBinding`, `assertRegionBinding`).
- **ES (vinculación de región):** Un descriptor congelado que empareja exactamente una fuente canónica con una lista no vacía de artefactos derivados y un contrato de regeneración explícito. Hoy el único modo de regeneración reconocido es `alias_symlink`. Anclado en `packages/core/src/domain.ts` (`RegionBinding`, `assertRegionBinding`).

## D — recibo de despliegue (deploy receipt)

- **EN (deploy receipt):** A host-reported record that a published revision has propagated to the live deployment. A deploy receipt reports propagation only; it is distinct from the canonical write. Anchored at `packages/api/src/index.ts` (`POST /v1/publications/{id}/deploy-receipts`) and the OpenAPI catalog `packages/api/src/openapi.ts`.
- **ES (recibo de despliegue):** Un registro reportado por el host que indica que una revisión publicada se propagó al despliegue en vivo. Un recibo de despliegue solo reporta propagación; es distinto de la escritura canónica. Anclado en `packages/api/src/index.ts` (`POST /v1/publications/{id}/deploy-receipts`) y en el catálogo OpenAPI `packages/api/src/openapi.ts`.

## E — reconciliación (reconciliation)

- **EN (reconciliation):** The read-only check that re-aligns a proposal with current host state before a write or rollback, plus the asynchronous recovery that converges failed or in-flight deploys. Reconciliation is read-only at the API; apply is canonical-only. Anchored at `packages/core/src/state-machine.ts` (`reconcile`, `reconcile_fail`) and the API routes `packages/api/src/index.ts`.
- **ES (reconciliación):** La verificación de solo lectura que alinea de nuevo una propuesta con el estado actual del host antes de una escritura o reversión, junto con la recuperación asíncrona que converge los despliegues fallidos o en curso. La reconciliación es de solo lectura en la API; la aplicación es solo canónica. Anclado en `packages/core/src/state-machine.ts` (`reconcile`, `reconcile_fail`) y en las rutas de la API en `packages/api/src/index.ts`.

## F — sesión humanodelegada (delegated-human session)

- **EN (delegated-human session):** A short-lived, fresh-interactive authentication where a human acts through another human's delegator identity. The CLI obtains it via a browser/device flow; static tokens, service identities, and MCP identities are refused for privileged commands. Anchored at `packages/core/src/domain.ts` (`DelegatedHumanIdentity`) and `packages/cli/src/index.ts` (`runPrivilegedCommand`, `PRIVILEGED_COMMANDS`).
- **ES (sesión humanodelegada):** Una autenticación fresca, interactiva y de vida corta en la que un humano actúa a través de la identidad delegante de otro humano. La CLI la obtiene mediante un flujo de navegador/dispositivo; los tokens estáticos, las identidades de servicio y las identidades de MCP son rechazados para los comandos privilegiados. Anclado en `packages/core/src/domain.ts` (`DelegatedHumanIdentity`) y en `packages/cli/src/index.ts` (`runPrivilegedCommand`, `PRIVILEGED_COMMANDS`).

## G — alias / enlace simbólico (alias symlink)

- **EN (alias symlink):** The regeneration contract mode in which a served artifact is a confined symbolic link whose target is the canonical source. The binding verifies target resolution, repository confinement, non-cycle, and target integrity at activation and reconciliation. Anchored at `packages/core/src/domain.ts` (`RegenerationMode = 'alias_symlink'`, `AliasSymlinkContract`) and `packages/adapter-sdk/src/conformance.ts`.
- **ES (alias / enlace simbólico):** El modo del contrato de regeneración en el que un artefacto servido es un enlace simbólico confinado cuyo destino es la fuente canónica. La vinculación verifica la resolución del destino, el confinamiento al repositorio, la ausencia de ciclos y la integridad del destino en la activación y la reconciliación. Anclado en `packages/core/src/domain.ts` (`RegenerationMode = 'alias_symlink'`, `AliasSymlinkContract`) y en `packages/adapter-sdk/src/conformance.ts`.

## H — puerta de coordinador (coordinator-gated)

- **EN (coordinator-gated):** A field capability that only the commerce coordinator may change. Client edits are read-only; the CMS rejects mutation. The default for Stripe-coupled Cerafica fields. Anchored at the architecture page (`docs/concepts/architecture.md`) and the Cerafica adapter (`packages/adapter-cerafica/src`).
- **ES (puerta de coordinador):** Una capacidad de campo que solo el coordinador de comercio puede modificar. Las ediciones del cliente son de solo lectura; el CMS rechaza la mutación. Es el valor por defecto para los campos de Cerafica acoplados a Stripe. Anclado en la página de arquitectura (`docs/concepts/architecture.md`) y en el adaptador de Cerafica (`packages/adapter-cerafica/src`).

## I — Handoff Beat

- **EN (Handoff Beat):** The nontechnical authoring journey for preparing a governed change. A bilingual author signs in, edits a draft, checks a preview, and proposes the draft for human review. The full five-task journey is exercised under one minute in the verified browser evidence. Anchored at `docs/concepts/handoff-beat.md` and the Playwright suite (`packages/web/e2e/handoff-beat.spec.ts`).
- **ES (Handoff Beat):** El recorrido de autoría no técnica para preparar un cambio gobernado. Un autor bilingüe inicia sesión, edita un borrador, revisa una vista previa y propone el borrador para revisión humana. El recorrido completo de cinco tareas se ejecuta en menos de un minuto en la evidencia verificada del navegador. Anclado en `docs/concepts/handoff-beat.md` y en la suite de Playwright (`packages/web/e2e/handoff-beat.spec.ts`).

## J — sobre de auditoría (audit envelope)

- **EN (audit envelope):** The bounded, immutable `AuditEvent` validation, deterministic canonical serialization, content hashing, and detached JWS signing that produces a portable, offline-verifiable audit trail. Anchored at `packages/audit/src/index.ts` (`AuditEvent`, `SignedAuditEnvelope`, `signEvent`, `verifyEnvelope`).
- **ES (sobre de auditoría):** La validación acotada e inmutable del `AuditEvent`, la serialización canónica determinista, el hash de contenido y la firma JWS separada que producen un registro de auditoría portable y verificable sin conexión. Anclado en `packages/audit/src/index.ts` (`AuditEvent`, `SignedAuditEnvelope`, `signEvent`, `verifyEnvelope`).

## K — RFC 9457

- **EN (RFC 9457):** The IETF “Problem Details for HTTP APIs” specification. The CMS uses `application/problem+json` for every non-2xx response with a stable `type`, `title`, `status`, `detail`, and machine-readable `code`. Anchored at `packages/api/src/problem.ts` and the OpenAPI description (`packages/api/src/openapi.ts`).
- **ES (RFC 9457):** La especificación del IETF “Problem Details for HTTP APIs”. El CMS usa `application/problem+json` en cada respuesta no 2xx con un `type`, `title`, `status`, `detail` estables y un `code` legible por máquina. Anclado en `packages/api/src/problem.ts` y en la descripción de OpenAPI (`packages/api/src/openapi.ts`).

## L — barrido de descubrimiento (discovery sweep)

- **EN (discovery sweep):** The read-only capability advertisement that an adapter exposes at `binding.discover`. The sweep lists frozen capabilities, provisional capabilities, and candidate bindings with their issues; ambiguous bindings are reported, not silently fixed. Anchored at `packages/adapter-sdk/src/index.ts` (`AdapterDiscovery`, `discover`) and `packages/adapter-sdk/src/conformance.ts` (`checkDiscovery`).
- **ES (barrido de descubrimiento):** El anuncio de capacidad de solo lectura que un adaptador expone en `binding.discover`. El barrido lista capacidades congeladas, capacidades provisionales y vinculaciones candidatas con sus problemas; las vinculaciones ambiguas se reportan, no se corrigen en silencio. Anclado en `packages/adapter-sdk/src/index.ts` (`AdapterDiscovery`, `discover`) y en `packages/adapter-sdk/src/conformance.ts` (`checkDiscovery`).

## Pauta de español neutro

- Use el calco o el préstamo que el árbol ya empareja en la primera aparición. Las entradas pares anteriores listan el término en inglés y en español; no vuelva a localismos una vez fijado el par.
- Evite traslados literales que introduzcan significados arquitectónicos falsos. Por ejemplo, *reconciliation* es **reconciliación**, no *reconciliación de estado*; el estado se sobreentiende en el verbo.
- Mantenga las uniones cerradas en su forma inglesa cuando el código fuente las use así. Los estados del autómata (`canonical_written`, `propagating`, `live`, `reconciled`, `rolled_back`) aparecen en código, registros y eventos de auditoría; la prosa puede traducir al actor, pero los nombres de estado se mantienen literales.
- El catálogo en inglés y el catálogo en español deben coincidir en los nombres de clave. La verificación de paridad del traductor (`assertCatalogParity`) falla la compilación si falta una clave en algún locale; la persona revisora verifica la redacción.
- Cuando un término aparece en cadenas de la interfaz de usuario, la redacción visible la posee el catálogo en `packages/i18n/src/index.ts`, no este glosario.

## Evidencia

- `packages/core/src/domain.ts` — RegionBinding, DelegatedHumanIdentity, AliasSymlinkContract.
- `packages/core/src/state-machine.ts` — reconciliación, canonical_written, live, rolled_back.
- `packages/api/src/index.ts`, `packages/api/src/openapi.ts`, `packages/api/src/problem.ts` — RFC 9457, recibos de despliegue, ruta de reconcile.
- `packages/audit/src/index.ts` — sobre de auditoría.
- `packages/adapter-sdk/src/index.ts`, `packages/adapter-sdk/src/conformance.ts` — barrido de descubrimiento, capacidades congeladas y provisionales.
- `packages/cli/src/index.ts` — comandos privilegiados, sesión humanodelegada.
- `docs/concepts/architecture.md`, `docs/concepts/governance-and-human-authority.md`, `docs/concepts/handoff-beat.md` — páginas de conceptos.
