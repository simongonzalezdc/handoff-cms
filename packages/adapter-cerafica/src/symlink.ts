/**
 * `@cms/adapter-cerafica/symlink` — real-filesystem alias verifier for the
 * cerafica host repository.
 *
 * The cerafica host contract declares that products are served via the
 * filesystem alias `website/data/products.json` which is a Unix
 * symlink whose target is `../../inventory/products.json` (resolved
 * against the repository root).
 *
 * This module is the single point at which the adapter inspects the
 * filesystem. It performs no host logic; it exposes a small set of
 * primitives that the adapter composes. Every primitive here MUST be
 * implemented in terms of real filesystem calls (`lstat`, `readlink`,
 * `realpath`). The adapter is required to refuse activation when the
 * alias is missing, broken, retargeted, escaping, looped, or replaced
 * by a regular file.
 *
 * The verifier is acyclic: it walks the symlink chain using bounded
 * hop counters and reports a loop when the bound is exceeded. Realpath
 * (or its open-file-descriptor form) is used to obtain the canonical
 * target so the adapter can compare it against the declared target.
 *
 * The verifier is repository-confined: any resolution that escapes the
 * declared repository root is refused. "Escaping" here is a real
 * filesystem check (the resolved path must be inside the repository
 * tree), not a lexical check on a path string.
 */

