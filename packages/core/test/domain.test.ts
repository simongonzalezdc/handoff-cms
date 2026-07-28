/**
 * Domain invariants: branded scalars, RegionBinding, AliasSymlinkContract,
 * LocalizedValue, and repository-relative path lexing.
 *
 * These tests exercise observable contracts only. They do not mock the
 * kernel and they do not assume internal helpers.
 */

import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  ERROR_CODES,
  assertLocalized,
  assertProposal,
  assertRegionBinding,
  assertRepoRelativePath,
  brandIso8601,
  brandSha256Hex,
  checkRepoRelativePath,
  isMcpIdentity,
  isServiceIdentity,
  type ActorIdentity,
  type AliasSymlinkContract,
  type ContentProposal,
  type AssetProposal,
  type DerivedArtifact,
  type Identity,
  type Iso8601,
  type LocalizedValue,
  type RegionBinding,
  type ErrorCode,
  type Sha256Hex,
  type ServiceIdentity,
} from '../src/index.js';

const SHA = 'a'.repeat(64) as Sha256Hex;
const ISO = '2026-07-27T12:00:00.000Z' as Iso8601;

const actor: ActorIdentity = Object.freeze({
  kind: 'actor',
  id: 'user-1',
  displayName: 'Alice',
  capabilities: [],
});

const service: ServiceIdentity = Object.freeze({
  kind: 'service',
  id: 'svc-1',
  displayName: 'Bot',
  capabilities: ['mcp'],
});

function binding(overrides: Partial<RegionBinding> = {}): RegionBinding {
  const canonicalSource = Object.freeze({
    repoPath: 'content/posts/hello.md',
    contentHash: SHA,
    sizeBytes: 12,
  });
  const derivedArtifacts: readonly DerivedArtifact[] = Object.freeze([
    Object.freeze({
      repoPath: 'previews/posts/hello.png',
      kind: 'preview',
      contentHash: SHA,
      sizeBytes: 1,
    }),
  ]);
  const regenerationContract: AliasSymlinkContract = Object.freeze({
    mode: 'alias_symlink',
    aliasPath: 'content/posts/_hello.md',
    aliasTargets: Object.freeze(['content/posts/hello.md']),
  });
  return Object.freeze({
    id: 'region-1',
    tenantId: 'tenant-1',
    contentType: 'post',
    environment: 'staging' as const,
    locale: 'en' as const,
    canonicalSource,
    derivedArtifacts,
    regenerationContract,
    governanceVersion: 1,
    createdAt: ISO,
    createdBy: actor,
    ...overrides,
  });
}

describe('brandIso8601', () => {
  it('rejects calendar-invalid dates with E_BAD_TIMESTAMP (Feb 30, Apr 31, Sep 31, hour/minute/second overflow, month 13, day 32)', () => {
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-09-31T00:00:00Z',
      '2026-02-30T00:00:00+01:00',
      '2026-04-31T00:00:00-05:00',
      '2026-13-01T00:00:00Z',
      '2026-00-01T00:00:00Z',
      '2026-01-32T00:00:00Z',
      '2026-01-00T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T12:60:00Z',
      '2026-01-01T12:00:60Z',
    ]) {
      try {
        brandIso8601(bad);
        throw new Error(`expected ${bad} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        expect((err as DomainInvariantError).code).toBe('E_BAD_TIMESTAMP');
      }
    }
  });
  it('accepts UTC and explicit offsets with millisecond precision', () => {
    expect(brandIso8601('2026-07-27T12:00:00Z')).toBeTypeOf('string');
    expect(brandIso8601('2026-07-27T12:00:00.123Z')).toBeTypeOf('string');
    expect(brandIso8601('2026-07-27T13:00:00.000+01:00')).toBeTypeOf('string');
  });

  it('rejects date-only and malformed strings with E_BAD_TIMESTAMP', () => {
    for (const bad of [
      '2026-07-27',
      '2026-07-27T12:00:00',
      'not-a-date',
      '',
      '2026-07-27T12:00:00.123',
    ]) {
      try {
        brandIso8601(bad);
        throw new Error(`expected ${bad} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        expect((err as DomainInvariantError).code).toBe('E_BAD_TIMESTAMP');
      }
    }
  });
});

