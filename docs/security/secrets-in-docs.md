# Secrets in documentation

> **Audience:** documentation authors and security reviewers. This page is the
> source-safe policy for examples, excerpts, screenshots, and review notes. It
> does not define a credential store or an incident-response service.
>
See the [security reviewer on-ramp](reviewer-on-ramp.md) ·
[`.es`](reviewer-on-ramp.es.md) for the bilingual reviewer navigation. The
on-ramp ES sibling links back to this English page so reviewers in both
locales reach the same rule without a silent fallback.
## Policy

Documentation MUST NOT contain a real secret or a value that could identify a
real deployment. This includes bearer tokens, OIDC or database credentials,
object-store keys, private keys, cookies, signed URLs, tenant or customer
identifiers, account identifiers, proposal identifiers, UUIDs, and copied
request or log values. A value can be sensitive even when it is expired,
partially masked, or described as a test value.

Use names of environment variables and types to explain a contract, but use
only `replace-with-*` placeholders for values in examples. The placeholder
must make the value's role clear and must not resemble a live credential. For
example, `replace-with-tenant-id` is safe; a random-looking identifier is not.
Do not combine a placeholder with a real host, issuer, tenant, token, or
credential copied from an operator environment.

This is a documentation boundary, not a claim that the runtime can detect all
secrets in prose. Authors and reviewers are responsible for keeping the source
safe before publication.

## Safe examples

The following values are intentionally placeholders. They are illustrative
shapes only; they are not a ready-to-run deployment:

```dotenv
CMS_DATABASE_URL=postgres://replace-with-db-user:replace-with-db-password@replace-with-db-host:5432/replace-with-db-name
CMS_OIDC_ISSUER=https://replace-with-oidc-issuer.example/
CMS_OIDC_AUDIENCE=replace-with-oidc-audience
CMS_OIDC_JWKS_URL=https://replace-with-oidc-issuer.example/replace-with-jwks-path
CMS_OBJECT_ACCESS_KEY_ID=replace-with-object-access-key
CMS_OBJECT_SECRET_ACCESS_KEY=replace-with-object-secret
```

A request example may show the header contract without a credential or real
identity:

```http
Authorization: Bearer replace-with-oidc-token
X-Tenant-Id: replace-with-tenant-id
Idempotency-Key: replace-with-idempotency-key
Accept-Language: es
```

When a configuration or log result is useful to explain redaction, show the
redacted shape rather than a value:

```json
{
  "databaseUrl": "replace-with-redacted-database-url",
  "accessKeyId": "replace-with-redacted-object-access-key",
  "secretAccessKey": "replace-with-redacted-object-secret"
}
```

The runtime's own diagnostic helper redacts object-store credentials and the
password, path, and query of a database URL before logging; see
[`describeServerConfig`](../../packages/server/src/config.ts#L423-L472). That
implementation detail is safe to reference, but an output copied from a real
host is not safe to paste into this page.

## Unsafe source material

Do not paste or paraphrase a production `.env`, a CI variable dump, a bearer
header, a browser export, a signed URL, a private-key block, or an object-store
response. Do not use a real tenant name or identifier as a convenient example.
Do not retain a secret by changing only its final characters: masking a value
is not the same as replacing it. Screenshots and screen recordings need the
same treatment as text; crop or replace sensitive fields before they enter a
pull request.

Do not present a source excerpt as evidence of a control that the source does
not implement. Configuration names and code links are useful; secret values,
operator hostnames, and copied runtime traces are not. If a page needs an
unavailable value to explain a flow, use a `replace-with-*` placeholder and
state that the example is illustrative.

## Source-safe review checklist

A reviewer should check every new or changed page, code block, image, and
alt-text string:

- [ ] Every value that could identify a deployment, tenant, account, token,
      key, cookie, signed URL, or UUID is absent or replaced with a clear
      `replace-with-*` placeholder.
- [ ] No value was copied from an environment file, CI output, request header,
      browser, log stream, screenshot, or recording. Redaction markers are
      applied before the documentation artifact is created.
- [ ] Examples use the documented variable or field names, and do not imply
      that a placeholder is a valid credential or a complete production
      configuration.
- [ ] Claims have a relative link to the owning source or to an evidence page;
      the prose does not turn an operator obligation into a product guarantee.
- [ ] Error names, states, and refusal codes match the closed source unions;
      no code is invented for a convenient example.
- [ ] English and Spanish pages are updated together, with peer links that do
      not silently fall back to another locale.
- [ ] Links remain relative to the documentation tree, and a reviewer can
      navigate from the [reviewer on-ramp](reviewer-on-ramp.md) to the source
      proof and back to this policy.

If a real value is found during review, stop the documentation change, remove
the value from the working copy and review artifacts, and notify the repository
security owner using the operator's established credential-response process.
Do not reproduce the value in an issue, review comment, screenshot, or
translation. This page does not claim that deletion alone revokes a credential;
any revocation decision belongs to the responsible operator.

## References

- OWASP, [Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) (retrieved 2026-07-28).
- OWASP Top 10 A02:2021, [Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/) (retrieved 2026-07-28).
- Runtime configuration contract: [`packages/server/src/config.ts`](../../packages/server/src/config.ts).
- Security model and its explicit limitations: [`threat-model.md`](threat-model.md) · [`.es`](threat-model.es.md).
