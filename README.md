# Handoff CMS

> Apache-2.0 open-core governance monorepo for agent-proposable, human-approved content handoff between agency teams and the host websites they maintain.

[Versión en español](#handoff-cms-en-español) · Further below.

---

## What this is

Handoff CMS is a self-hostable content-governance system. The **host** (website, repository, database, or CMS) remains the **canonical** source of every content byte and every asset. The CMS owns only the **governed handoff projection**: proposed deltas, approved revisions, region bindings, permissions, audit, previews, reconciliation, and one-action rollback.

Agents — including MCP assistants, CLI automations, and IDE integrations — can read, analyze, propose, and preview. **Humans approve every apply, publish, or rollback.** Service and MCP identities never approve or publish. Commerce-coupled fields are coordinator-gated and read-only to client edits. English and Spanish are peer locales.

The Cerafica reference deployment (HTML, products, journal API) is the V1 dogfood; one reference adapter ships in the open core. A second independent adapter is the v1.1 conformance gate, not a V1 completion claim.

---

## Who this is for — pick one path

The six audiences below are disjoint. Each path opens a different slice of the documentation tree.

### 1. Client / end user — author in Handoff Beat

You edit host website content in `@cms/web` (Handoff Beat). Authentication is OIDC. You create proposals, preview them, and request human approval. You **cannot** approve, publish, apply, or rollback — those transitions are human-only and out-of-app.

- Concept: [`docs/concepts/handoff-beat.md`](docs/concepts/handoff-beat.md) · [`.es.md`](docs/concepts/handoff-beat.es.md)
- Walkthrough: [`docs/how-to/authoring.md`](docs/how-to/authoring.md) · [`.es.md`](docs/how-to/authoring.es.md)
- Authoring store errors: [`docs/reference/error-codes.md`](docs/reference/error-codes.md) · [`.es.md`](docs/reference/error-codes.es.md) (`STORE_ERROR_CODES`)

### 2. Agency operator — operate the managed compose stack

You run the Handoff CMS distribution on behalf of a client. You own secrets, OIDC configuration, Postgres and MinIO state, delegated-human session policy, and day-2 operations. You are not necessarily a developer.

- Bring-up: [`docs/how-to/self-host.md`](docs/how-to/self-host.md) · [`.es.md`](docs/how-to/self-host.es.md)
- Configuration: [`docs/how-to/configure.md`](docs/how-to/configure.md) · [`.es.md`](docs/how-to/configure.es.md)
- Day-2 operations: [`docs/how-to/operate.md`](docs/how-to/operate.md) · [`.es.md`](docs/how-to/operate.es.md)
- Fail-closed startup codes: [`docs/reference/error-codes.md`](docs/reference/error-codes.md) · [`.es.md`](docs/reference/error-codes.es.md) (`SERVER_CONFIG_ERROR_CODES`)

### 3. Self-hoster — full bring-up and hardening

You stand up the whole stack yourself (Postgres + MinIO + server) and harden the deployment. You care about threat surface, secret rotation, and the network split.

- Bring-up: [`docs/how-to/self-host.md`](docs/how-to/self-host.md) · [`.es.md`](docs/how-to/self-host.es.md)
- Hardening: [`docs/security/hardening.md`](docs/security/hardening.md) · [`.es.md`](docs/security/hardening.es.md)
- Threat model: [`docs/security/threat-model.md`](docs/security/threat-model.md) · [`.es.md`](docs/security/threat-model.es.md)
- Migration: [`docs/how-to/migrate.md`](docs/how-to/migrate.md) · [`.es.md`](docs/how-to/migrate.es.md)
- Backup and restore: [`docs/how-to/backup-restore.md`](docs/how-to/backup-restore.md) · [`.es.md`](docs/how-to/backup-restore.es.md)

### 4. Integrator / adapter builder — implement `@cms/adapter-sdk`

You write a new host adapter against the frozen invariant-bearing core of `@cms/adapter-sdk`. The adapter resolves a host's canonical source vs. served-alias path, declares field capabilities, and exposes a deploy capability.

- SDK reference: [`docs/reference/adapter-sdk.md`](docs/reference/adapter-sdk.md) · [`.es.md`](docs/reference/adapter-sdk.es.md)
- Cerafica reference adapter: [`docs/adapters/cerafica.md`](docs/adapters/cerafica.md) · [`.es.md`](docs/adapters/cerafica.es.md)
- Symlink-alias refusal codes: [`docs/reference/error-codes.md`](docs/reference/error-codes.md) · [`.es.md`](docs/reference/error-codes.es.md) (`SYMLINK_REFUSAL_CODES`)

### 5. Contributor — change the codebase or the docs

You work on Forgejo (canonical) or GitHub (mirror). You author EN and ES peer files in one pull request (zero-lag rule). Every prose page is a `*.md` + `*.es.md` pair. The CI parity lint enforces it.

- Contributing: [`docs/project/contributing.md`](docs/project/contributing.md) · [`.es.md`](docs/project/contributing.es.md)
- Docs QA: [`docs/project/docs-qa.md`](docs/project/docs-qa.md) · [`.es.md`](docs/project/docs-qa.es.md)
- Glossary: [`docs/project/glossary.md`](docs/project/glossary.md)
- Source-of-truth artifact: `artifacts/g008/workspace-test-report.json`

### 6. Security reviewer — on-ramp to authority proofs

You audit the system before deployment or as part of an external review. The on-ramp indexes every authority proof (OIDC verifier, MCP firewall, audit envelope, media quarantine, alias confinement, path confinement, network split, non-root / no-new-privileges) with deep links.

- On-ramp: [`docs/security/reviewer-on-ramp.md`](docs/security/reviewer-on-ramp.md) · [`.es.md`](docs/security/reviewer-on-ramp.es.md)
- Threat model: [`docs/security/threat-model.md`](docs/security/threat-model.md) · [`.es.md`](docs/security/threat-model.es.md)
- Hardening: [`docs/security/hardening.md`](docs/security/hardening.md) · [`.es.md`](docs/security/hardening.es.md)
- Audit envelope: [`docs/reference/audit-envelope.md`](docs/reference/audit-envelope.md) · [`.es.md`](docs/reference/audit-envelope.es.md)
- Media pipeline: [`docs/reference/media-pipeline.md`](docs/reference/media-pipeline.md) · [`.es.md`](docs/reference/media-pipeline.es.md)
- OIDC verifier errors: [`docs/reference/error-codes.md`](docs/reference/error-codes.md) · [`.es.md`](docs/reference/error-codes.es.md) (`SERVER_AUTH_ERROR_CODES`)

---

## Quickstart pointer

The full operator quickstart — the **seven verified commands** quoted exactly from `artifacts/g008/workspace-test-report.json` — lives at [`docs/how-to/quickstart.md`](docs/how-to/quickstart.md) (English) and [`docs/how-to/quickstart.es.md`](docs/how-to/quickstart.es.md) (Spanish). It includes `pnpm typecheck`, `pnpm test`, `pnpm build`, the licensing-guard run, the Playwright e2e suite, the Compose config validation, and the healthcheck syntax check. `pnpm install` is a prerequisite but is **not** counted among the seven verified commands.

---

## Repository map

| Path | Purpose |
| --- | --- |
| `packages/core` | Pure, I/O-free governance kernel — domain model, state machine, policy engine |
| `packages/storage` | Drizzle / Postgres persistence for governance data (tenants, proposals, revisions, audit) |
| `packages/audit` | Immutable audit events, NDJSON export, detached Ed25519 JWS signing |
| `packages/api` | Hono / OpenAPI 3.1 authoritative HTTP transport; RFC 9457 Problem Details |
| `packages/server` | Self-hosted `@cms/server` Node 22 ESM executable; OIDC bearer validation; health endpoints |
| `packages/cli` | Thin CLI projection over the API; approve / publish require interactive delegated-human auth |
| `packages/mcp` | MCP server — propose / preview / suggest tools; **no** approve / publish / apply / rollback |
| `packages/web` | Handoff Beat authoring application (the `@cms/web` client / end-user surface) |
| `packages/adapter-sdk` | Frozen invariant-bearing adapter contract + conformance harness |
| `packages/adapter-cerafica` | Cerafica reference adapter (HTML + canonical `inventory/products.json` + journal API) |
| `packages/media` | Pluggable BlobStore + governed media pipeline (ICC preserved, EXIF stripped, fail-closed quarantine) |
| `packages/i18n` | Peer EN / ES message catalogs (dependency-free) |
| `packages/licensing-guard` | Fail-closed license policy guard over the functional-core dependency graph |
| `compose.yaml`, `Dockerfile` | Self-hostable distribution (Postgres + MinIO + server); Docker daemon **not** verified |
| `scripts/self-host-healthcheck.mjs` | Liveness / readiness / metrics contract |
| `artifacts/g008/` | V1 verification evidence — the source of every "verified" claim below |

The thirteen `@cms/*` packages form the workspace. Their dependency DAG and the reason each layer exists are documented at [`docs/concepts/architecture.md`](docs/concepts/architecture.md).

---

## Status and evidence

The V1 foundation is verified end-to-end against `artifacts/g008/workspace-test-report.json`. The exact report names typecheck across 13 package projects, 27 test files / 899 tests, build across 13 projects, a 14-package licensing-guard scan with zero findings, a 6-test Playwright e2e suite passing in English and Spanish across desktop / tablet / mobile Chromium with zero axe violations, a clean Compose config validation, and a clean self-host healthcheck syntax check.

### Three limitations, always visible

1. **Docker daemon not executed.** Only Compose interpolation / config validation, package runtime tests, and healthcheck syntax passed. Do not claim a live Docker deployment.
2. **Accessibility is "neurodivergent-accessible by design."** Internal V1 design stance (WCAG 2.2 AA + ATAG 2.0 + COGA patterns) is enforced in CI; external participant validation is a v1.1 goal.
3. **A second independent adapter is the v1.1 conformance gate.** V1 ships one reference adapter; the adapter contract's host-specific extension / capability fields remain provisional (1.0-beta / RC) until a second adapter exercises them.

Read the complete [limitations ledger](docs/evidence/limitations.md) and [verification record](docs/evidence/verification.md). Verified commands and counts come verbatim from `artifacts/g008/workspace-test-report.json`.

---

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE). The Apache-2.0 core bundles the API, CLI, MCP, self-hosting, Handoff Beat, accessibility, propose / approve governance, and audit — human approval, governance, and audit are **not** paywalled.

