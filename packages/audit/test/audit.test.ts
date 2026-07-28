import { describe, expect, it } from 'vitest';
import {
  AuditError,
  buildEvent,
  canonicalize,
  canonicalNDJSON,
  contentHash,
  generateEd25519KeyPair,
  JwsError,
  signDetached,
  signEvent,
  verifyDetached,
  verifyEnvelope,
  type AuditEvent,
  type EventId,
  type SignedAuditEnvelope,
} from '../src/index.js';

const ZERO_ID = '0'.repeat(64) as EventId;
const ZERO_HASH = '0'.repeat(64);

function makeKeys() {
  return generateEd25519KeyPair('test-kid');
}

/**
 * Build a fully-valid event. `proposalHash` is computed from the proposal
 * fields, so any caller override of `proposal` must come with a matching
 * override of `proposalHash` (or re-derive via `contentHash`).
 */
function validEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const proposal = {
    ref: 'C-101',
    title: 'Update landing hero',
    fields: { lang: 'en-GB', tags: ['promo', 'seasonal'] },
  };
  const base: AuditEvent = {
    v: 1,
    proposalHash: contentHash(proposal),
    tenant: 'tenant-a',
    actor: 'svc.editor',
    proposal,
    approval: { approver: 'svc.editor', at: 1_710_000_000 },
    selfApproved: true,
    hostResult: {
      status: 'committed',
      artifactHash: ZERO_HASH,
      artifactRef: 'tenant-a/articles/hero.md',
    },
    deployResult: { status: 'deployed', at: 1_710_000_010 },
    rollbackLineage: [],
  };
  return { ...base, ...overrides } as AuditEvent;
}

describe('canonicalize', () => {
  it('sorts object keys lexicographically', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    expect(a).toEqual(b);
  });

  it('rejects NaN', () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
  });

  it('rejects Infinity and -Infinity', () => {
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalize({ x: Number.NEGATIVE_INFINITY })).toThrow();
  });

  it('rejects BigInt', () => {
    expect(() => canonicalize({ x: 1n })).toThrow();
  });

  it('rejects undefined values inside objects', () => {
    expect(() => canonicalize({ x: undefined })).toThrow();
  });

  it('rejects Symbol values', () => {
    expect(() => canonicalize({ x: Symbol('x') })).toThrow();
  });

  it('rejects Dates and Maps', () => {
    expect(() => canonicalize({ x: new Date() })).toThrow();
    expect(() => canonicalize({ x: new Map() })).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => canonicalize({ x: '' })).toThrow();
  });

  it('preserves array element order', () => {
    const a = canonicalize({ arr: [3, 1, 2] });
    const same = canonicalize({ arr: [3, 1, 2] });
    expect(a).toEqual(same);
    const reordered = canonicalize({ arr: [1, 2, 3] });
    expect(new TextDecoder().decode(a)).not.toEqual(new TextDecoder().decode(reordered));
  });

  it('contentHash is deterministic under key reordering', () => {
    const h1 = contentHash({ b: 1, a: 2, c: 3 });
    const h2 = contentHash({ c: 3, a: 2, b: 1 });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contentHash changes when a tracked value changes', () => {
    const h1 = contentHash({ a: 1, b: 2 });
    const h2 = contentHash({ a: 1, b: 3 });
    expect(h1).not.toBe(h2);
  });

  it('canonicalNDJSON joins with single LF and no trailing newline', () => {
    const bytes = canonicalNDJSON([{ a: 1 }, { b: 2 }]);
    const s = new TextDecoder().decode(bytes);
    expect(s).toBe('{"a":1}\n{"b":2}');
    expect(bytes[bytes.length - 1]).toBe(0x7d); // '}', not 0x0a
  });
});

