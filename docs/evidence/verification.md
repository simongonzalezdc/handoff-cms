# Verification ledger

> **Audience:** security reviewers and downstream operators who need
> the exact commands and counts that `g008` shipped as the
> release-quality verification of the product. This page is
> information-oriented (Diátaxis evidence). Every number on this page
> is taken verbatim from
> `artifacts/g008/workspace-test-report.json`, which is the committed
> source of truth. The page does not invent any additional claim.

## Source artifact

| Field | Value |
| --- | --- |
| Path | `artifacts/g008/workspace-test-report.json` |
| Schema version | `1` |
| Kind | `api-package-test-report` |
| Verified at | `2026-07-27T21:18:49.543Z` |
| Workspace | `/Users/simongonzalezdecruz/workspaces/handoff-cms` |

## Commands (exactly seven)

The seven verified commands below are the canonical execution trace
`g008` claims against the release-quality workspace. Each row is
copied verbatim from `results[*]` in the report. No additional commands
are claimed.

| # | Command | Status | Scope |
| --- | --- | --- | --- |
| 1 | `pnpm typecheck` | `passed` | `13` package projects |
| 2 | `pnpm test` | `passed` | `27` test files, `899` tests |
| 3 | `pnpm build` | `passed` | `13` package projects |
| 4 | `node packages/licensing-guard/dist/index.js --root . --json` | `passed` | `14` workspace packages, `0` findings |
| 5 | `pnpm test:e2e` | `passed` | `6` tests across `desktop-chromium`, `tablet-chromium`, `mobile-chromium` in `en` and `es` |
| 6 | `docker compose -f compose.yaml config --quiet` | `passed` | `non-secret validation-only substitutions` |
| 7 | `node --check scripts/self-host-healthcheck.mjs` | `passed` | — |

Summary count: **seven** commands, all `passed`.

## Counts

The numbers below are the exact counts carried in the report.

| Metric | Value | Source field |
| --- | --- | --- |
| Workspace packages (license guard scan) | `14` | `results[3].workspacePackages` |
| License-guard findings | `0` | `results[3].findings` |
| Test files | `27` | `results[1].testFiles` |
| Tests | `899` | `results[1].tests` |
| Package projects (`typecheck` and `build`) | `13` | `results[0].scope`, `results[2].scope` |
| E2E tests | `6` | `results[4].tests` |
| E2E projects | `desktop-chromium`, `tablet-chromium`, `mobile-chromium` | `results[4].projects` |
| E2E locales | `en`, `es` | `results[4].locales` |
| Axe violations | `0` | `results[4].axeViolations` |
| Tastecheck verdicts | `["CLEAN"]` | `results[4].tastecheckVerdicts` |
| Commands run | `7` | `results.length` |
| Commands passed | `7` | all entries have `status === "passed"` |
| Commands failed | `0` | — |

## Browser evidence

The `pnpm test:e2e` command emitted the artifacts shown below. The
relative paths are exactly the ones the report points at.

- `artifacts/g008/desktop/handoff-beat-en.json`
- `artifacts/g008/desktop/handoff-beat-en.png`
- `artifacts/g008/desktop/handoff-beat-es.json`
- `artifacts/g008/desktop/handoff-beat-es.png`
- `artifacts/g008/tablet/handoff-beat-en.json`
- `artifacts/g008/tablet/handoff-beat-en.png`
- `artifacts/g008/tablet/handoff-beat-es.json`
- `artifacts/g008/tablet/handoff-beat-es.png`
- `artifacts/g008/mobile/handoff-beat-en.json`
- `artifacts/g008/mobile/handoff-beat-en.png`
- `artifacts/g008/mobile/handoff-beat-es.json`
- `artifacts/g008/mobile/handoff-beat-es.png`

Each per-locale browser artifact carries a `tastecheck.gate.verdict`
of `CLEAN` and a `finalState` of `live`. The page does not re-claim
those payloads; the artifacts are the source of truth.

## Boundary

The report is the only claim ledger for `g008`. The seven commands
above are the only commands the report executed. The three
limitations in [`docs/evidence/limitations.md`](limitations.md) are
the only caveats the report itself records, and this page does not
weaken them. A claim that depends on a result not present in this
report is out of scope for this page.
