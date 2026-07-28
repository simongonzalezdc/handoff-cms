# Final documentation campaign evidence

> **Audience:** maintainers, independent reviewers, and release auditors who need the final documentation/release campaign record. This evidence page is English-only under the explicit `docs/evidence/*` locale exemption. Its structured source is [`../../artifacts/docs/final-documentation-campaign-report.json`](../../artifacts/docs/final-documentation-campaign-report.json).

## Verified facts

The completed campaign is recorded at the full `main` commit `ee10e1de26f73ffcde8f6b88ce171786ff3e6315`. The canonical repository is Forgejo at <https://git.kyanitelabs.tech/simon/handoff-cms>; GitHub at <https://github.com/simongonzalezdc/handoff-cms> is the public mirror. Forgejo `main` and GitHub `main` resolved to that identical hash.

Change control remained atomic and human-authorized:

- atomic pull requests: `6`, `7`, and `8`;
- independent review references: `296`, `298`, and `301`;
- human approval remained required; passing automation did not authorize a merge or release.

Exact receipt and ledger-event identifiers are preserved in the linked structured campaign report. Keeping those opaque identifiers out of prose also lets the documentation secret scanner remain fail-closed for UUID-shaped literals.

Final verification evidence records:

| Surface | Exact result |
| --- | --- |
| Typecheck | `13` package projects |
| Build | `13` package projects |
| Unit and integration tests | `1178` tests in `28` files; [`final-vitest-report.json`](../../artifacts/docs/final-vitest-report.json) records `211/211` suites and `1178/1178` tests passed |
| Licensing | `14` workspace packages, `0` findings |
| Documentation tests | `38/38` passed |
| Documentation QA | `22/22` passed |
| Browser E2E | `12/12` passed |

These are completed-run counts, not a claim that the deferred runtime or external-validation boundaries below were crossed.

## Learnings

1. **Preserve host canonical truth.** Forgejo is authoritative for issues, pull requests, reviews, releases, and the canonical branch. GitHub is a mirror; host labels and links must not imply otherwise.
2. **Keep human approval explicit.** Automation may collect evidence, but it cannot supply the human authority required to merge or release.
3. **Maintain EN/ES zero-lag without silent fallback.** English and Spanish peers ship together. Missing locale content must surface as a failure rather than silently substituting another locale. This campaign page is EN-only solely because `docs/evidence/*` has an explicit exemption.
4. **Derive bidirectional parity from source.** Documentation must cover every source-defined closed surface, and every documented member must exist in source; a one-way presence check is insufficient.
5. **Fail closed on evidence.** Missing, malformed, stale, or inconsistent required proof must block the claim instead of degrading to an assumed pass.
6. **Use atomic PR and independent-review discipline.** Small change boundaries and distinct review references make authorship, approval, and final state traceable.
7. **Hash-commit actual path sets.** An audit receipt must commit the exact paths it attests, not a proxy list or a differently resolved set.
8. **Pin base and head before interpreting an empty diff.** Worktree alignment can legitimately yield no changes; explicit base/head identities distinguish alignment from a missing comparison.
9. **Classify runner startup failures correctly.** An executor that never starts produces infrastructure evidence, not evidence of a product failure.

## Limitations

The campaign does **not** claim any of the following:

- **Docker daemon runtime:** no daemon-backed image build, container startup, or served-traffic result was verified; Docker runtime remains unverified and deferred.
- **External participant testing:** no external participant study or external accessibility validation was performed; it remains unverified and deferred.
- **Second adapter:** no second independent adapter was verified; that conformance boundary remains deferred.

Browser E2E automation is not external participant validation. Configuration, syntax, package, or browser checks are not a Docker daemon runtime claim.

## Reproducible commands

The structured report records the command surfaces associated with the final counts. Run them from the repository root at the pinned commit; do not infer a pass from this page when reproducing them on another revision.

```sh
pnpm typecheck
pnpm build
pnpm test
node packages/licensing-guard/dist/index.js --root . --json
pnpm test:docs
pnpm docs:check
pnpm test:e2e
```

The campaign deliberately records no Docker runtime reproduction command because Docker daemon execution remains outside the verified boundary.
