# Audit envelope

> **Audience:** integrators and security reviewers who need the closed
> contract for the tamper-evident audit envelope produced by
> `@cms/audit` and the storage-layer append-only guarantee that pins
> it. This page is information-oriented (Diátaxis reference). It mirrors
> `packages/audit/src/canonical.ts`, `packages/audit/src/jws.ts`, and
> `packages/audit/src/index.ts` line-for-line, and the
> `cms_storage.audit_events` triggers in
> `packages/storage/migrations/0001_governance.sql`.

> [Versión en español](audit-envelope.es.md) · English and Spanish
> are peer locales. Both siblings ship in the same pull request
> (zero-lag rule). See
> [`../README.md#same-pr-enes-zero-lag`](../README.md#same-pr-enes-zero-lag).

## What `@cms/audit` is

`@cms/audit` is the package that produces an immutable, offline-verifiable
audit envelope for every governance action. The envelope has three
layers:

1. **Canonical bytes** for the event shape, produced by a deterministic
   serializer with a closed value whitelist.
2. **Detached Ed25519 JWS** over those canonical bytes, with the
   signing key identified by a `kid` carried in the protected header.
3. **A persisted event hash** that is the primary key of the
   `cms_storage.audit_events` table and is enforced append-only by
   Postgres triggers.

The package is **not** a transport. It accepts already-built events,
serializes them, signs them, and verifies them. A failure to write the
envelope surfaces through the same `StorageError` / `ApiErrorCode`
machinery as any other storage or API failure; `@cms/audit` carries no
error vocabulary of its own. See
[`error-codes.md`](error-codes.md#audit-has-no-stable-error-code-union)
for the closed-union catalog and the explicit omission of audit.

## Canonical bytes

The canonical serializer lives in `packages/audit/src/canonical.ts`.

| Rule | Source line |
| --- | --- |
| Object keys sorted lexicographically by UTF-16 code unit order | `canonical.ts:5`, `canonical.ts:113` |
| Arrays preserve order | `canonical.ts:6`, `canonical.ts:105-110` |
| Closed value whitelist: finite numbers, non-empty strings, booleans, `null`, arrays, plain objects | `canonical.ts:7-13`, `canonical.ts:43-87` |
| `NaN` and `±Infinity` rejected before encoding and re-checked in the rendered string | `canonical.ts:14`, `canonical.ts:53-58`, `canonical.ts:95-103` |
| `BigInt`, `Symbol`, `function`, `undefined`, Dates, Maps, Sets, and non-`Object.prototype` objects rejected | `canonical.ts:15-16`, `canonical.ts:50-69`, `canonical.ts:74-83` |
| Output is the UTF-8 encoding of one JSON value, no trailing newline | `canonical.ts:18`, `canonical.ts:124-128` |
| Number rendering uses Node 22's `JSON.stringify` shortest round-trip form; changing it requires re-auditing the scope | `canonical.ts:20-27` |
| `canonicalNDJSON` joins events with a single `0x0a` byte and no trailing newline | `canonical.ts:130-154` |
| `contentHash` is lowercase hex SHA-256 over the canonical bytes, computed once | `canonical.ts:28-31`, `canonical.ts:156-163` |

`assertSupported` and `canonicalJSON` walk the value tree together so
that unsupported shapes never reach the encoder. The closed whitelist
is the only contract; a value that passes `canonicalize` is bit-identical
across processes for the same input.

## Detached Ed25519 JWS

The detached JWS lives in `packages/audit/src/jws.ts`. It is RFC 7515
shaped with RFC 7797 unencoded payload (`b64: false`) and RFC 8037
Ed25519.

| Header field | Value | Source |
| --- | --- | --- |
| `alg` | `EdDSA` (literal, anything else rejected) | `jws.ts:35`, `jws.ts:215-216` |
| `kid` | opaque UTF-8 string from `SignOptions.kid` | `jws.ts:41-43`, `jws.ts:73-84`, `jws.ts:218-220` |
| `crit` | `["b64"]` (exact, including order) | `jws.ts:36`, `jws.ts:222-227` |
| `b64` | literal `false` | `jws.ts:43`, `jws.ts:228-230` |
| Unknown header parameters | rejected | `jws.ts:211-213` |

The signing input is `BASE64URL(protected_header) || "." || payload_bytes`
where `payload_bytes` are the canonical bytes from `canonicalize`. The
JWS object stores:

- `protected`: base64url (no padding) of the JSON-encoded protected header.
- `signature`: base64url (no padding) of the 64-byte Ed25519 signature.

`generateEd25519KeyPair(kid)` produces a PEM PKCS#8 private key and a
PEM SPKI public key. Anything other than `asymmetricKeyType === 'ed25519'`
is rejected at both `signDetached` and `verifyDetached`.

## Envelope shape

The `AuditEvent` envelope is the closed shape that gets signed.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `v` | `1` | yes | Schema version, always literal `1`. |
| `proposalHash` | 64-char lowercase hex | yes | MUST equal `contentHash(event.proposal)`. Mismatch is a hard `AuditError`. |
| `tenant` | lowercase slug | yes | `^[a-z0-9][a-z0-9._-]{0,63}$`. |
| `actor` | lowercase id | yes | `^[a-z0-9][a-z0-9._:-]{0,127}$`. |
| `delegatedHuman` | string id | optional | Omitted entirely from canonical bytes when absent. When `selfApproved: true`, must be absent. |
| `proposal` | object | yes | `{ ref, title, fields }` where `fields` canonicalizes. |
| `approval` | object | yes | `{ approver, at, note? }`. `at` is unix seconds. |
| `selfApproved` | boolean | yes | When `true`, `approval.approver === actor` and no `delegatedHuman`. |
| `hostResult` | object | yes | `{ status, artifactHash, artifactRef }`. |
| `deployResult` | object | yes | `{ status, at, rolledBackFrom? }`. |
| `rollbackLineage` | array of `{ id, reason }` | yes | Empty array is valid. Each `id` is 64-char hex. |

Source: `packages/audit/src/index.ts:53-129`.

### `HostResultStatus` (event-status enum)

The host-asserted outcome uses a closed three-value enum:

```ts
export type HostResultStatus = 'committed' | 'skipped' | 'failed';
```

Source: `packages/audit/src/index.ts:69`.

### `DeployResult.status` (event-status enum)

The deploy step uses a closed three-value inline property on `DeployResult`:

```ts
interface DeployResult {
  status: 'deployed' | 'rolled-back' | 'noop';
}
```

Source: `packages/audit/src/index.ts:91-98`. There is no separately exported `DeployResultStatus` type.

The two closed status sets above are the only event-status shape codes emitted by
`@cms/audit`. They are status values, not error codes. There is no
corresponding `errorMessage` or `errorCode` field on the envelope; a
`failed` host result is the host's own assertion that the canonical
write attempt was not committed, and the rest of the audit record is
still signed.

## Signature flow

| Step | Function | Source |
| --- | --- | --- |
| Compute canonical bytes and event id | `canonicalizeEvent(event)` returns `{ id, bytes }` | `index.ts:315-320` |
| Sign canonical bytes | `signDetached(bytes, privateKeyPem, { kid })` returns `{ protected, signature }` | `jws.ts:116-147` |
| Wrap a signed envelope | `signEvent(event, privateKeyPem, kid)` returns `{ event, eventId, signature }` | `index.ts:346-354` |
| Deep-copy a validated event | `buildEvent(input)` returns a `structuredClone` | `index.ts:333-336` |
| Recompute canonical bytes for a fresh input | `canonicalizeEvent` runs `validateAuditEvent` first | `index.ts:315-320` |

`signEvent` signs the canonical bytes derived from the event shape, not
a runtime JSON serialization. The `eventId` is `contentHash(event)` in
lowercase hex (64 chars), and the canonical bytes that produced it are
the exact bytes that go into the JWS signing input.

## Verification flow

`verifyEnvelope(envelope, publicKeyPem)` returns a `boolean`. It never
throws for a malformed envelope. The contract is:

| Condition | Result |
| --- | --- |
| `envelope` not an object | `false` |
| `validateAuditEvent(envelope.event)` throws `AuditError` / `CanonicalError` / `JwsError` | `false` |
| `eventId` (recomputed from canonical bytes) does not equal `envelope.eventId` | `false` |
| `proposalHash` does not equal `contentHash(event.proposal)` | `false` (raised by `validateAuditEvent`) |
| Protected header does not parse, has unknown params, `alg !== 'EdDSA'`, `b64 !== false`, or `crit` is not exactly `["b64"]` | `false` |
| Detached JWS over the canonical bytes does not verify against the supplied public key | `false` |
| All of the above pass | `true` |

Source: `packages/audit/src/index.ts:375-405` and
`packages/audit/src/jws.ts:149-203`.

The `eventId` returned in the envelope is **not** trusted from input:
it is recomputed from the canonical bytes of `envelope.event`. A
forged envelope with a stale `eventId` therefore fails verification on
the recomputed hash, before the JWS check runs.

### `kid` resolution

Verification is performed against a single public key supplied by the
caller. The `kid` carried in the protected header is opaque UTF-8;
`@cms/audit` does not perform key lookup, rotation, or trust-store
management. Callers that need a `kid -> publicKey` map must resolve it
out of band and pass the matching `publicKeyPem` to `verifyEnvelope`.
The header fact that the signer used a given `kid` is the only signal
a verifier has to know which key to look up.

## Errors (free-form, no stable codes)

`@cms/audit` exports three error classes, none of which participates in
a closed union catalog:

| Class | Module | Purpose |
| --- | --- | --- |
| `AuditError` | `packages/audit/src/index.ts:147-152` | Thrown for construction-time or validation failures from `validateAuditEvent`, `buildEvent`, `signEvent`, and the `requireX` helpers. |
| `CanonicalError` | `packages/audit/src/canonical.ts:36-41` | Thrown by `assertSupported`, `canonicalJSON`, `canonicalize`, `canonicalNDJSON`, and `contentHash` when an unsupported value reaches the encoder. |
| `JwsError` | `packages/audit/src/jws.ts:28-33` | Thrown for header parsing, key parsing, key-type mismatch, and unsupported algorithm signals inside `signDetached` and `verifyDetached`. |

`@cms/audit` does not export a closed `*_ERROR_CODES` runtime array.
The free-form `message` on each class is for humans only; no caller
should pattern-match on it. The `verifyEnvelope` rejection path returns
`false` and does not raise. Writing the envelope, when it fails, raises
out of the `StorageError` / `ApiErrorCode` machinery that the rest of
the system already uses. See the explicit omission note in
[`error-codes.md`](error-codes.md#audit-has-no-stable-error-code-union).

## Append-only storage

The persisted audit table is `cms_storage.audit_events`. The schema
constants live in `packages/storage/src/schema.ts:581-622` and the
triggers in `packages/storage/migrations/0001_governance.sql:583-605`.

| Property | Source |
| --- | --- |
| Primary key is `event_hash` (64-char lowercase hex) | `schema.ts:585` |
| `event` is a `jsonb` object stored alongside the independently computed `event_hash`; SQL does not assert that one hashes to the other | `schema.ts:602-603` |
| `schema_version` is `1` and `CHECK`-bounded to `[1, 65535]` | `schema.ts:598`, `schema.ts:618` |
| `jsonb_typeof(event) = 'object'` enforced at the SQL layer | `schema.ts:619` |
| `selfApproved = false OR delegated_human_actor_id IS NULL` enforced at the SQL layer | `schema.ts:620` |
| Foreign keys to `tenants`, `actors`, `proposals`, `approvals` are `ON DELETE RESTRICT` | `schema.ts:612-616` |
| `event_hash ~ '^[0-9a-f]{64}$'` enforced at the SQL layer | `schema.ts:617` |

| Trigger | Event | Source |
| --- | --- | --- |
| `audit_events_no_update` | BEFORE UPDATE | `0001_governance.sql:595-597` |
| `audit_events_no_delete` | BEFORE DELETE | `0001_governance.sql:599-601` |
| `audit_events_no_truncate` | BEFORE TRUNCATE | `0001_governance.sql:603-605` |

All three triggers call `cms_storage.reject_mutation`
(`0001_governance.sql:583-593`), which raises SQLSTATE `P0001` with the
marker text `cms_storage.audit_events is append-only; UPDATE/DELETE is
not permitted (op=..., SQLSTATE=P0001)`. The storage layer classifies
that SQLSTATE as `AppendOnlyViolationError` and surfaces it as
`StorageError('append_only_violation', ...)`.

Verification of the append-only property is done at the SQL layer, not
in Node code. The CMS does not enforce immutability by convention; it
enforces it by trigger and by `RESTRICT` foreign keys. An operator
who needs to physically remove a row must drop the trigger, perform
the deletion, and re-create the trigger; this is documented as an
operator workflow, not a normal API path.

## Sequence at the API boundary

The API layer (`packages/api/src/index.ts:1144-1181`) is the only
caller of `storage.appendAuditEvent` today. It stores a narrow `event` object
(`kind` plus transition/publication identifiers) and computes the row's
`eventHash` with SHA-256 over that object plus tenant, actor, proposal,
approval, and timestamp fields using `JSON.stringify`.

This API audit row and the portable `@cms/audit` `AuditEvent` are **independent
V1 representations**. The API does not import `@cms/audit`, canonicalize an
`AuditEvent`, sign one, or persist a mapping between the two hashes.
`@cms/audit` hashes canonical bytes of a different, richer envelope. Therefore
the hashes are not equal and `eventHash` is not a join key to a signed
envelope. The API row is protected by append-only SQL controls; portable
envelope signing remains a package capability without production API wiring
in V1.

## Composer for a portable export

A reviewer who wants to verify a record offline concatenates the
canonical bytes of the event with the detached JWS and the public key
identified by `kid`. The `canonicalNDJSON` helper
(`packages/audit/src/canonical.ts:130-154`) emits a single NDJSON blob
for a list of events; the per-event `canonicalize` is the same code
that signing and verification both use, so a verifier and a signer are
guaranteed to agree on the byte sequence for any given valid event.

## Where the two representations are consumed

| Consumer | Surface | Source |
| --- | --- | --- |
| API audit row persistence | `cms_storage.audit_events` insert | `packages/storage/src/index.ts:1957-1986` |
| Audit row read by `eventHash` | `getAuditEventByHash` | `packages/storage/src/index.ts:1988-1995` |
| Per-proposal audit listing | `listAuditEventsForProposal` | `packages/storage/src/index.ts:1997-2004` |
| Hash computation for API rows | `sha256Hex` in `appendAudit` | `packages/api/src/index.ts:1187-1189` |
| Portable `@cms/audit` envelope | `verifyEnvelope`, `verifyDetached`, `signEvent` package tests; no production API caller in V1 | `packages/audit/test/audit.test.ts` |

The MCP, CLI, and web surfaces never read or write either representation
directly; they go through the API. V1 does not claim a unified hash identity
between the API row and the portable signed envelope.
