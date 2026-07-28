# Accessibility statement

> [Versión en español](statement.es.md) · English and Spanish are peer locales. Both siblings ship in the same pull request (zero-lag rule). See [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

This page is the V1 accessibility statement for Handoff CMS. It describes the standards the project commits to, the design references that informed the authoring surface, the automated evidence that backs the claim, and the v1.1 limitations that bound the claim. It is not a marketing page; it does not claim external validation of the neurodivergent-accessible design.

## Scope

This statement covers the open-core authoring surface — the Handoff Beat author journey, the locale-switched English and Spanish peers, the accessibility-tree contracts, and the automated checks that run against them. It does not cover third-party sites, the operator's host deployment, or any non-Apache-2.0 module.

## Standards and design references

The authoring surface is built against the following primary sources, retrieved 2026-07-28.

- **WCAG 2.2 conformance.** The W3C Web Content Accessibility Guidelines 2.2 are the conformance target for the authoring client. The conformance bar is AA. <https://www.w3.org/TR/WCAG22/>
- **ATAG 2.0 (Authoring Tool Accessibility Guidelines).** Because the Handoff Beat is an authoring tool, the project follows ATAG 2.0 for the author surface. <https://www.w3.org/TR/ATAG20/>
- **W3C COGA — Making Content Usable for People with Cognitive and Learning Disabilities.** The cognitive accessibility design patterns from the W3C COGA work inform the low-distraction, reduced-motion, plain-language, and reversible-ops affordances. <https://www.w3.org/TR/coga-usable/>

Citations follow the same disciplined pattern as the rest of the documentation tree; see [`../README.md`](../README.md). A claim that depends on one of these primary sources is cited inline.

## V1 wording (exact)

The project status is captured in the i18n catalog. The exact wording used through the product is:

> **“neurodivergent-accessible by design”**

This is a design stance, not a claim of external participant validation. The exact V1 limitation wording is:

> **“External validation is planned for v1.1.”**

The catalog and the browser evidence files reference these two phrases verbatim; do not paraphrase them in derivative material. See the English catalog at `packages/i18n/src/index.ts` and the browser evidence at `artifacts/g008/desktop/handoff-beat-en.json` (and the matching `tablet` and `mobile` artifacts).

## Browser evidence (axe)

The V1 Handoff Beat journey is exercised by Playwright Chromium across three viewports (desktop, tablet, mobile) and two locales (English, Spanish). Each run captures:

- an axe-core scan with the rule set shipped by `@axe-core/playwright`,
- an accessibility-tree snapshot,
- a full-page screenshot,
- an automation transcript,
- a localized `html[lang]` assertion,
- a Tastecheck verdict.

The verified state at `2026-07-27T21:18:49.543Z` (artifact `artifacts/g008/workspace-test-report.json`) reports **zero axe violations** across the six projects (desktop/tablet/mobile × en/es). The matching browser artifacts sit under `artifacts/g008/{desktop,tablet,mobile}/handoff-beat-{en,es}.{json,png}`.

The first-party node-only dependency used for axe scanning is `@axe-core/playwright`. The dependency graph is intentional: the runtime license allowlist is Apache/MIT/BSD/ISC, and both `@axe-core/playwright` and the underlying `axe-core` tooling are admitted as documented dev-only MPL-2.0 exceptions to that allowlist. The licensing guard is part of the verified workspace evidence (`node packages/licensing-guard/dist/index.js --root . --json` — 14 packages, 0 findings). Both exceptions are scoped to development and are absent from the production runtime; neither MPL-2.0 dependency ships with the deployed authoring client. See [`../how-to/quickstart.md`](../how-to/quickstart.md) for the licensing-guard command and the rest of the verified command set.

## What the V1 surface does

- **Native semantic landmarks and real labeled controls.** The authoring template uses real form controls with labels, native landmarks, and the same surface in English and Spanish. The accessibility tree is the contract that the browser evidence checks.
- **Keyboard reachability and focus management.** The journey is keyboard-complete: it moves focus, restores focus after commands, and moves focus to the error summary when an action is blocked.
- **Peer-locale parity.** English and Spanish are peers; missing values are rejected, not silently defaulted. The translator parity check (`assertCatalogParity` in `@cms/i18n`) fails the build on missing keys.
- **Reversible operations.** A clearly bounded local undo reverses unsubmitted edits; a separately authorized rollback reverses a committed proposal. The two are distinct and the author surface never offers the governed rollback as a button.
- **Plain language and low-distraction preferences.** Reduced-motion and low-distraction preferences are explicit author settings; the journey honors them.
- **Live-region announcements.** Success and error states announce through polite live regions; errors are summarized in a single region and move focus to that region.

## What V1 does not claim

- **No external accessibility claim.** The product is not presented as externally validated for any specific accessibility population. The exact catalog wording is “neurodivergent-accessible by design” and the v1.1 limitation is “External validation is planned for v1.1.” Do not market-display phrasing that goes beyond this.
- **No second-adapter conformance.** A second independent adapter is the v1.1 conformance gate, not a V1 completion claim. The adapter contract is frozen in its invariant-bearing core, but the second-adapter evidence is not in V1.
- **No third-party certified coverage.** WCAG 2.2 AA conformance is the bar; conformance is asserted by automated and CI checks (axe-core, keyboard reachability, locale parity), not by an external accessibility audit.

## v1.1 follow-ups

1. External participant validation for the neurodivergent-accessible design.
2. A second independent adapter to harden the contract (`field_capabilities`, `DeployCapability`) from 1.0-beta/RC to 1.0.
3. Any finding from the security reviewer's audit-envelope review that affects accessibility assertions.

## Evidence

- W3C — Web Content Accessibility Guidelines (WCAG) 2.2 — <https://www.w3.org/TR/WCAG22/>
- W3C — Authoring Tool Accessibility Guidelines (ATAG) 2.0 — <https://www.w3.org/TR/ATAG20/>
- W3C — Making Content Usable for People with Cognitive and Learning Disabilities (COGA) — <https://www.w3.org/TR/coga-usable/>
- V1 catalog wording — `packages/i18n/src/index.ts`
- Browser evidence — `artifacts/g008/{desktop,tablet,mobile}/handoff-beat-{en,es}.{json,png}`
- Workspace verification report — `artifacts/g008/workspace-test-report.json`
- Licensing guard — `packages/licensing-guard/`