---

## Canonical repository and mirror

The canonical repository is **Forgejo**: <https://git.kyanitelabs.tech/simon/handoff-cms>.

The public GitHub repository is a **mirror**: <https://github.com/simongonzalezdc/handoff-cms>. Discoverability surfaces throughout this README and the `docs/` tree label the GitHub URL as a mirror; changes flow from Forgejo outward.

---

# Handoff CMS en español

> Monorepo *open-core* de gobernanza bajo Apache-2.0 para traspasos de contenido entre agencias y los sitios web que mantienen, donde los agentes proponen y los humanos aprueban.

---

## Qué es

Handoff CMS es un sistema de gobernanza de contenido autoalojable. El **host** (sitio web, repositorio, base de datos o CMS) sigue siendo la **fuente canónica** de cada byte de contenido y de cada recurso. El CMS solo posee la **proyección de traspaso gobernada**: *deltas* propuestos, revisiones aprobadas, vinculaciones de región, permisos, auditoría, vistas previas, reconciliación y reversión con una sola acción.

Los agentes — asistentes MCP, automatizaciones de CLI, integraciones de IDE — pueden leer, analizar, proponer y previsualizar. **Los humanos aprueban cada aplicación, publicación o reversión.** Las identidades de servicio y MCP nunca aprueban ni publican. Los campos vinculados al comercio están *coordinator-gated* (gestionados por el coordinador) y son de solo lectura para los clientes. Inglés y español son locales pares.