import { createHash } from 'node:crypto';
import { readFile, readlink, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { AdapterContractError, type AdapterRefusalCode } from '@cms/adapter-sdk';

// --------------------------------------------------------------------
// Refusal codes (symlink-specific)
// --------------------------------------------------------------------

/**
 * Closed union of refusal codes the symlink verifier can produce.
 * Each code names a distinct, machine-checkable failure mode. The
 * adapter uses these directly in `AdapterContractError.details.code`.
 *
 * The previous `E_ALIAS_HASH_MISMATCH` code was removed: the declared
 * verifier contract supplies no expected hash, so no refusal code of
 * that name can ever be produced. Leaving it would either be a dead
 * string or a programmer error, neither of which belongs in a
 * machine-checkable refusal code list.
 */
export const SYMLINK_REFUSAL_CODES = [
  'E_ALIAS_MISSING',
  'E_ALIAS_BROKEN',
  'E_ALIAS_NOT_SYMLINK',
  'E_ALIAS_RETARGETED',
  'E_ALIAS_ESCAPING',
  'E_ALIAS_LOOPED',
  'E_CANONICAL_MISSING',
] as const;
Object.freeze(SYMLINK_REFUSAL_CODES);

export type SymlinkRefusalCode = (typeof SYMLINK_REFUSAL_CODES)[number];

// --------------------------------------------------------------------
// Result shape
// --------------------------------------------------------------------

/**
 * Result of verifying the alias path. The verifier either reports a
 * success with the full chain or a refusal with one of the closed
 * codes. The success result includes:
 *   - the absolute alias path,
 *   - the chain of link targets in resolution order (excluding the
 *     final canonical path itself),
 *   - the canonical absolute path,
 *   - the canonical relative path (POSIX) confined to the repository,
 *   - the canonical bytes hash (sha256 hex),
 *   - the canonical byte size.
 */
export interface AliasVerification {
  readonly ok: true;
  readonly aliasAbsPath: string;
  readonly aliasTargets: readonly string[];
  readonly canonicalAbsPath: string;
  readonly canonicalRelPath: string;
  readonly canonicalHash: string;
  readonly canonicalSize: number;
}

export interface AliasRefusal {
  readonly ok: false;
  readonly code: SymlinkRefusalCode;
  readonly message: string;
}

export type AliasVerificationResult = AliasVerification | AliasRefusal;

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

/**
 * Maximum number of symlink hops the verifier follows before reporting
 * a loop. The bound is conservative and far above any plausible
 * symlink chain in a host repository.
 */
const MAX_SYMLINK_HOPS = 40;

/**
 * Compute the sha256 hex digest of `bytes`. Always lowercase, 64 hex
 * chars.
 */
function sha256HexOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Determine whether an absolute path lies inside the repository root,
 * without following symlinks. The check is purely lexical on the
 * resolved strings and is the second line of defence after the
 * realpath-based "escaping" check.
 */
function isInsideRepo(absPath: string, repoRoot: string): boolean {
  if (!isAbsolute(absPath) || !isAbsolute(repoRoot)) return false;
  const rel = relative(repoRoot, absPath);
  if (rel.length === 0) return true;
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return true;
}

/**
 * Walk a symlink chain from `entry` until a non-symlink is reached or
 * the hop bound is exceeded. Returns the chain of link targets (each
 * as recorded by `readlink` on the prior node) and the final entry's
 * `realpath` for the canonical absolute path. On any failure, returns
 * a refusal with a closed code.
 *
 * Each `readlink` value is taken from the parent of the prior node so
 * the chain is anchored in the filesystem, not in any string
 * rewriting.
 */
async function walkChain(
  entryAbs: string,
  repoRoot: string,
): Promise<
  | { readonly ok: true; readonly chain: readonly string[]; readonly canonicalAbs: string }
  | AliasRefusal
> {
  const chain: string[] = [];
  let cursor = entryAbs;
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: 'E_ALIAS_BROKEN',
        message: `lstat failed at ${cursor}: ${message}`,
      };
    }
    if (!stat.isSymbolicLink()) {
      // Reached a non-symlink terminal. Resolve its real path.
      try {
        const real = await realpath(cursor);
        if (!isInsideRepo(real, repoRoot)) {
          return {
            ok: false,
            code: 'E_ALIAS_ESCAPING',
            message: `alias terminal escapes repository: ${real} not inside ${repoRoot}`,
          };
        }
        return { ok: true, chain, canonicalAbs: real };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          code: 'E_ALIAS_BROKEN',
          message: `realpath failed at ${cursor}: ${message}`,
        };
      }
    }
    // It's a symlink. Read the target.
    let target: string;
    try {
      target = await readlink(cursor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: 'E_ALIAS_BROKEN',
        message: `readlink failed at ${cursor}: ${message}`,
      };
    }
    chain.push(target);
    // Advance the cursor. Relative targets are resolved against the
    // parent directory of the current cursor; absolute targets are
    // taken as-is. realpath is used for canonicalisation so a chain
    // like `a -> b -> ../escape` is detected.
    const parent = dirname(cursor);
    const nextAbs = isAbsolute(target) ? target : resolve(parent, target);
    cursor = nextAbs;
    // Detect pure loops in the recorded string chain. A recorded loop
    // is a chain that re-encounters the same absolute path it has
    // already visited. We track absolute paths incrementally because
    // targets can vary in representation (relative vs absolute) and a
    // naive `seen.add(target)` would miss a lexical rewrite of a
    // previously-visited path.
    const seenAbs = new Set<string>();
    let absCursor = entryAbs;
    seenAbs.add(absCursor);
    for (const link of chain) {
      const parent2 = dirname(absCursor);
      absCursor = isAbsolute(link) ? link : resolve(parent2, link);
      if (seenAbs.has(absCursor)) {
        return {
          ok: false,
          code: 'E_ALIAS_LOOPED',
          message: `alias chain forms a loop at ${absCursor}`,
        };
      }
      seenAbs.add(absCursor);
    }
  }
  return {
    ok: false,
    code: 'E_ALIAS_LOOPED',
    message: `alias chain exceeded ${MAX_SYMLINK_HOPS} hops`,
  };
}

// --------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------

/**
 * Verify a filesystem alias against a declared target inside a host
 * repository.
 *
 * The function performs, in order:
 *   1. `lstat` the alias path. A missing entry fails with
 *      `E_ALIAS_MISSING`; a non-symlink entry fails with
 *      `E_ALIAS_NOT_SYMLINK`.
 *   2. `readlink` the alias path and capture the chain.
 *   3. Walk the chain via real `readlink` calls, detecting loops and
 *      escaping paths via realpath.
 *   4. Compare the resolved canonical absolute path to the declared
 *      target (resolved against the repository root). A mismatch fails
 *      with `E_ALIAS_RETARGETED`.
 *   5. `readFile` the canonical path and compute its sha256 hex
 *      digest. The digest is exposed so the adapter can re-check it
 *      during reconciliation without re-reading the bytes.
 *
 * The `declaredTarget` is a repository-relative POSIX string. The
 * alias path is also repository-relative.
 *
 * On success, the returned `AliasVerification` includes the resolved
 * chain (each `readlink` value verbatim), the canonical absolute and
 * relative paths, and the canonical content hash and size.
 *
 * On failure, the function returns an `AliasRefusal` with a closed
 * refusal code. The caller is expected to surface it via
 * `AdapterContractError` with `code` matching one of the SDK's
 * refusal codes (`E_AMBIGUOUS_BINDING`, etc.). The symlink-specific
 * refusal code is preserved in `details.symlinkCode`.
 */