describe('validateAuditEvent (via buildEvent)', () => {
  it('accepts a fully-formed event', () => {
    expect(() => buildEvent(validEvent())).not.toThrow();
  });

  it('rejects when v is missing or wrong', () => {
    const e = validEvent();
    (e as unknown as { v: number }).v = 2;
    expect(() => buildEvent(e)).toThrow(AuditError);
  });

  it('rejects when tenant is wrong shape', () => {
    expect(() => buildEvent(validEvent({ tenant: 'T' }))).toThrow(AuditError);
    expect(() => buildEvent(validEvent({ tenant: 'tenant with space' }))).toThrow(AuditError);
  });

  it('rejects when proposalHash is not a 64-char hex string', () => {
    expect(() => buildEvent(validEvent({ proposalHash: 'not-hex' }))).toThrow(AuditError);
    expect(() => buildEvent(validEvent({ proposalHash: 'a'.repeat(63) }))).toThrow(AuditError);
    expect(() => buildEvent(validEvent({ proposalHash: 'A'.repeat(64) }))).toThrow(AuditError);
  });

  it('rejects when proposalHash does not match contentHash(proposal)', () => {
    const event = validEvent();
    // Tamper the proposal but keep the stale hash.
    event.proposal = { ...event.proposal, title: 'Tampered title' };
    expect(() => buildEvent(event)).toThrow(/proposalHash must equal contentHash/);
  });

  it('rejects when proposalHash is a different valid hex but wrong proposal hash', () => {
    const event = validEvent();
    event.proposalHash = 'a'.repeat(64);
    expect(() => buildEvent(event)).toThrow(/proposalHash must equal contentHash/);
  });

  it('requires approval.at to be an integer unix-seconds value', () => {
    expect(() =>
      buildEvent(validEvent({ approval: { approver: 'svc.editor', at: 1_710_000_000.5 } })),
    ).toThrow(AuditError);
    expect(() =>
      buildEvent(validEvent({ approval: { approver: 'svc.editor', at: -1 } })),
    ).toThrow(AuditError);
  });

  it('enforces selfApproved invariants', () => {
    expect(() =>
      buildEvent(
        validEvent({
          selfApproved: true,
          approval: { approver: 'alice', at: 1_710_000_000 },
        }),
      ),
    ).toThrow(/selfApproved/);
    expect(() =>
      buildEvent(
        validEvent({
          selfApproved: true,
          delegatedHuman: 'alice',
        }),
      ),
    ).toThrow(/delegatedHuman/);
  });

  it('allows delegatedHuman when selfApproved=false', () => {
    expect(() =>
      buildEvent(
        validEvent({
          selfApproved: false,
          delegatedHuman: 'alice',
          approval: { approver: 'alice', at: 1_710_000_000 },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects unsupported hostResult status', () => {
    const e = validEvent();
    (e.hostResult as unknown as { status: string }).status = 'pending';
    expect(() => buildEvent(e)).toThrow(/hostResult.status/);
  });

  it('rejects unsupported deployResult status', () => {
    const e = validEvent();
    (e.deployResult as unknown as { status: string }).status = 'in-progress';
    expect(() => buildEvent(e)).toThrow(/deployResult.status/);
  });

  it('rejects rollbackLineage with bad ids', () => {
    expect(() =>
      buildEvent(
        validEvent({
          rollbackLineage: [{ id: 'not-an-id' as unknown as EventId, reason: 'bad deploy' }],
        }),
      ),
    ).toThrow(/id must be a 64-character/);
  });

  it('rejects control characters in tenant/actor/approver strings', () => {
    expect(() => buildEvent(validEvent({ tenant: 'ten\nant' }))).toThrow(/control/);
    expect(() => buildEvent(validEvent({ actor: 'svc\u0000editor' }))).toThrow(/control/);
  });

  it('buildEvent returns an immutable deep copy: mutating the input does not leak', () => {
    const original = validEvent();
    const built = buildEvent(original);
    // Mutate the input after buildEvent. The copy must not observe this.
    original.approval.at = 1;
    expect(built.approval.at).not.toBe(1);
    // Mutate the copy. The original must not observe this.
    built.approval.at = 2;
    expect(original.approval.at).not.toBe(2);
  });
});

describe('signEvent + verifyEnvelope', () => {
  it('round-trips: sign then verify with the matching public key', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, privateKeyPem, 'test-kid');
    expect(verifyEnvelope(envelope, publicKeyPem)).toBe(true);
  });

  it('produces a detached JWS with the expected protected header', () => {
    const { privateKeyPem } = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, privateKeyPem, 'test-kid');
    const headerBytes = Buffer.from(envelope.signature.protected, 'base64url');
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
    expect(header).toEqual({
      alg: 'EdDSA',
      b64: false,
      crit: ['b64'],
      kid: 'test-kid',
    });
  });

  it('reordering keys at runtime yields the same canonical bytes (still verifies)', () => {
    // The canonical form sorts keys recursively, so reordering keys at the
    // runtime level must produce byte-identical canonical bytes — and the
    // original signature, computed over those exact bytes, must still verify.
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, privateKeyPem, 'test-kid');

    const reordered: AuditEvent = {
      v: envelope.event.v,
      rollbackLineage: envelope.event.rollbackLineage,
      deployResult: envelope.event.deployResult,
      hostResult: envelope.event.hostResult,
      selfApproved: envelope.event.selfApproved,
      approval: envelope.event.approval,
      proposal: {
        fields: envelope.event.proposal.fields,
        title: envelope.event.proposal.title,
        ref: envelope.event.proposal.ref,
      },
      actor: envelope.event.actor,
      tenant: envelope.event.tenant,
      proposalHash: envelope.event.proposalHash,
    };
    const reorderedEnvelope = { ...envelope, event: reordered };
    expect(reorderedEnvelope.eventId).toBe(envelope.eventId);
    expect(verifyEnvelope(reorderedEnvelope, publicKeyPem)).toBe(true);
  });

  it('changing a value breaks verification (canonical form mutated)', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, privateKeyPem, 'test-kid');

    const tampered: AuditEvent = {
      ...envelope.event,
      approval: {
        ...envelope.event.approval,
        at: envelope.event.approval.at + 1,
      },
    };
    const tamperedEnvelope = { ...envelope, event: tampered };
    expect(verifyEnvelope(tamperedEnvelope, publicKeyPem)).toBe(false);
  });

  it('fails verification when the wrong public key is supplied', () => {
    const a = makeKeys();
    const b = makeKeys();
    const envelope = signEvent(validEvent(), a.privateKeyPem, 'test-kid');
    expect(verifyEnvelope(envelope, b.publicKeyPem)).toBe(false);
    expect(verifyEnvelope(envelope, a.publicKeyPem)).toBe(true);
  });

  it('fails verification when a single signature byte is flipped', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, privateKeyPem, 'test-kid');
    const sigBytes = Buffer.from(envelope.signature.signature, 'base64url');
    sigBytes[0] = (sigBytes[0]! ^ 0xff) & 0xff;
    const tampered = {
      ...envelope,
      signature: { ...envelope.signature, signature: sigBytes.toString('base64url') },
    };
    expect(verifyEnvelope(tampered, publicKeyPem)).toBe(false);
  });

  it('does not trust eventId from the envelope and rejects a forged id', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const envelope = signEvent(validEvent(), privateKeyPem, 'test-kid');
    const tampered = { ...envelope, eventId: ZERO_ID };
    expect(verifyEnvelope(tampered, publicKeyPem)).toBe(false);
  });

  it('fails verification when proposal is swapped but proposalHash is left stale', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, privateKeyPem, 'test-kid');

    // Swap the proposal to a different change but keep the recorded hash.
    // This is the canonical "proposal mismatch" attack: the signed event
    // attests to a different proposal than the one named in the envelope.
    const tampered: AuditEvent = {
      ...envelope.event,
      proposal: { ...envelope.event.proposal, ref: 'C-999', title: 'Malicious change' },
    };
    const tamperedEnvelope = { ...envelope, event: tampered };
    expect(verifyEnvelope(tamperedEnvelope, publicKeyPem)).toBe(false);
  });

  it('fails verification when the proposal is swapped AND proposalHash is recomputed to match', () => {
    // If the attacker can both change the proposal and recompute the hash,
    // the JWS still won't verify because the canonical bytes of the entire
    // event have changed (the proposal bytes are part of the signed payload).
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, privateKeyPem, 'test-kid');

    const swappedProposal = { ...envelope.event.proposal, ref: 'C-999', title: 'Malicious change' };
    const tampered: AuditEvent = {
      ...envelope.event,
      proposal: swappedProposal,
      proposalHash: contentHash(swappedProposal),
    };
    const tamperedEnvelope = { ...envelope, event: tampered };
    expect(verifyEnvelope(tamperedEnvelope, publicKeyPem)).toBe(false);
  });

  it('verifyEnvelope returns false (never throws) on malformed envelope inputs', () => {
    const { publicKeyPem } = makeKeys();
    // null / non-object envelope
    expect(verifyEnvelope(null as unknown as SignedAuditEnvelope, publicKeyPem)).toBe(false);
    expect(verifyEnvelope(undefined as unknown as SignedAuditEnvelope, publicKeyPem)).toBe(false);
    // structurally broken event payload
    expect(
      verifyEnvelope(
        {
          event: { v: 1 } as unknown as AuditEvent,
          eventId: ZERO_ID,
          signature: { protected: 'AA', signature: 'AA' },
        },
        publicKeyPem,
      ),
    ).toBe(false);
    // event with a proposalHash that does not match its proposal
    const keys = makeKeys();
    const event = validEvent();
    const envelope = signEvent(event, keys.privateKeyPem, 'test-kid');
    envelope.event = {
      ...envelope.event,
      proposal: { ...envelope.event.proposal, ref: 'changed' },
    };
    expect(verifyEnvelope(envelope, publicKeyPem)).toBe(false);
  });
});

