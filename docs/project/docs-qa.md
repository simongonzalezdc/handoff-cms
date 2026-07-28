# Docs QA

> **Audience:** contributors, code reviewers, and security reviewers who need the exact, drift-proof contract that the `pnpm docs:check` and `pnpm test:docs` commands enforce against the documentation tree. This page is information-oriented (Diátaxis project). The seven gates below are the contract; the workflow files at [`.forgejo/workflows/docs-qa.yml`](../../.forgejo/workflows/docs-qa.yml) (canonical) and [`.github/workflows/docs-qa.yml`](../../.github/workflows/docs-qa.yml) (mirror CI) run them on every pull request.

> [Versión en español](docs-qa.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## Scope and non-goals

This page defines the documentation quality contract for the Handoff CMS documentation tree. It is the source of truth for the `pnpm docs:check` and `pnpm test:docs` scripts. The lint scope is bounded and named:

- **In scope.** Markdown prose, EN/ES peer pairs, headed structure, links, parity, forbidden phrases, and the cross-reference of every documented claim to a primary source.
- **Out of scope.** Run-time test verdicts (axe, tastecheck, Playwright) live in [`../evidence/verification.md`](../evidence/verification.md). The three reported limitations at [`../evidence/limitations.md`](../evidence/limitations.md) are referenced here but not restated as a new claim.

The page does not invent wider gates than the discovery contract in the next section. The discovery sweep is the only authoritative source for the list of closed unions the handbook documents.

## Discovery contract

The discovery-sweep parity lint scans `packages/**/src/**/*.ts` for every exported closed `*_ERROR_CODES` / `*_REFUSAL_CODES` runtime array and the matching `*ErrorCode` / `*RefusalCode` type alias. The sweep dedupes the discovered exports and asserts two things:

1. Every discovered closed union is documented at [`../reference/error-codes.md`](../reference/error-codes.md) with the exact source symbol and the exact count.
2. The documented membership deep-equals the source: no documented entry that the source lacks, no source entry that the documentation omits.

The documentation audit exclusion is one and only one: the runtime arrays and the derived `ProblemCode` aggregator at `packages/api/src/problem.ts` are declared in [`../reference/error-codes.md`](../reference/error-codes.md) row 13 as "derived" and are not counted as a thirteenth union. Any other union not surfaced by the sweep is treated as undocumented.

## The exact twelve unions

The source-of-truth table lives at [`../reference/error-codes.md`](../reference/error-codes.md). The docs-QA page mirrors the union names and the source symbols, not the per-code membership, because the membership is what the discovery sweep verifies.

| # | Union | Package | Source symbol |
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

The discovering lint is the only system that may add a thirteenth row. Manual edits to this table are not accepted; the table regenerates from the discovery sweep in the same pull request that registers the new union.

## Lane owners (named for both locales)

Each lane name below identifies one human owner accountable for both the English and the Spanish peer of the page. The same owner is named in the ES peer page; the ES owner is a Spanish-reading reviewer who signs off on neutral-Spanish glossary use. The owner convention mirrors the same-PR EN/ES zero-lag rule in [`../README.md`](../README.md) §"Same-PR EN/ES zero-lag". Owners are recognized by the **lane** they shepherd, not by a GitHub @-handle:

| Lane | Owner role | Peer pages covered |
| --- | --- | --- |
| `docs:parity` | Docs-QA parity steward | `docs/project/docs-qa.md`, `docs/project/docs-qa.es.md` |
| `docs:glossary` | Glossary steward | `docs/project/glossary.md`, `docs/project/glossary.es.md` |
| `docs:contributing` | Contributing steward | `docs/project/contributing.md`, `docs/project/contributing.es.md` |
| `docs:security` | Security-steward (paired with security reviewer audience) | `docs/security/*.md`, `docs/security/*.es.md` |
| `docs:api` | API reference steward | `docs/reference/api.md`, `docs/reference/api.es.md`, `docs/reference/error-codes.md`, `docs/reference/error-codes.es.md` |
| `docs:architecture` | Architecture steward | `docs/concepts/*.md`, `docs/concepts/*.es.md` |
| `docs:howto` | How-to steward | `docs/how-to/*.md`, `docs/how-to/*.es.md` |
| `docs:overview` | Overview steward | `docs/overview.md`, `docs/overview.es.md`, `docs/README.md`, `docs/README.es.md` |

The owner role is a named accountability, not a @-handle. A reviewer who approves the change signs off as the role. The role description is the durable record; the role is recorded in the documentation tree, not in a separate tracker.

## Same-PR EN/ES zero-lag SLO

The service-level objective is **zero ES lag**: each user-facing page changed in a pull request includes its EN/ES peer in that same pull request.

- **Zero-lag.** The CI pull-request job passes the base commit to `docs:check`; the changed-file gate rejects a changed peer without its sibling.
- **Same PR.** Both peers are reviewed and merged together. Individual commits may be reorganized during review; the pull request is the enforced boundary.
- **No silent fallback.** Spanish is a co-authored peer. Mechanical parity does not replace review of neutral-Spanish meaning and glossary use.

A local run without a base input reports this gate as `SKIP`, never `PASS`. Canonical Forgejo and mirror GitHub pull-request workflows supply the base commit and treat a mismatch as blocking.

## The seven gates

`pnpm docs:check` enforces DR1–DR7 and SRC1. `pnpm test:docs` exercises the gate implementations with adversarial fixtures.

### DR1 — Link integrity

Every relative Markdown link and fragment in the documentation tree resolves:

- A relative `./` or `../` target must exist in the repository.
- An intra-page or cross-page fragment must match a rendered heading.
- Source-code line fragments such as `#L82-L102` are validated by the code host, not interpreted as Markdown headings.

The linter is offline and deliberately skips `http:`, `https:`, `mailto:`, and `ftp:` targets. Primary-source URLs are reviewed with their recorded retrieval date; CI does not claim a live-web probe.

### DR2 — EN/ES parity

Every user-facing page in `docs/` has a `*.md` / `*.es.md` peer unless it is on the small reviewed exclusion list. The lint checks:

- matching heading-level shape and order, while allowing translated heading text;
- substantively different prose with Spanish-language signals, rather than an English copy;
- peer presence and the separate DR3 link topology.

Code blocks may be shared verbatim. Any failure blocks the pull request.

### DR3 — Link parity

EN and ES peers expose equivalent relative-link target sets after normalizing `foo.es.md` to its `foo.md` peer and ignoring translated heading fragments. Missing or extra peer targets are blocking.

### DR4 — Forbidden phrases

Unqualified runtime claims using the closed project-policy list are blocked:

- `production-hardened`
- `fully validated`
- `deployed at scale`
- `battle-tested`
- `enterprise-grade`
- `mission-critical`

Policy pages may quote the list as negative examples; `enterprise-grade documentation` describes the documentation standard, not runtime proof.

### DR5 — Claim / source citation

A page using positive proof terms such as `verified`, `passed`, `tested`, or `supported` must contain a local `docs/`, `packages/`, `artifacts/`, or `scripts/` provenance citation. Headings, evidence-list rows, code fences, and negative policy quotations are not treated as capability claims. Missing page-level provenance is blocking.

### DR6 — Secret-safe source

The linter screens the documentation tree for private-key markers, JWT-shaped strings, GitHub token shapes, AWS access-key shapes, credential-bearing database URLs, bearer values, and non-placeholder UUIDs. Documented placeholders such as the all-zero UUID and `replace-with-*` are allowed. This is a conservative regex gate, not a guarantee that every possible secret format can be recognized; human review remains required. See [`../security/secrets-in-docs.md`](../security/secrets-in-docs.md).

### DR7 — OpenAPI discovery

[`../reference/openapi.json`](../reference/openapi.json) is a derived convenience artifact; `packages/api/src/openapi.ts` remains source of truth. The gate validates:

- JSON root shape with an OpenAPI `3.1.x` declaration, non-empty `info.title` / `info.version`, and a `paths` object;
- exact bidirectional method + path + `operationId` parity with the eight documented API operations;
- rejection of missing, extra, wrong-method, or wrong-operation-ID entries.

This is a focused structural and contract check, not a full third-party OpenAPI JSON Schema validator.

### Source-code gate (companion)

`SRC1` discovers exported closed `*_ERROR_CODES` / `*_REFUSAL_CODES` arrays and `*ErrorCode` / `*RefusalCode` type aliases across `packages/**/src/**/*.ts`. It compares the discovered 10 runtime arrays and 12 type surfaces to the reviewed inventory, fails on any new or missing union, and verifies every runtime-array member plus the type-only `StorageErrorCode` and `CliErrorCode` members appears in both EN and ES error-code references. `@cms/audit` is the explicit source-grounded exclusion because it has no closed error-code union.

## Limitations

The docs-QA gate does not establish:

- substantive correctness of prose beyond its mechanical/source-parity checks;
- live runtime behavior beyond the separately recorded `g008` evidence;
- that a named human or Spanish-reading reviewer performed the required review;
- current availability or content of external URLs;
- Docker daemon-backed runtime, external participant accessibility validation, or second-adapter validation.

These are evidence boundaries, not silent fallbacks.

## Primary citations (retrieved 2026-07-28)

The gates above borrow from a small set of named primary sources. The retrieval date is 2026-07-28.

| Gate | Source | URL |
| --- | --- | --- |
| DR2 parity rationale | `@cms/i18n` parity contract (`assertCatalogParity`) | `packages/i18n/src/index.ts` |
| DR4 adjective list | Handoff CMS project policy | This document; the list is a repository convention, not an OWASP standard |
| DR5 evidence ledger | `artifacts/g008/workspace-test-report.json` | committed artifact at the repository root |
| DR6 secret-safe policy | OWASP — Secrets Management Cheat Sheet | <https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html> |
| DR7 OpenAPI schema | OpenAPI Initiative — OpenAPI Specification 3.1.0 | <https://spec.openapis.org/oas/v3.1.0> |
| Discovery contract | Diátaxis — documentation modes | <https://diataxis.fr/> |
| Same-PR zero-lag rule | Handoff CMS project policy | This document; GitHub/Forgejo provide PR mechanics but do not define locale policy |

A claim that depends on a primary source but does not cite it is a docs-QA failure. The retrieval date is the date the link resolved; the gate is the contract that requires the link to be there.

## How to run the documentation QA locally

The two scripts are the contract for the docs-QA engine. The engine slice implements them; this page documents what they do:

```sh
pnpm docs:check   # DR1 link integrity, DR2 parity, DR3 link parity, DR4 forbidden phrases, DR5 citations, DR6 secrets, DR7 OpenAPI
pnpm test:docs    # discovery-sweep parity + the twelve-union membership audit (SRC1)
```

Both scripts return a non-zero exit code on a blocking failure. The output of `pnpm docs:check` is a numbered list of gate failures; the output of `pnpm test:docs` is the discovered union table with status. The scripts are not test runners; they do not touch the runtime tests in `packages/*/test/**`.

## Where to go next

- Authoring a contribution: [`contributing.md`](contributing.md) · [`contributing.es.md`](contributing.es.md) for the workflow, branch model, and commit conventions.
- Auditing the evidence: [`../evidence/verification.md`](../evidence/verification.md) and [`../evidence/limitations.md`](../evidence/limitations.md) for the seven verified commands and the three limitations.
- Reviewing the GLOSARIO controlled vocabulary: [`glossary.md`](glossary.md) · [`glossary.es.md`](glossary.es.md) for the term-by-term EN/ES contract.