El despliegue de referencia de Cerafica (HTML, productos, API de bitácora) es la prueba interna (*dogfood*) de V1; un adaptador de referencia se incluye en el núcleo abierto. Un segundo adaptador independiente es el criterio de conformidad de v1.1, no una afirmación de finalización de V1.

---

## Para quién es — elige una ruta

Las seis audiencias son disjuntas. Cada ruta abre un segmento distinto del árbol documental.

### 1. Cliente / usuario final — autor en Handoff Beat

Editas contenido del sitio web del host en `@cms/web` (Handoff Beat). La autenticación es OIDC. Creas propuestas, las previsualizas y solicitas aprobación humana. **No puedes** aprobar, publicar, aplicar ni revertir — esas transiciones son exclusivamente humanas y quedan fuera de la aplicación.

- Concepto: [`docs/concepts/handoff-beat.md`](docs/concepts/handoff-beat.md) (EN) · [`docs/concepts/handoff-beat.es.md`](docs/concepts/handoff-beat.es.md)
- Recorrido: [`docs/how-to/authoring.md`](docs/how-to/authoring.md) (EN) · [`docs/how-to/authoring.es.md`](docs/how-to/authoring.es.md)
- Errores del almacenamiento de autoría: [`docs/reference/error-codes.es.md`](docs/reference/error-codes.es.md) · [EN](docs/reference/error-codes.md) (`STORE_ERROR_CODES`)

