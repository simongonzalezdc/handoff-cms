# Overview

> **Audience:** everyone. This page is the project's elevator pitch plus the content-boundary mental model plus the package map. Read this once, then jump into an audience path.

[Versión en español](overview.es.md) · The English and Spanish peers ship in the same pull request.

## What Handoff CMS is

Handoff CMS is a self-hostable, Apache-2.0 open-core governance system for one specific job: moving approved content changes from the people who edit (clients, agency editors, non-technical authors) to the **host** that owns the canonical truth (a website, a repository, a database, a downstream CMS), while preserving the host's authority and producing a tamper-evident audit trail.

It is the answer to a recurring failure mode in agency / client relationships: a website's content lives in a developer-mediated codebase, an external CMS, or a hybrid, and there is no safe, governed way for a non-technical client to edit host-owned content without an unsafe visual builder, a hostile code review, or a managed proprietary CMS that locks the data in.

The product preserves two non-negotiable invariants end-to-end:

1. **Host stays canonical.** The host website / repository / database / downstream CMS owns every content byte and every asset. Handoff CMS owns only the **governed handoff projection** — proposed deltas, approved revisions, region bindings, permissions, audit, previews, reconciliation, and one-action rollback.
2. **Agents propose; humans approve.** Every apply, publish, or rollback transition requires a fresh human authorization event. MCP and service identities never approve or publish. Rollback is one operator click against approval-time-captured authority; the click is the human authorization event, not a synthetic approval.

## The content boundary

The boundary between *what the host owns* and *what the CMS governs* is the central architectural concept. The CMS is not a new source of truth; it is a governed overlay that produces auditable, reversible changes against the host.

| Concern | Owned by the host | Governed by Handoff CMS |
| --- | --- | --- |
| Canonical content (HTML, structured JSON, API-backed data) | yes | no |
| Assets (images, derivatives, video) | yes | no |
| Region bindings (which host surface maps to which `RegionBinding`) | declared by developer; CMS verifies | yes — `canonical_source`, `derived_artifacts[]`, `regeneration_contract`, `field_capabilities` |
| Proposed deltas | no | yes — content-addressable, before/after refs, actor, approver |
| Approvals | no | yes — one human authorization event per apply / publish / rollback |
| Audit log | no | yes — append-only, content-hashed, detached Ed25519 JWS-signed |
| Deploy / propagation | host-specific (`DeployCapability`) | CMS tracks `canonical_written` vs `live_propagated` and reconciles the two |
| Rollback | no | yes — one operator click against the captured rollback target |
| OIDC bearer / delegated-human sessions | host operator configures | CMS verifies, never bypasses |

The Cerafica reference deployment makes the boundary concrete. Cerafica has three editable surfaces — hardcoded HTML pages, structured JSON products at canonical `inventory/products.json` (served to the website through a verified symlink alias at `website/data/products.json`), and a Kyanite journal API — and one `@cms/adapter-cerafica` adapter mediates all three.

A few boundary specifics worth flagging up front:

- **Served symlink aliases are verified, not written.** The CMS writes only the canonical path; it never writes through an alias. At region activation and at reconciliation, the binding verifies target resolution, repository confinement, non-cycle behavior, and target integrity. A missing, broken, retargeted, escaping, or replaced-with-regular-file alias fails visibly and never reports success.
- **Commerce-coupled fields are coordinator-gated.** Stripe-coupled Cerafica fields (`price`, `stripe_payment_link`, `available`, `coming_soon`, `one_of_one`) default to read-only / coordinator-gated. Free-editing `price` without regenerating the Payment Link creates a checkout / display mismatch; flipping availability fields without inventory coordination creates an oversell risk.
- **Accessibility is "neurodivergent-accessible by design".** Internal V1 design stance (WCAG 2.2 AA + ATAG 2.0 + COGA patterns), enforced in CI; external participant validation is a v1.1 goal. See [`docs/evidence/limitations.md`](evidence/limitations.md) and the accessibility statement at [`docs/accessibility/statement.md`](accessibility/statement.md) · [`.es`](accessibility/statement.es.md).
- **The second adapter is the v1.1 conformance gate.** V1 ships one reference adapter; the adapter contract's host-specific extension / capability fields remain provisional (1.0-beta / RC) until a second adapter exercises them. See [`docs/evidence/limitations.md`](evidence/limitations.md).
- **Docker runtime is not verified.** Only Compose interpolation / config validation, package runtime tests, and healthcheck syntax passed. Do not claim a live Docker deployment. See [`docs/evidence/limitations.md`](evidence/limitations.md).