export async function verifyAlias(args: {
  readonly repoRoot: string;
  readonly aliasRelPath: string;
  readonly declaredTarget: string;
}): Promise<AliasVerificationResult> {
  const repoRoot = await realpath(args.repoRoot);
  const aliasRelPath = args.aliasRelPath;
  const declaredTarget = args.declaredTarget;

  const aliasAbs = resolve(repoRoot, aliasRelPath);

  // Step 1: lstat the alias entry itself. Use lstat (not stat) so we
  // observe the symlink itself rather than its target.
  let aliasLstat;
  try {
    aliasLstat = await lstat(aliasAbs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'E_ALIAS_MISSING',
      message: `alias ${aliasRelPath} missing: ${message}`,
    };
  }
  if (!aliasLstat.isSymbolicLink()) {
    return {
      ok: false,
      code: 'E_ALIAS_NOT_SYMLINK',
      message: `alias ${aliasRelPath} is not a symlink (mode=${aliasLstat.mode.toString(8)})`,
    };
  }

  // Step 2 + 3: walk the chain.
  const walked = await walkChain(aliasAbs, repoRoot);
  if (!walked.ok) return walked;

  // Step 4: verify the canonical path matches the declared target.
  const declaredAbs = resolve(dirname(aliasAbs), declaredTarget);
  if (walked.canonicalAbs !== declaredAbs) {
    return {
      ok: false,
      code: 'E_ALIAS_RETARGETED',
      message: `alias resolves to ${walked.canonicalAbs}, expected ${declaredAbs}`,
    };
  }

  // Step 5: hash the canonical file.
  let bytes: Buffer;
  try {
    bytes = await readFile(walked.canonicalAbs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'E_CANONICAL_MISSING',
      message: `canonical ${declaredTarget} unreadable: ${message}`,
    };
  }
  const canonicalHash = sha256HexOf(bytes);
  const canonicalSize = bytes.byteLength;
  const canonicalRel = relative(repoRoot, walked.canonicalAbs);

  return {
    ok: true,
    aliasAbsPath: aliasAbs,
    aliasTargets: walked.chain,
    canonicalAbsPath: walked.canonicalAbs,
    canonicalRelPath: canonicalRel,
    canonicalHash,
    canonicalSize,
  };
}

/**
 * Map a symlink-specific refusal to an SDK-level refusal. The mapping
 * is closed and exhaustive; anything not listed here is a programmer
 * error.
 */
export function mapSymlinkRefusalToAdapterCode(code: SymlinkRefusalCode): AdapterRefusalCode {
  switch (code) {
    case 'E_ALIAS_MISSING':
    case 'E_ALIAS_BROKEN':
    case 'E_ALIAS_NOT_SYMLINK':
    case 'E_ALIAS_RETARGETED':
    case 'E_ALIAS_ESCAPING':
    case 'E_ALIAS_LOOPED':
    case 'E_CANONICAL_MISSING':
      return 'E_AMBIGUOUS_BINDING';
  }
}

/**
 * Build an `AdapterContractError` carrying a symlink-specific refusal
 * code in `details.symlinkCode` and the mapped SDK code as `code`.
 */
export function symlinkRefusalToError(refusal: AliasRefusal, repoPath: string): AdapterContractError {
  const code = mapSymlinkRefusalToAdapterCode(refusal.code);
  return new AdapterContractError(code, refusal.message, {
    repoPath,
    symlinkCode: refusal.code,
  });
}

// Re-export helper for tests; production code never imports these
// directly outside of `verifyAlias`.
export const __internal__ = {
  sha256HexOf,
  isInsideRepo,
  MAX_SYMLINK_HOPS,
};