### 2. Operador de agencia — opera la pila Compose gestionada

Ejecutas la distribución de Handoff CMS en nombre de un cliente. Eres responsable de secretos, configuración OIDC, estado de Postgres y MinIO, política de sesiones delegadas humanas y operaciones del día 2. No necesitas ser desarrollador.

- Puesta en marcha: [`docs/how-to/self-host.es.md`](docs/how-to/self-host.es.md) · [EN](docs/how-to/self-host.md)
- Configuración: [`docs/how-to/configure.es.md`](docs/how-to/configure.es.md) · [EN](docs/how-to/configure.md)
- Operaciones del día 2: [`docs/how-to/operate.es.md`](docs/how-to/operate.es.md) · [EN](docs/how-to/operate.md)
- Códigos de arranque fail-closed: [`docs/reference/error-codes.es.md`](docs/reference/error-codes.es.md) · [EN](docs/reference/error-codes.md) (`SERVER_CONFIG_ERROR_CODES`)

### 3. Auto-hospedador — puesta en marcha completa y endurecimiento

Levantas toda la pila por tu cuenta (Postgres + MinIO + servidor) y endureces el despliegue. Te importa la superficie de amenaza, la rotación de secretos y la separación de red.

- Puesta en marcha: [`docs/how-to/self-host.es.md`](docs/how-to/self-host.es.md) · [EN](docs/how-to/self-host.md)
- Endurecimiento: [`docs/security/hardening.es.md`](docs/security/hardening.es.md) · [EN](docs/security/hardening.md)
- Modelo de amenaza: [`docs/security/threat-model.es.md`](docs/security/threat-model.es.md) · [EN](docs/security/threat-model.md)
- Migración: [`docs/how-to/migrate.es.md`](docs/how-to/migrate.es.md) · [EN](docs/how-to/migrate.md)
- Copia y restauración: [`docs/how-to/backup-restore.es.md`](docs/how-to/backup-restore.es.md) · [EN](docs/how-to/backup-restore.md)

### 4. Integrador / constructor de adaptadores — implementa `@cms/adapter-sdk`

Escribes un adaptador nuevo de host contra el núcleo portador de invariantes congeladas de `@cms/adapter-sdk`. El adaptador resuelve la fuente canónica del host frente a la ruta del alias servido, declara capacidades de campo y expone una capacidad de despliegue.