## The thirteen packages

The V1 monorepo is a pnpm workspace (`packages/*`) of thirteen `@cms/*` packages. Their dependency DAG is roughly `core` → {`storage`, `audit`} → `api` → {`server`, `cli`, `mcp`, `web`}; `adapter-sdk` → `adapter-cerafica`; `media`, `i18n`, `licensing-guard` are siblings used by the layers above. The full DAG, the transport authority model, and the reason each layer exists are documented at [`docs/concepts/architecture.md`](concepts/architecture.md) (and its `.es` peer).

| Package | Role | Notes |
| --- | --- | --- |
| `@cms/core` | Pure, I/O-free governance kernel | Domain model, state machine, policy engine — sole authority |
| `@cms/storage` | Drizzle / Postgres persistence | Tenants, actors, region bindings, proposals, approvals, revisions, publications, audit, idempotency |
| `@cms/audit` | Immutable audit + portable export | Canonical NDJSON, detached Ed25519 JWS, offline-verifiable |
| `@cms/api` | Hono / OpenAPI 3.1 transport | Thin transport; RFC 9457 Problem Details; idempotency-key writes |
| `@cms/server` | Self-hosted Node 22 ESM executable | OIDC bearer verification, `/health/live`, `/health/ready`, `/metrics` |
| `@cms/cli` | Thin CLI projection over the API | Propose and read use configured credentials; approve / publish / rollback require interactive delegated-human auth |
| `@cms/mcp` | MCP server projection | Propose / preview / suggest tools; `submitApprovalRequest` only signals readiness; **no** approve / publish / apply / rollback surface |
| `@cms/web` | Handoff Beat authoring application | Bilingual (EN / ES peer locales), ATAG-aligned authoring surface, low-distraction model; thin client over an injected `AuthoringApi` |
| `@cms/adapter-sdk` | Frozen invariant-bearing adapter contract + conformance harness | `canonical_source` / `derived_artifacts[]` / `regeneration_contract` are part of the frozen core; `field_capabilities`, `DeployCapability` are host-specific extensions (1.0-beta / RC) |
| `@cms/adapter-cerafica` | Cerafica reference adapter | HTML + canonical `inventory/products.json` (served via verified symlink alias) + Kyanite journal API + GitHub-Pages `DeployCapability` + Stripe field gating |
| `@cms/media` | Pluggable BlobStore + governed media pipeline | ICC preserved, EXIF stripped, fail-closed malware quarantine, image derivatives, video read-only in V1 |
| `@cms/i18n` | Peer EN / ES message catalogs | Dependency-free; `assertCatalogParity` enforces key parity |
| `@cms/licensing-guard` | Fail-closed license policy guard | Walks the functional-core dependency graph and reports against a single authoritative allowlist |

The dependency graph keeps `@cms/core` free of I/O so it stays unit-testable in isolation. `@cms/api` is the only authority surface; `@cms/cli` and `@cms/mcp` are thin projections that share `@cms/api`'s decisions rather than reimplementing them. `@cms/web` is a thin client over an injected `AuthoringApi` and never re-implements authorization.

## Where to go next

- New to the project: read [`README.md`](../README.md) (English) / [`README.md#handoff-cms-en-español`](../README.md#handoff-cms-en-español) (Spanish) and pick an audience path.
- Audience-specific entry points are listed in [`docs/README.md`](README.md) under "Audience → section matrix".
- Architectural detail: [`docs/concepts/architecture.md`](concepts/architecture.md) (and the EN / ES peers).
- Governance and human authority: [`docs/concepts/governance-and-human-authority.md`](concepts/governance-and-human-authority.md).
- The Cerafica reference adapter: [`docs/adapters/cerafica.md`](adapters/cerafica.md) · [`.es`](adapters/cerafica.es.md).
- Evidence ledger: [`docs/evidence/verification.md`](evidence/verification.md); limitations ledger: [`docs/evidence/limitations.md`](evidence/limitations.md).
