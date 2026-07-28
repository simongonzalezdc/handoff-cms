# Pull request

> **Canonical repository.** This pull request opens on the canonical Forgejo
> repository at `https://git.kyanitelabs.tech/simon/handoff-cms`. The GitHub
> repository at `https://github.com/simongonzalezdc/handoff-cms` is a read-only
> mirror; pull requests are not merged there. Branches, tags, and release
> notes are cut on Forgejo.

> **Security.** A pull request that exposes a vulnerability, a real secret,
> or a value that could identify a real deployment is a security incident.
> Stop the public pull request and follow
> [`SECURITY.md`](https://git.kyanitelabs.tech/simon/handoff-cms/blob/main/SECURITY.md)
> on the canonical repository. The docs-QA gate `DR6` forbids real secrets in
> prose. The CI workflow at `.forgejo/workflows/docs-qa.yml` runs
> `pnpm docs:check` and `pnpm test:docs` on every pull request; the mirror
> workflow at `.github/workflows/docs-qa.yml` runs the same contract.

## What this PR changes

- [ ] Code under `packages/*/src/**`
- [ ] Runtime tests under `packages/*/test/**`
- [ ] Documentation only — proceeds to the docs-QA checklist below
- [ ] Forward-port to the ESLint / Vitest / Playwright suite
- [ ] Forward-port to the release / changelog

## Documentation impact (only if documentation changed)

The docs-QA gates at [`docs/project/docs-qa.md`](https://git.kyanitelabs.tech/simon/handoff-cms/blob/main/docs/project/docs-qa.md)
define the contract. Tick only the gates that this PR touches; a gate that
fails blocks the PR. The same-PR EN/ES zero-lag rule forbids changing only
one sibling — both `*.md` and `*.es.md` ship in this pull request.

- [ ] `DR1` — Link integrity. No broken relative, absolute, or anchor links.
- [ ] `DR2` — EN/ES parity. The two siblings match in headed structure and prose shape.
- [ ] `DR3` — Link parity. The link topology of the EN and ES peers is identical.
- [ ] `DR4` — Forbidden phrases. No `production-hardened`, `fully validated`, `deployed at scale`, `battle-tested`, `enterprise-grade`, or `mission-critical`.
- [ ] `DR5` — Claim / source citation. Every `verified` / `passing` / `tested` / `supported` sentence cites `artifacts/g008/workspace-test-report.json` or the documentation page that records it.
- [ ] `DR6` — Secret-safe source. No real secret, identifier, or copied request/log value.
- [ ] `DR7` — OpenAPI discovery. If the API surface or the audit envelope moved, `docs/reference/openapi.json` and `docs/reference/audit-envelope.md` are updated in the same pull request.
- [ ] `SRC1` — Discovery-sweep parity. If a closed union moved, `docs/reference/error-codes.md` and the twelve-union table at `docs/project/docs-qa.md` are updated in the same pull request.

### Locale impact

The pull request ships both peers. The reviewer is the role named at the
docs-QA lane that owns the page; the role signs off in the same review
event.

- EN peer: `docs/<area>/<page>.md`
- ES peer: `docs/<area>/<page>.es.md`
- Lane owner role: `docs:<parity | glossary | contributing | security | api | architecture | howto | overview>`
- Spanish-reading reviewer: <name> (signs off on neutral-Spanish glossary use)

## Evidence

The docs-QA gate `DR5` requires that any claim beginning with `verified`,
`passing`, `tested`, or `supported` cites the evidence ledger at
`artifacts/g008/workspace-test-report.json` or the documentation page that
records it. The minimum trace is one of the seven verified commands from
the latest ledger, or a pointed reference to the affected source line.

```sh
# At least one of the seven verified commands, or the precise failing command
$ pnpm docs:check
$ pnpm test:docs
```

## Reviewer checklist

- [ ] Independent reviewer (not the author) is assigned on the canonical Forgejo repository.
- [ ] EN `*.md` and ES `*.es.md` siblings both changed in this PR.
- [ ] The docs-QA lane owner role sign-off is recorded on the PR review.
- [ ] No real secret, identifier, or copied request/log value is attached.
- [ ] CI on the canonical Forgejo repository is green (`pnpm docs:check`, `pnpm test:docs`).

## Related

- Closes #<issue>
- Depends on #<issue>
- Blocked by #<issue>