- Referencia SDK: [`docs/reference/adapter-sdk.es.md`](docs/reference/adapter-sdk.es.md) · [EN](docs/reference/adapter-sdk.md)
- Adaptador de referencia Cerafica: [`docs/adapters/cerafica.es.md`](docs/adapters/cerafica.es.md) · [EN](docs/adapters/cerafica.md)
- Rechazos de alias symlink: [`docs/reference/error-codes.es.md`](docs/reference/error-codes.es.md) · [EN](docs/reference/error-codes.md) (`SYMLINK_REFUSAL_CODES`, fuente: `packages/adapter-cerafica/src/symlink.ts`)

### 5. Contribuyente — cambia el código o la documentación

Trabajas en Forgejo (canónico) o en GitHub (espejo). Autoras archivos pares EN y ES en un mismo *pull request* (regla de desfase cero). Cada página de prosa es un par `*.md` + `*.es.md`. El *lint* de paridad en CI lo aplica.

- Cómo contribuir: [`docs/project/contributing.es.md`](docs/project/contributing.es.md) · [EN](docs/project/contributing.md)
- Calidad documental: [`docs/project/docs-qa.es.md`](docs/project/docs-qa.es.md) · [EN](docs/project/docs-qa.md)
- Glosario: [`docs/project/glossary.md`](docs/project/glossary.md)
- Artefacto fuente de verdad: `artifacts/g008/workspace-test-report.json`

### 6. Revisor de seguridad — rampa de acceso a las pruebas de autoridad

Auditas el sistema antes del despliegue o como parte de una revisión externa. La rampa indexa cada prueba de autoridad (verificador OIDC, cortafuegos MCP, sobre de auditoría, cuarentena de medios, confinamiento de alias, confinamiento de ruta, separación de red, no-root / sin nuevos privilegios) con enlaces profundos.

- Rampa: [`docs/security/reviewer-on-ramp.es.md`](docs/security/reviewer-on-ramp.es.md) · [EN](docs/security/reviewer-on-ramp.md)
- Modelo de amenaza: [`docs/security/threat-model.es.md`](docs/security/threat-model.es.md) · [EN](docs/security/threat-model.md)
- Endurecimiento: [`docs/security/hardening.es.md`](docs/security/hardening.es.md) · [EN](docs/security/hardening.md)
- Sobre de auditoría: [`docs/reference/audit-envelope.es.md`](docs/reference/audit-envelope.es.md) · [EN](docs/reference/audit-envelope.md)
- Tubería de medios: [`docs/reference/media-pipeline.es.md`](docs/reference/media-pipeline.es.md) · [EN](docs/reference/media-pipeline.md)
- Errores del verificador OIDC: [`docs/reference/error-codes.es.md`](docs/reference/error-codes.es.md) · [EN](docs/reference/error-codes.md) (`SERVER_AUTH_ERROR_CODES`)

---

## Puntero de inicio rápido

El inicio rápido completo del operador — los **siete comandos verificados**, citados literalmente desde `artifacts/g008/workspace-test-report.json` — vive en [`docs/how-to/quickstart.md`](docs/how-to/quickstart.md) (inglés) y [`docs/how-to/quickstart.es.md`](docs/how-to/quickstart.es.md) (español). Incluye `pnpm typecheck`, `pnpm test`, `pnpm build`, la ejecución de la guarda de licencias, la suite e2e Playwright, la validación de configuración Compose y la comprobación sintáctica del *healthcheck*. `pnpm install` es un prerrequisito pero **no** se cuenta entre los siete comandos verificados.

---

## Mapa del repositorio