describe('brandSha256Hex', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(brandSha256Hex('0'.repeat(64))).toBeTypeOf('string');
    expect(brandSha256Hex('abcdef0123456789'.repeat(4))).toBeTypeOf('string');
  });

  it('rejects wrong length, uppercase, and non-hex with E_BAD_HASH', () => {
    for (const bad of [
      'A'.repeat(64),
      'g'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      '',
      `${'a'.repeat(63)}G`,
    ]) {
      try {
        brandSha256Hex(bad);
        throw new Error(`expected ${bad.slice(0, 8)}… to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        expect((err as DomainInvariantError).code).toBe('E_BAD_HASH');
      }
    }
  });
});

describe('ERROR_CODES', () => {
  it('is a frozen, closed union that includes all expected codes', () => {
    const expected = [
      'E_BAD_TIMESTAMP',
      'E_BAD_HASH',
      'E_BAD_LOCALE',
      'E_BAD_PATH',
      'E_ABSOLUTE_PATH',
      'E_ESCAPING_PATH',
      'E_SELF_ALIAS',
      'E_CYCLIC_ALIAS',
      'E_AMBIGUOUS_CANONICAL',
      'E_BAD_REGENERATION_MODE',
      'E_EMPTY_DERIVED_ARTIFACTS',
      'E_INVALID_IDENTITY',
      'E_SERVICE_APPROVAL_FORBIDDEN',
      'E_MCP_APPROVAL_FORBIDDEN',
      'E_SELF_APPROVAL_FORBIDDEN',
      'E_INSUFFICIENT_AUTHORITY',
      'E_FIELD_CAPABILITY_MISSING',
      'E_ROLE_MISMATCH',
      'E_CONTENT_TYPE_MISMATCH',
      'E_ENVIRONMENT_MISMATCH',
      'E_ACTION_FORBIDDEN',
      'E_INVALID_TRANSITION',
      'E_ROLLBACK_WINDOW_EXPIRED',
      'E_FROZEN_VIOLATION',
      'E_MISSING_LOCALE',
      'E_INVALID_PROPOSAL',
      'E_INVALID_REVISION',
    ];
    for (const code of expected) {
      expect(ERROR_CODES as readonly string[]).toContain(code);
    }

    // The stable union is exactly these codes, in this order; nothing
    // extra, nothing missing, no duplicates.
    expect(ERROR_CODES as readonly string[]).toEqual(expected);

    // Codes are unique: no duplicates allowed in the closed union.
    const seen = new Set<string>();
    for (const code of ERROR_CODES) {
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });

  it('is frozen at runtime: push, index-set, and structural mutation throw', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    const originalLength = ERROR_CODES.length;
    expect(originalLength).toBeGreaterThan(0);
    const pushAttempt = (): void => {
      (ERROR_CODES as unknown as string[]).push('E_TAMPERED');
    };
    const writeAttempt = (): void => {
      (ERROR_CODES as unknown as string[])[0] = 'E_TAMPERED';
    };
    expect(pushAttempt).toThrow();
    expect(writeAttempt).toThrow();
    expect(ERROR_CODES.length).toBe(originalLength);
    expect(ERROR_CODES[0]).not.toBe('E_TAMPERED');
  });

  it('keeps every entry assignable to the literal ErrorCode union', () => {
    const typed: readonly ErrorCode[] = ERROR_CODES;
    expect(typed.length).toBe(ERROR_CODES.length);
  });
});

describe('isServiceIdentity / isMcpIdentity', () => {
  it('classifies identity kinds correctly', () => {
    expect(isServiceIdentity(actor)).toBe(false);
    expect(isServiceIdentity(service)).toBe(true);
    expect(isMcpIdentity(service)).toBe(true);
    expect(isMcpIdentity(actor)).toBe(false);
  });

  it('distinguishes MCP from non-MCP services by capability list', () => {
    const plainService: ServiceIdentity = Object.freeze({
      kind: 'service',
      id: 'svc-2',
      displayName: 'Plain',
      capabilities: [],
    });
    expect(isServiceIdentity(plainService)).toBe(true);
    expect(isMcpIdentity(plainService)).toBe(false);
  });
});

describe('assertRepoRelativePath', () => {
  it('accepts normalised POSIX paths', () => {
    expect(() => assertRepoRelativePath('content/posts/hello.md', 'p')).not.toThrow();
    expect(() => assertRepoRelativePath('a/b/c.md', 'p')).not.toThrow();
  });

  it('rejects absolute POSIX and absolute Windows paths', () => {
    for (const abs of ['/etc/passwd', '/content/x.md', 'C:\\Windows\\x', 'D:/foo/bar']) {
      try {
        assertRepoRelativePath(abs, 'p');
        throw new Error(`expected ${abs} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
      }
    }
  });

  it('rejects .. and . segments as path-escape attempts', () => {
    for (const esc of ['../escape.md', 'a/../b.md', 'a/./b.md', 'a//b.md']) {
      try {
        assertRepoRelativePath(esc, 'p');
        throw new Error(`expected ${esc} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        const code = (err as DomainInvariantError).code;
        expect(['E_ESCAPING_PATH', 'E_BAD_PATH']).toContain(code);
      }
    }
  });

  it('rejects NUL bytes and shell metacharacters', () => {
    for (const bad of ['a/b\0.md', 'a/b;rm.md', 'a/b$c.md', 'a/b|c.md', '']) {
      try {
        assertRepoRelativePath(bad, 'p');
        throw new Error(`expected ${JSON.stringify(bad)} to fail`);
      } catch (err) {
        expect(err).toBeInstanceOf(DomainInvariantError);
        const code = (err as DomainInvariantError).code;
        expect(['E_BAD_PATH', 'E_ABSOLUTE_PATH']).toContain(code);
      }
    }
  });
});

describe('checkRepoRelativePath', () => {
  it('returns the typed ok:true result for valid input', () => {
    const r = checkRepoRelativePath('a/b.md', 'p');
    expect(r.ok).toBe(true);
  });

  it('returns the typed ok:false result with code + message for invalid input', () => {
    const r = checkRepoRelativePath('/abs.md', 'p');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('E_ABSOLUTE_PATH');
      expect(typeof r.message).toBe('string');
    }
  });
});

describe('assertLocalized', () => {
  const full: LocalizedValue = Object.freeze({ en: 'Hello', es: 'Hola' });
  const onlyEn: LocalizedValue = Object.freeze({ en: 'Hello', es: '' });
  const onlyEs: LocalizedValue = Object.freeze({ en: '', es: 'Hola' });

  it('accepts both locales populated', () => {
    expect(() => assertLocalized(full)).not.toThrow();
  });

  it('rejects empty EN with E_MISSING_LOCALE', () => {
    try {
      assertLocalized(onlyEs);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_MISSING_LOCALE');
    }
  });

  it('rejects whitespace-only EN with E_MISSING_LOCALE', () => {
    const whitespaceEn: LocalizedValue = Object.freeze({ en: '   \t\n', es: 'Hola' });
    try {
      assertLocalized(whitespaceEn);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_MISSING_LOCALE');
    }
  });

  it('rejects whitespace-only ES with E_MISSING_LOCALE', () => {
    const whitespaceEs: LocalizedValue = Object.freeze({ en: 'Hello', es: '   ' });
    try {
      assertLocalized(whitespaceEs);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_MISSING_LOCALE');
    }
  });

  it('accepts localised values with leading/trailing whitespace when non-whitespace content is present', () => {
    const padded: LocalizedValue = Object.freeze({ en: '  Hello  ', es: '\tHola\n' });
    expect(() => assertLocalized(padded)).not.toThrow();
  });

  it('treats ES being empty string as missing locale (covered via onlyEn)', () => {
    expect(() => assertLocalized(onlyEn)).toThrow(DomainInvariantError);
  });
});

describe('assertRegionBinding — happy paths', () => {
  it('accepts a fully-formed binding', () => {
    expect(() => assertRegionBinding(binding())).not.toThrow();
  });

  it('accepts binding with locale "es"', () => {
    expect(() => assertRegionBinding(binding({ locale: 'es' }))).not.toThrow();
  });

  it('accepts binding with multiple derived artifacts', () => {
    const da: readonly DerivedArtifact[] = Object.freeze([
      Object.freeze({ repoPath: 'previews/a.png', kind: 'preview', contentHash: SHA, sizeBytes: 1 }),
      Object.freeze({ repoPath: 'previews/b.png', kind: 'thumbnail', contentHash: SHA, sizeBytes: 1 }),
    ]);
    expect(() => assertRegionBinding(binding({ derivedArtifacts: da }))).not.toThrow();
  });

  it('assertRegionBinding terminates when alias targets resolve to derived artifacts', () => {
    const contract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'content/posts/_hello.md',
      aliasTargets: Object.freeze(['previews/posts/hello.png']),
    });
    const input = binding({ regenerationContract: contract });
    expect(() => assertRegionBinding(input)).not.toThrow();
  });
});

describe('assertRegionBinding — failures', () => {
  it('rejects zero derived artifacts with E_EMPTY_DERIVED_ARTIFACTS', () => {
    const da: readonly DerivedArtifact[] = Object.freeze([]);
    try {
      assertRegionBinding(binding({ derivedArtifacts: da }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_EMPTY_DERIVED_ARTIFACTS');
    }
  });

  it('rejects unsupported regeneration mode with E_BAD_REGENERATION_MODE', () => {
    const bad = { mode: 'mystery' as unknown as 'alias_symlink', aliasPath: 'a.md', aliasTargets: [] };
    try {
      assertRegionBinding(binding({ regenerationContract: bad as never }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_BAD_REGENERATION_MODE');
    }
  });

  it('rejects absolute canonical repo path with E_ABSOLUTE_PATH', () => {
    const cs = Object.freeze({ repoPath: '/etc/passwd', contentHash: SHA, sizeBytes: 1 });
    try {
      assertRegionBinding(binding({ canonicalSource: cs }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });

  it('rejects canonical source with .. segment with E_ESCAPING_PATH', () => {
    const cs = Object.freeze({ repoPath: 'a/../b.md', contentHash: SHA, sizeBytes: 1 });
    try {
      assertRegionBinding(binding({ canonicalSource: cs }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ESCAPING_PATH');
    }
  });

  it('rejects absolute derived-artifact path with E_ABSOLUTE_PATH', () => {
    const da: readonly DerivedArtifact[] = Object.freeze([
      Object.freeze({ repoPath: '/abs.png', kind: 'preview', contentHash: SHA, sizeBytes: 1 }),
    ]);
    try {
      assertRegionBinding(binding({ derivedArtifacts: da }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });
});

describe('AliasSymlinkContract — escape / self / cycle / ambiguity', () => {
  it('rejects self-alias when aliasPath equals an aliasTarget with E_SELF_ALIAS', () => {
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'a/_alias.md',
      aliasTargets: Object.freeze(['a/_alias.md']),
    });
    try {
      assertRegionBinding(binding({ regenerationContract: contract }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_SELF_ALIAS');
    }
  });

  it('rejects aliasPath absolute with E_ABSOLUTE_PATH before alias-graph checks', () => {
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: '/abs.md',
      aliasTargets: Object.freeze(['content/posts/hello.md']),
    });
    try {
      assertRegionBinding(binding({ regenerationContract: contract }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });

  it('rejects aliasTargets containing .. with E_ESCAPING_PATH', () => {
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'a/_alias.md',
      aliasTargets: Object.freeze(['../escape.md']),
    });
    try {
      assertRegionBinding(binding({ regenerationContract: contract }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ESCAPING_PATH');
    }
  });

  it('rejects ambiguous canonical when canonicalSource appears in aliasTargets twice', () => {
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'a/_alias.md',
      aliasTargets: Object.freeze([
        'content/posts/hello.md',
        'content/posts/hello.md',
      ]),
    });
    try {
      assertRegionBinding(binding({ regenerationContract: contract }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_AMBIGUOUS_CANONICAL');
    }
  });

  it('accepts a single canonical reference in aliasTargets (not ambiguous)', () => {
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'a/_alias.md',
      aliasTargets: Object.freeze(['content/posts/hello.md']),
    });
    expect(() => assertRegionBinding(binding({ regenerationContract: contract }))).not.toThrow();
  });

  it('rejects absolute aliasTarget with E_ABSOLUTE_PATH', () => {
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'a/_alias.md',
      aliasTargets: Object.freeze(['/abs-target.md']),
    });
    try {
      assertRegionBinding(binding({ regenerationContract: contract }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });

  it('rejects Windows-drive aliasTarget with E_ABSOLUTE_PATH', () => {
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'a/_alias.md',
      aliasTargets: Object.freeze(['C:\\Users\\x\\target.md']),
    });
    try {
      assertRegionBinding(binding({ regenerationContract: contract }));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });

  it('pure core does NOT walk the alias graph: lexically-clean mutual references among the aliasPath and a derived artifact pass without raising E_CYCLIC_ALIAS', () => {
    // Self-alias is detected separately (E_SELF_ALIAS); cycle/graph walk
    // belongs to the adapter. Here the aliasPath and a derived artifact
    // refer to each other lexically only, no target equals aliasPath, so
    // pure core accepts the contract.
    const derived: readonly DerivedArtifact[] = Object.freeze([
      Object.freeze({
        repoPath: 'previews/posts/hello.png',
        kind: 'preview',
        contentHash: SHA,
        sizeBytes: 1,
      }),
      Object.freeze({
        repoPath: 'previews/posts/_hello.md',
        kind: 'thumbnail',
        contentHash: SHA,
        sizeBytes: 1,
      }),
    ]);
    const contract: AliasSymlinkContract = Object.freeze({
      mode: 'alias_symlink',
      aliasPath: 'content/posts/_hello.md',
      aliasTargets: Object.freeze(['previews/posts/hello.png']),
    });
    expect(() =>
      assertRegionBinding(
        binding({ derivedArtifacts: derived, regenerationContract: contract }),
      ),
    ).not.toThrow();
  });

  it('retains E_CYCLIC_ALIAS in the closed union so adapters can report real filesystem cycles', () => {
    expect(ERROR_CODES as readonly string[]).toContain('E_CYCLIC_ALIAS');
  });
});

describe('assertProposal', () => {
  function contentProposal(overrides: Partial<ContentProposal> = {}): ContentProposal {
    return Object.freeze({
      id: 'prop-1',
      tenantId: 'tenant-1',
      kind: 'content' as const,
      contentType: 'post',
      environment: 'staging' as const,
      action: 'create' as const,
      createdBy: actor,
      createdAt: ISO,
      draft: false,
      payload: Object.freeze({
        localizedTitle: Object.freeze({ en: 'T', es: 'Tt' }),
        localizedBody: Object.freeze({ en: 'B', es: 'Bb' }),
        canonicalRepoPath: 'content/posts/hello.md',
      }),
      ...overrides,
    });
  }

  function assetProposal(overrides: Partial<AssetProposal> = {}): AssetProposal {
    return Object.freeze({
      id: 'prop-asset-1',
      tenantId: 'tenant-1',
      kind: 'asset' as const,
      contentType: 'image',
      environment: 'staging' as const,
      action: 'create' as const,
      createdBy: actor,
      createdAt: ISO,
      draft: false,
      payload: Object.freeze({
        bindingId: 'region-1',
        canonicalRepoPath: 'content/posts/hello.md',
        previewRepoPath: 'previews/posts/hello.png',
      }),
      ...overrides,
    });
  }

  it('accepts an asset proposal with normalised canonical + preview paths', () => {
    expect(() => assertProposal(assetProposal())).not.toThrow();
  });

  it('accepts an asset proposal with deeper normalised canonical + preview paths', () => {
    expect(() =>
      assertProposal(
        assetProposal({
          payload: Object.freeze({
            bindingId: 'region-1',
            canonicalRepoPath: 'content/posts/2026/07/hello.md',
            previewRepoPath: 'previews/posts/2026/07/hello-1024.png',
          }),
        }),
      ),
    ).not.toThrow();
  });

  it('rejects asset proposal with absolute canonicalRepoPath with E_ABSOLUTE_PATH', () => {
    const bad = assetProposal();
    const patched = Object.freeze({
      ...bad,
      payload: Object.freeze({
        ...bad.payload,
        canonicalRepoPath: '/abs.md',
      }),
    });
    try {
      assertProposal(patched);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });

  it('rejects asset proposal with absolute previewRepoPath with E_ABSOLUTE_PATH', () => {
    const bad = assetProposal();
    const patched = Object.freeze({
      ...bad,
      payload: Object.freeze({
        ...bad.payload,
        previewRepoPath: '/abs.png',
      }),
    });
    try {
      assertProposal(patched);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });

  it('rejects asset proposal with .. in canonicalRepoPath with E_ESCAPING_PATH', () => {
    const bad = assetProposal();
    const patched = Object.freeze({
      ...bad,
      payload: Object.freeze({
        ...bad.payload,
        canonicalRepoPath: 'a/../escape.md',
      }),
    });
    try {
      assertProposal(patched);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ESCAPING_PATH');
    }
  });

  it('rejects asset proposal with .. in previewRepoPath with E_ESCAPING_PATH', () => {
    const bad = assetProposal();
    const patched = Object.freeze({
      ...bad,
      payload: Object.freeze({
        ...bad.payload,
        previewRepoPath: 'a/../escape.png',
      }),
    });
    try {
      assertProposal(patched);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ESCAPING_PATH');
    }
  });

  it('accepts a content proposal with both locales populated', () => {
    expect(() => assertProposal(contentProposal())).not.toThrow();
  });

  it('rejects content proposal missing localizedBody ES with E_MISSING_LOCALE', () => {
    const bad = contentProposal();
    const patched = Object.freeze({
      ...bad,
      payload: Object.freeze({
        ...bad.payload,
        localizedBody: Object.freeze({ en: 'B', es: '' }),
      }),
    });
    try {
      assertProposal(patched);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_MISSING_LOCALE');
    }
  });

  it('rejects content proposal with absolute canonicalRepoPath with E_ABSOLUTE_PATH', () => {
    const bad = contentProposal();
    const patched = Object.freeze({
      ...bad,
      payload: Object.freeze({
        ...bad.payload,
        canonicalRepoPath: '/abs.md',
      }),
    });
    try {
      assertProposal(patched);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ABSOLUTE_PATH');
    }
  });

  it('rejects content proposal with .. in canonicalRepoPath with E_ESCAPING_PATH', () => {
    const bad = contentProposal();
    const patched = Object.freeze({
      ...bad,
      payload: Object.freeze({
        ...bad.payload,
        canonicalRepoPath: 'a/../escape.md',
      }),
    });
    try {
      assertProposal(patched);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainInvariantError);
      expect((err as DomainInvariantError).code).toBe('E_ESCAPING_PATH');
    }
  });
});

describe('Identity — frozen surface', () => {
  it('exports three distinct kinds under a closed union', () => {
    const delegated = Object.freeze({
      kind: 'delegated_human' as const,
      id: 'del-1',
      displayName: 'Sam',
      capabilities: Object.freeze(['content.post']),
      delegatorId: 'user-1',
      delegatedAt: ISO,
      delegatedUntil: ISO,
    });
    const ids: Identity[] = [actor, service, delegated];
    for (const id of ids) {
      expect(typeof id.id).toBe('string');
      expect(typeof id.displayName).toBe('string');
      expect(Array.isArray(id.capabilities)).toBe(true);
    }
    expect(delegated.kind).toBe('delegated_human');
  });
});