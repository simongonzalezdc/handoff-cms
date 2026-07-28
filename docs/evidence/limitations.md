# Limitations ledger

> **Audience:** security reviewers, integrators, and downstream
> operators who need the exact, unweakened list of boundaries the
> `g008` verification did not cross. This page is information-oriented
> (Diátaxis evidence). Every limitation below is copied verbatim from
> `artifacts/g008/workspace-test-report.json` `limitations[]`. The
> page does not invent additional caveats.

## The three reported limitations

The `g008` report carries exactly three limits on its `results`. They
are reproduced below without paraphrase, in the same order the report
lists them.

1. **Docker daemon execution was unavailable; Compose
   interpolation/config validation, runtime package tests, and
   healthcheck syntax passed.**

   The Compose stack passed only config-level validation. The report
   does not record a live Docker daemon-backed image build or runtime.
   The `docker compose -f compose.yaml config --quiet` exit is a
   documented, non-secret validation seam; it does not assert that an
   image built, started, or served traffic.

2. **Neurodivergent-accessible by design; external participant
   validation is a v1.1 goal.**

   The accessibility wording for the V1 release is "by design". No
   external participant study, formal ATAG conformance audit, or
   external cognitive-accessibility review is claimed. The Playwright
   matrix in `g008` exercised automation-time checks (axe, tastecheck,
   keyboard traversal) on Chromium viewports, not external-participant
   evaluation. The external participant study is explicitly deferred
   to v1.1.

3. **The second independent adapter remains the v1.1
   contract-validation gate.**

   Conformance is asserted against the single shipped Cerafica
   reference adapter. There is no second independent adapter today;
   until there is one, the conformance gate is not yet exercised
   across two independent implementations. The v1.1 release is the
   work that introduces the second adapter.

## Where each limitation is acknowledged

The same wording is referenced wherever a reviewer might otherwise
overreach. The list below is not a new claim; it is a navigation aid
so the limitation can be found wherever the doc tree makes an
adjacent assertion.

| Page | Section | Acknowledgment |
| --- | --- | --- |
| [`docs/overview.md`](../overview.md) | "Where to go next" | Notes the verification and limitations pages as the source of truth. |
| [`docs/overview.es.md`](../overview.es.md) | "Dónde ir a continuación" | Mismo enlace al registro de evidencias y al de limitaciones. |
| [`docs/README.md`](../README.md) | "Source / claim discipline" | States the three limitations are repeated wherever a claim would otherwise overreach. |
| [`docs/how-to/quickstart.md`](../how-to/quickstart.md) | Bring-up sequence | The seven commands are the validated bring-up; the Docker daemon limitation is acknowledged because no live Docker run is recorded. |
| [`docs/how-to/quickstart.es.md`](../how-to/quickstart.es.md) | Secuencia de puesta en marcha | La limitación del demonio de Docker se reconoce en el mismo lugar. |
| [`docs/accessibility/statement.md`](../accessibility/statement.md) | Wording source | The "neurodivergent-accessible by design" wording is the V1 source of truth; external participant validation is v1.1. |
| [`docs/accessibility/statement.es.md`](../accessibility/statement.es.md) | Origen de la redacción | El formulismo "neurodivergent-accessible by design" es la fuente V1; la validación externa se difiere a v1.1. |

## How the ledger stays honest

The ledger is a mirror. Numbers, commands, and limitations come
verbatim from `artifacts/g008/workspace-test-report.json`. When that
artifact is regenerated, this page is regenerated in the same pull
request. The page never claims a result that the artifact does not
support, and the three limitations are not weakened, summarized, or
dropped.