| Ruta | Propósito |
| --- | --- |
| `packages/core` | Núcleo de gobernanza puro, sin E/S — modelo de dominio, máquina de estados, motor de políticas |
| `packages/storage` | Persistencia Drizzle / Postgres para datos de gobernanza |
| `packages/audit` | Eventos de auditoría inmutables, exportación NDJSON, firma Ed25519 JWS separada |
| `packages/api` | Transporte HTTP autoritativo Hono / OpenAPI 3.1; Problem Details RFC 9457 |
| `packages/server` | Ejecutable ESM Node 22 `@cms/server` autoalojable; validación OIDC |
| `packages/cli` | Proyección CLI delgada sobre la API; aprobar / publicar requiere sesión humana interactiva |
| `packages/mcp` | Servidor MCP — herramientas de proponer / previsualizar / sugerir; **sin** aprobar / publicar / aplicar / revertir |
| `packages/web` | Aplicación de autoría Handoff Beat (superficie de cliente / usuario final) |
| `packages/adapter-sdk` | Contrato de adaptador congelado portador de invariantes + arnés de conformidad |
| `packages/adapter-cerafica` | Adaptador de referencia Cerafica (HTML + canónico `inventory/products.json` + API) |
| `packages/media` | *BlobStore* conectable + tubería de medios gobernada (ICC preservado, EXIF eliminado, cuarentena) |
| `packages/i18n` | Catálogos de mensajes pares EN / ES (sin dependencias) |
| `packages/licensing-guard` | Guarda de política de licencias *fail-closed* sobre el grafo de dependencias |
| `compose.yaml`, `Dockerfile` | Distribución autoalojable (Postgres + MinIO + servidor); *daemon* de Docker **no** verificado |
| `scripts/self-host-healthcheck.mjs` | Contrato de liveness / readiness / métricas |
| `artifacts/g008/` | Evidencia de verificación V1 — fuente de cada afirmación “verificada” posterior |

Los trece paquetes `@cms/*` forman el *workspace*. Su DAG de dependencias y la razón de cada capa están documentadas en [`docs/concepts/architecture.md`](docs/concepts/architecture.md) (EN) y [`docs/concepts/architecture.es.md`](docs/concepts/architecture.es.md).

---

## Estado y evidencia

La base V1 está verificada de extremo a extremo contra `artifacts/g008/workspace-test-report.json`. El informe nombra exactamente: *typecheck* en 13 proyectos, 27 archivos de prueba / 899 pruebas, *build* en 13 proyectos, *scan* de 14 paquetes por la guarda de licencias con cero hallazgos, suite e2e Playwright de 6 pruebas en inglés y español en escritorio / tableta / móvil Chromium con cero violaciones de axe, validación limpia de configuración Compose y comprobación sintáctica del *healthcheck* de autoalojamiento.

### Tres limitaciones, siempre visibles

1. **El daemon de Docker no se ejecutó.** Solo pasaron la validación de interpolación/configuración Compose, las pruebas de paquetes y la comprobación sintáctica del healthcheck. No afirmes un despliegue Docker en vivo.
2. **La accesibilidad es “neurodivergent-accessible by design”.** Es una postura de diseño V1; la validación externa con participantes se difiere a v1.1.
3. **Un segundo adaptador independiente es el criterio de conformidad v1.1.** V1 incluye un adaptador de referencia, no evidencia de dos implementaciones independientes.

Consulta el [libro de limitaciones](docs/evidence/limitations.md) y el [registro de verificación](docs/evidence/verification.md). Los comandos y conteos provienen literalmente de `artifacts/g008/workspace-test-report.json`.

---

## Licencia

Apache License, Versión 2.0. Ver [`LICENSE`](LICENSE). El núcleo Apache-2.0 agrupa la API, CLI, MCP, autoalojamiento, Handoff Beat, accesibilidad, la gobernanza de proponer / aprobar y auditoría — la aprobación humana, la gobernanza y la auditoría **no** están bloqueadas por *paywall*.

---

## Repositorio canónico y espejo

El repositorio canónico es **Forgejo**: <https://git.kyanitelabs.tech/simon/handoff-cms>.

El repositorio público de GitHub es un **espejo**: <https://github.com/simongonzalezdc/handoff-cms>. Las superficies de descubrimiento en este README y en el árbol `docs/` etiquetan la URL de GitHub como espejo; los cambios fluyen desde Forgejo hacia afuera.