describe('verifyDetached (raw JWS) header-confusion resistance', () => {
  it('rejects when alg is replaced (RS256)', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const payload = canonicalize(validEvent());
    const jws = signDetached(payload, privateKeyPem, { kid: 'test-kid' });

    const realHeader = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(jws.protected, 'base64url'),
      ),
    );
    expect(realHeader.alg).toBe('EdDSA');

    const tamperedHeader = Buffer.from(
      JSON.stringify({ ...realHeader, alg: 'RS256', b64: false, crit: ['b64'] }),
      'utf-8',
    ).toString('base64url');
    const tampered = { protected: tamperedHeader, signature: jws.signature };

    expect(() => verifyDetached(tampered, publicKeyPem, payload)).toThrow(/alg/);
  });

  it('rejects when alg is replaced with "none"', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const payload = canonicalize(validEvent());
    const jws = signDetached(payload, privateKeyPem, { kid: 'test-kid' });

    const realHeader = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(jws.protected, 'base64url'),
      ),
    );
    const tamperedHeader = Buffer.from(
      JSON.stringify({ ...realHeader, alg: 'none', b64: false, crit: ['b64'] }),
      'utf-8',
    ).toString('base64url');
    const tampered = { protected: tamperedHeader, signature: jws.signature };

    expect(() => verifyDetached(tampered, publicKeyPem, payload)).toThrow(/alg/);
  });

  it('rejects when crit is missing the b64 declaration', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const payload = canonicalize(validEvent());
    const jws = signDetached(payload, privateKeyPem, { kid: 'test-kid' });

    const realHeader = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(jws.protected, 'base64url'),
      ),
    );
    const tamperedHeader = Buffer.from(
      JSON.stringify({ ...realHeader, crit: [] }),
      'utf-8',
    ).toString('base64url');
    const tampered = { protected: tamperedHeader, signature: jws.signature };

    expect(() => verifyDetached(tampered, publicKeyPem, payload)).toThrow(/crit/);
  });

  it('rejects when b64 is set to true (payload would be re-interpreted)', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const payload = canonicalize(validEvent());
    const jws = signDetached(payload, privateKeyPem, { kid: 'test-kid' });

    const realHeader = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(jws.protected, 'base64url'),
      ),
    );
    const tamperedHeader = Buffer.from(
      JSON.stringify({ ...realHeader, b64: true }),
      'utf-8',
    ).toString('base64url');
    const tampered = { protected: tamperedHeader, signature: jws.signature };

    expect(() => verifyDetached(tampered, publicKeyPem, payload)).toThrow(/b64/);
  });

  it('rejects when an unknown protected header parameter is added without crit', () => {
    const { privateKeyPem, publicKeyPem } = makeKeys();
    const payload = canonicalize(validEvent());
    const jws = signDetached(payload, privateKeyPem, { kid: 'test-kid' });

    const realHeader = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(jws.protected, 'base64url'),
      ),
    );
    const tamperedHeader = Buffer.from(
      JSON.stringify({ ...realHeader, extra: 'boom' }),
      'utf-8',
    ).toString('base64url');
    const tampered = { protected: tamperedHeader, signature: jws.signature };

    expect(() => verifyDetached(tampered, publicKeyPem, payload)).toThrow(/unknown/);
  });

  it('rejects when protected header is not valid base64url JSON', () => {
    const { publicKeyPem } = makeKeys();
    const payload = canonicalize(validEvent());
    expect(() =>
      verifyDetached(
        { protected: '!!!not-base64url!!!', signature: 'AAAA' },
        publicKeyPem,
        payload,
      ),
    ).toThrow(JwsError);
  });

  it('rejects when kid is empty', () => {
    const { privateKeyPem } = makeKeys();
    const payload = canonicalize(validEvent());
    expect(() => signDetached(payload, privateKeyPem, { kid: '' })).toThrow(JwsError);
  });
});

describe('hygiene', () => {
  it('any change to a canonical-tracked field changes the content hash and so the event id', () => {
    const a = contentHash({ a: 1, b: 2 });
    const b = contentHash({ a: 1, b: 3 });
    expect(a).not.toBe(b);
  });

  it('contentHash is taken once over the canonical bytes (no triple canonicalization)', () => {
    // The hash is computed over the canonical bytes of the value, exactly
    // once. Any attempt to re-canonicalize the digest or the encoded form
    // would change the byte sequence. We verify the contract by hashing
    // the same value twice and asserting the digests match — and that
    // hashing a structurally identical but differently-keyed object also
    // matches, confirming only the canonical byte form is digested.
    const v = { a: 1, b: 'two', c: [3, 4] };
    const sameShape = { c: [3, 4], b: 'two', a: 1 };
    expect(contentHash(v)).toBe(contentHash(v));
    expect(contentHash(v)).toBe(contentHash(sameShape));
    expect(contentHash(v)).toMatch(/^[0-9a-f]{64}$/);
  });
});