# Handoff Beat

Handoff Beat is the nontechnical authoring journey for preparing a governed change to the host site. It is a small, bilingual author surface: an OIDC-authenticated author signs in, edits a draft, checks a preview, and proposes the draft for human review. The host repository remains canonical; Handoff CMS records the proposal and coordinates the governed handoff around it. The authoring client does not become a second source of truth.

This page describes the author lane, not a generic CMS overview, an API catalog, or an operations runbook.

## What the author lane does

- **Sign-in:** access is through the host's configured OIDC issuer. The server verifies the issuer, audience, JWKS signature, expiry, not-before time, and an allowed algorithm before the request reaches the authority API ([OIDC configuration](../../packages/server/src/config.ts#L82-L102), [authentication and identity resolution](../../packages/api/src/auth.ts#L1-L18)).
- **Edit and prepare:** edit text and structured-record fields in English and Spanish, edit safe product title/summary content, update image alternative text/crop/focal data, and use the approved block actions exposed by the author surface. These are local draft operations until a proposal is submitted ([authoring model](../../packages/web/src/model.ts#L11-L45)).
- **Preview:** ask the API for a server-rendered preview of the current snapshot. Preview returns a preview URL and revision token; it is not a canonical write ([`AuthoringApi.previewFromSnapshot`](../../packages/web/src/model.ts#L380-L400)).
- **Propose:** submit the bilingual snapshot as a proposal. A proposal is an intent plus a candidate revision; it is sent for human review and does not approve or publish itself ([`propose`](../../packages/web/src/model.ts#L392-L400), [the UI action handler](../../packages/web/src/app.ts#L605-L629)).

## What it does not do for an author

An author may preview and propose only. **The author must not approve, publish, apply, reconcile, or roll back a change.** Those are governed authority operations outside author capabilities. Human approval is a separate decision and is checked by the authority layer and core policy; service and MCP identities are refused for approval, publication, and rollback ([authority refusal](../../packages/api/src/auth.ts#L197-L225), [policy rules](../../packages/core/src/policy.ts#L1-L20)). A proposal confirmation explicitly says that proposing does not approve or publish ([English catalog](../../packages/i18n/src/index.ts#L104-L120)).
Every applied or published change requires a separate human approval decision; proposing is never approval by implication.

The author surface may display proposal, deploy, audit, or rollback status so that a nontechnical person can understand what happened. A visible status is not permission to perform the governed action. Do not treat a disabled control, a confirmation dialog, or a displayed state as an invitation to bypass the human workflow; the API remains authoritative.

Commerce is intentionally narrower. Product title and summary are safe content fields, while price and commerce fields are rendered read-only. There is no product-price input in the browser journey, and commerce changes remain coordinator-gated and client-read-only ([product rendering](../../packages/web/src/template.ts#L302-L329), [browser assertion](../../packages/web/e2e/handoff-beat.spec.ts#L58-L65)). Ask the commerce coordinator to make a commerce change; do not try to encode one in an author proposal.

## Lifecycle: the beats around a proposal

The visible authoring lifecycle maps to the governed state machine:

1. **`editing`** — local bilingual draft changes are being prepared. The host is still canonical.
2. **`preview_ready`** — the current snapshot passed the authoring checks and a preview was produced. The preview is a review artifact, not a write.
3. **`proposed`** — the author submitted the candidate revision for human review. Local undo is no longer the mechanism for changing that committed proposal.
4. **`approved`** — a separately authorized human recorded approval. The author does not perform this transition.
5. **`canonical_written`** — a governed write reached the host's canonical repository. This is distinct from the site being live.
6. **`deploy_pending`** — the host/deployment coordinator has not yet reported propagation complete.
7. **`live`** — the deployment receipt reports the resulting version live.

The API and core state machine preserve the distinction between canonical bytes and propagation ([API contract](../../packages/api/src/index.ts#L17-L27), [state machine](../../packages/core/src/state-machine.ts#L1-L21)). A governed rollback is a single compensating human action: its adapter/deployment write boundary completes at **`canonical_written`**, never `live`; separately, the governed proposal lifecycle transitions to terminal **`rolled_back`** and is audited as `proposal.rolled_back`. Asynchronous deployment reconciliation follows the canonical write. That is different from **local undo**, which reverses an unsubmitted edit in the browser. The author should use local undo while editing and request the responsible human/operator to handle governed rollback when a proposal or deployment needs reversal. A Docker runtime is not established by this authoring journey; do not infer a live container deployment from the preview or browser surface.

## English and Spanish are peers

Every authoring proposal carries both peer locales. English and Spanish are not a primary locale plus an optional fallback: missing values are rejected, and the translator fails closed when a catalog key is absent ([peer-locale contract](../../packages/i18n/src/index.ts#L1-L12), [required bilingual fields](../../packages/web/src/model.ts#L28-L35)). Complete and review the English and Spanish values together. Switching the locale changes the presentation language; it does not remove the other peer's required content. The five-task browser journey fills both text and alt-text peers before previewing ([EN/ES journey](../../packages/web/e2e/handoff-beat.spec.ts#L25-L56)).

## Accessibility is part of the design

V1 is **“neurodivergent-accessible by design”**. This is a design stance, not a claim of external validation. The current limitation is: **“External validation is planned for v1.1.”** ([catalog wording](../../packages/i18n/src/index.ts#L160-L173), [browser evidence](../../packages/web/e2e/handoff-beat.spec.ts#L131-L145)).
The Docker runtime is unverified by this documentation journey; do not claim a live Docker deployment from browser or Compose evidence alone.

The surface uses native semantic landmarks and real controls with labels, keeps English and Spanish surfaces symmetrical, supports keyboard movement, restores focus after commands, moves focus to the error summary when an action is blocked, and announces success/errors through live regions ([template contract](../../packages/web/src/template.ts#L1-L27), [app accessibility contract](../../packages/web/src/app.ts#L5-L24)). Low-distraction and reduced-motion preferences are explicit author preferences, and the browser checks keyboard reachability plus an axe scan with zero violations ([accessibility journey](../../packages/web/e2e/handoff-beat.spec.ts#L89-L99), [preference implementation](../../packages/web/src/app.ts#L207-L218)). These affordances reduce cognitive and sensory load; they do not change governance authority.

## When something fails

The author-visible failure is meant to be concrete and recoverable:

- A missing required English or Spanish value blocks preview and identifies the field in an error summary; focus moves to that summary ([failure journey](../../packages/web/e2e/handoff-beat.spec.ts#L191-L199)).
- A local edit can be undone while it is still in the pending-edits layer. After proposal, reversal is governed rollback, not local undo ([local edit contract](../../packages/web/src/model.ts#L292-L305)).
- API failures are recorded as an error audit entry and surfaced as an error state; the client does not silently succeed or fall back to another source ([error handling contract](../../packages/web/src/model.ts#L42-L46), [closed error mapping](../../packages/web/src/model.ts#L733-L747)).
- For the stable client error vocabulary, consult [`STORE_ERROR_CODES`](../../packages/web/src/model.ts#L111-L133). Codes such as `E_MISSING_ALT`, `E_NOT_PREVIEW_READY`, `E_API_ERROR`, and `E_NOT_REVERSIBLE` describe distinct author-visible conditions; do not replace them with an invented fallback.

## Source trail

- [Architecture and canonical-source boundary](architecture.md)
- [Handoff Beat browser journey](../../packages/web/e2e/handoff-beat.spec.ts)
- [Authoring fixture and API seam](../../packages/web/e2e/handoff-beat.ts)
- [Authoring renderer](../../packages/web/src/template.ts)
- [Authoring event layer](../../packages/web/src/app.ts)
- [Authoring model](../../packages/web/src/model.ts)
