#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * Authoritative license allowlist.
 *
 * Loaded at startup from the shipped `allowlist.json` next to this module — there is
 * exactly one source of truth and no duplicated hardcoded policy. The JSON may also
 * declare a conservative list of SPDX `WITH` exceptions (`withExceptions`); any
 * `WITH` clause whose exception is not listed makes the package denied. With no
 * `withExceptions` key, every `WITH` is rejected (documented conservative default
 * for an Apache-2.0 open-core: only the explicit exceptions in the JSON are ever
 * allowed). The on-disk allowlist MUST be valid; a missing or malformed file is a
 * startup error — the parser never falls back to implicit defaults.
 */

interface DevToolException {
  readonly package: string;
  readonly license: string;
  readonly rationale: string;
}
interface AllowlistFile {
  allowed: readonly string[];
  withExceptions?: readonly string[];
  devToolExceptions?: readonly DevToolException[];
}

/**
 * Resolve the shipped allowlist by walking parent directories from this file.
 * Anchoring on a single `createRequire` call would break across build outputs
 * (`src/index.ts` has the allowlist one directory up; `dist/index.js` has it
 * as a sibling). We anchor on the closest `package.json` and require that the
 * same directory also contain `allowlist.json` — the first match wins. The
 * lookup is bounded by the filesystem root so a missing file never causes an
 * infinite loop.
 */
function resolveAllowlistPath(): string {
  const here = fileURLToPath(import.meta.url);
  let directory = dirname(here);
  let lastDirectory = "";
  while (directory !== lastDirectory) {
    const packageJson = join(directory, "package.json");
    if (existsSync(packageJson)) {
      const allowlist = join(directory, "allowlist.json");
      if (existsSync(allowlist)) return allowlist;
      throw new Error(`licensing-guard: package directory ${directory} declares this module but does not ship allowlist.json`);
    }
    lastDirectory = directory;
    directory = dirname(directory);
  }
  throw new Error(`licensing-guard: cannot locate shipped allowlist.json from ${here}`);
}

function loadAllowlist(): AllowlistFile {
  let resolved: string;
  try {
    resolved = resolveAllowlistPath();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`licensing-guard: cannot resolve shipped allowlist near module (${message})`);
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`licensing-guard: cannot read shipped allowlist at ${resolved} (${message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`licensing-guard: shipped allowlist is not valid JSON (${message})`);
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("licensing-guard: shipped allowlist must be a JSON object");
  const candidate = parsed as { allowed?: unknown; withExceptions?: unknown; devToolExceptions?: unknown };
  if (!Array.isArray(candidate.allowed)) throw new Error("licensing-guard: shipped allowlist must declare an array `allowed`");
  const allowed = candidate.allowed.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") throw new Error("licensing-guard: shipped allowlist `allowed` entries must be non-empty strings");
    return entry;
  });
  if (allowed.length === 0) throw new Error("licensing-guard: shipped allowlist `allowed` must be non-empty");
  let withExceptions: readonly string[] = [];
  if (candidate.withExceptions !== undefined) {
    if (!Array.isArray(candidate.withExceptions)) throw new Error("licensing-guard: shipped allowlist `withExceptions` must be an array when present");
    withExceptions = candidate.withExceptions.map((entry) => {
      if (typeof entry !== "string" || entry.trim() === "") throw new Error("licensing-guard: shipped allowlist `withExceptions` entries must be non-empty strings");
      return entry;
    });
  }
  let devToolExceptions: readonly DevToolException[] = [];
  if (candidate.devToolExceptions !== undefined) {
    if (!Array.isArray(candidate.devToolExceptions)) throw new Error("licensing-guard: shipped allowlist `devToolExceptions` must be an array when present");
    const seen = new Set<string>();
    devToolExceptions = candidate.devToolExceptions.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("licensing-guard: each dev-tool exception must be an object");
      const record = entry as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.join(",") !== "license,package,rationale") throw new Error("licensing-guard: each dev-tool exception must contain exactly package, license, and rationale");
      if (typeof record.package !== "string" || record.package.trim() === "") throw new Error("licensing-guard: dev-tool exception package must be non-empty");
      if (typeof record.license !== "string" || record.license.trim() === "") throw new Error("licensing-guard: dev-tool exception license must be non-empty");
      if (typeof record.rationale !== "string" || record.rationale.trim() === "") throw new Error("licensing-guard: dev-tool exception rationale must be non-empty");
      if (seen.has(record.package)) throw new Error(`licensing-guard: duplicate dev-tool exception for ${record.package}`);
      seen.add(record.package);
      return { package: record.package, license: record.license, rationale: record.rationale };
    });
  }
  return { allowed, withExceptions, devToolExceptions };
}

const allowlist = loadAllowlist();
export const ALLOWED_LICENSES: readonly string[] = Object.freeze(allowlist.allowed.slice());
const ALLOWED_EXCEPTIONS = new Set<string>(allowlist.withExceptions);
const DEV_TOOL_EXCEPTIONS = new Map((allowlist.devToolExceptions ?? []).map((entry) => [entry.package, entry]));

export type FindingReason = "missing-license" | "unknown-license" | "denied-license" | "uninspectable";
export interface LicenseFinding { package: string; version: string; path: string; reason: FindingReason; license?: string; }
export interface LicenseReport { ok: boolean; findings: LicenseFinding[]; packages: number; }
export interface InspectOptions { strict?: boolean; }
interface Manifest { name?: unknown; version?: unknown; license?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>; }

const allowed = new Set<string>(ALLOWED_LICENSES);
const denied = new Set<string>(["GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0", "Proprietary"]);
const tokenPattern = /\s*(\(|\)|AND\b|OR\b|WITH\b|[^\s()]+)/gy;

/**
 * Normalize metadata into a string expression suitable for {@link expressionAllowed}.
 * Returns `undefined` for non-string, empty, or whitespace-only metadata — the caller
 * MUST surface those as `missing-license` rather than minting a finding about an
 * arbitrary expression.
 */
function normalizeLicense(metadata: unknown): string | undefined {
  if (typeof metadata !== "string") return undefined;
  const trimmed = metadata.trim();
  return trimmed === "" ? undefined : trimmed;
}

function expressionAllowed(expression: string): { allowed: boolean; unknown: boolean } {
  if (expression.length === 0) return { allowed: false, unknown: true };
  if (expression !== expression.trim()) return { allowed: false, unknown: true };
  const tokens: string[] = [];
  tokenPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = tokenPattern.exec(expression)) !== null) {
    if (match.index !== consumed) return { allowed: false, unknown: true };
    tokens.push(match[1]!);
    consumed = tokenPattern.lastIndex;
  }
  if (tokens.length === 0 || consumed !== expression.length) return { allowed: false, unknown: true };
  let index = 0;
  /**
   * Recursive-descent SPDX-ish parser. Recognized grammar:
   *   expr    := primary ((AND|OR) primary)*
   *   primary := identifier | '(' expr ')'
   *   identifier := license-id (WITH exception-id)?
   * Anything unparseable, including stray WITH or WITH/AND/OR tokens outside an
   * identifier, malformed parentheses, or empty sub-expressions, is reported as
   * `unknown` rather than silently allowed.
   */
  const lookupLicense = (id: string): { value: boolean; unknown: boolean } => {
    if (allowed.has(id)) return { value: true, unknown: false };
    if (denied.has(id)) return { value: false, unknown: false };
    return { value: false, unknown: true };
  };
  const lookupException = (id: string): { value: boolean; unknown: boolean } => {
    if (ALLOWED_EXCEPTIONS.has(id)) return { value: true, unknown: false };
    return { value: false, unknown: true };
  };
  const parsePrimary = (): { value: boolean; unknown: boolean } => {
    const token = tokens[index++];
    if (token === undefined || token === ")" || token === "AND" || token === "OR" || token === "WITH") return { value: false, unknown: true };
    if (token === "(") {
      const inner = parseOr();
      if (tokens[index++] !== ")") return { value: false, unknown: true };
      return inner;
    }
    const withToken = tokens[index];
    if (withToken === "WITH") {
      index++;
      const exceptionToken = tokens[index++];
      if (exceptionToken === undefined || exceptionToken === "AND" || exceptionToken === "OR" || exceptionToken === "WITH" || exceptionToken === "(" || exceptionToken === ")") {
        return { value: false, unknown: true };
      }
      const license = lookupLicense(token);
      const exception = lookupException(exceptionToken);
      // `WITH` narrows the available license to `license AND exception`; both must
      // be vetted for the primary to be allowed. Fail-closed semantics: an
      // exception that is not on the conservative `withExceptions` allowlist
      // means the compound license is unknown — never silently allowed.
      if (license.value && exception.value) return { value: true, unknown: false };
      if (license.value && !exception.value) return { value: false, unknown: true };
      return { value: false, unknown: license.unknown || exception.unknown };
    }
    return lookupLicense(token);
  };
  const parseAnd = (): { value: boolean; unknown: boolean } => {
    let result = parsePrimary();
    while (tokens[index] === "AND") {
      index++;
      const right = parsePrimary();
      result = { value: result.value && right.value, unknown: result.unknown || right.unknown };
    }
    return result;
  };
  const parseOr = (): { value: boolean; unknown: boolean } => {
    let result = parseAnd();
    while (tokens[index] === "OR") {
      index++;
      const right = parseAnd();
      result = { value: result.value || right.value, unknown: result.unknown && right.unknown };
    }
    return result;
  };
  const result = parseOr();
  return index === tokens.length ? { allowed: result.value, unknown: result.unknown } : { allowed: false, unknown: true };
}

function readManifest(path: string): Manifest | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed as Manifest : undefined;
  } catch { return undefined; }
}
function packageLabel(manifest: Manifest, fallback: string): { name: string; version: string } {
  return { name: typeof manifest.name === "string" ? manifest.name : fallback, version: typeof manifest.version === "string" ? manifest.version : "unknown" };
}
function workspaceManifestPaths(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    if (directory.includes(`${join("node_modules", "")}`) || directory.includes(`${join(".git", "")}`)) return;
    let entries: Dirent<string>[];
    try { entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }); } catch { return; }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) result.push(join(directory, "package.json"));
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".")) visit(join(directory, entry.name));
  };
  visit(root);
  return result.sort();
}
function dependencyNames(field: Record<string, unknown> | undefined): string[] {
  return field ? Object.keys(field).sort() : [];
}
/**
 * Resolve a declared dependency to its manifest path, preserving pnpm-aware
 * resolution. First preference is the workspace map (so workspace symlinks stay
 * canonical); then `createRequire` so the resolver follows the exact lookup
 * rules of the importer (including pnpm's `node_modules/.pnpm/.../node_modules/<pkg>`);
 * then a manual parent-walk to honor hoisted layouts; finally the workspace-root
 * fallback.
 */
function manifestFromResolvedEntry(name: string, entryPath: string): string | undefined {
  let directory = dirname(entryPath);
  while (true) {
    const candidate = join(directory, "package.json");
    const manifest = readManifest(candidate);
    if (manifest?.name === name) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function resolveDependency(name: string, importerDir: string, root: string, workspace: Map<string, string>): string | undefined {
  const workspacePath = workspace.get(name);
  if (workspacePath) return workspacePath;
  try {
    const requireFrom = createRequire(realpathSync(join(importerDir, "package.json")));
    try {
      return requireFrom.resolve(`${name}/package.json`);
    } catch {
      const entry = requireFrom.resolve(name);
      const manifest = manifestFromResolvedEntry(name, entry);
      if (manifest !== undefined) return manifest;
    }
  } catch {
    // Fall through to explicit parent-walk resolution when package metadata
    // cannot be resolved from the importer's real pnpm location.
  }
  let current = importerDir;
  while (true) {
    const candidate = join(current, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const rootCandidate = join(root, "node_modules", name, "package.json");
  return existsSync(rootCandidate) ? rootCandidate : undefined;
}

export function inspectWorkspace(rootDirectory: string, options: InspectOptions = {}): LicenseReport {
  const root = resolve(rootDirectory);
  const strict = options.strict ?? true;
  const findings: LicenseFinding[] = [];
  const manifests = workspaceManifestPaths(root);
  const workspace = new Map<string, string>();
  for (const path of manifests) {
    const manifest = readManifest(path);
    if (manifest && typeof manifest.name === "string") workspace.set(manifest.name, path);
  }
  /**
   * Cycle-safe descent via a `visited` set keyed on the resolved manifest path
   * and whether the path is exclusively beneath a workspace devDependency.
   * Keeping those contexts distinct prevents a dev-tool exception from hiding
   * the same package when it is also reachable from a runtime dependency.
   */
  const visited = new Set<string>();
  const inspect = (manifestPath: string, dependencyPath: string[], required: boolean, devOnly: boolean): void => {
    const normalized = resolve(manifestPath);
    const visitKey = `${normalized}\u0000${devOnly ? "dev" : "runtime"}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const manifest = readManifest(normalized);
    if (!manifest) {
      if (required) findings.push({ package: dependencyPath.at(-1) ?? normalized, version: "unknown", path: dependencyPath.join(" > "), reason: "uninspectable" });
      return;
    }
    const label = packageLabel(manifest, dependencyPath.at(-1) ?? normalized);
    const license = normalizeLicense(manifest.license);
    if (license === undefined) findings.push({ package: label.name, version: label.version, path: dependencyPath.join(" > "), reason: "missing-license" });
    else {
      const parsed = expressionAllowed(license);
      const exception = DEV_TOOL_EXCEPTIONS.get(label.name);
      const requestedName = dependencyPath.at(-1);
      const exactDevToolException =
        devOnly &&
        requestedName === label.name &&
        exception?.license === license;
      if (!parsed.allowed && !exactDevToolException) findings.push({ package: label.name, version: label.version, path: dependencyPath.join(" > "), license, reason: parsed.unknown ? "unknown-license" : "denied-license" });
    }
    // Required (`dependencies`) closure: any declared dep that cannot be inspected
    // is a fail-closed finding under strict mode; we still descend into resolvable
    // entries in both modes so required closures are always observed.
    for (const dependency of dependencyNames(manifest.dependencies)) {
      const target = resolveDependency(dependency, dirname(normalized), root, workspace);
      const nextPath = [...dependencyPath, dependency];
      if (!target) {
        if (strict) findings.push({ package: dependency, version: "unknown", path: nextPath.join(" > "), reason: "uninspectable" });
      } else inspect(target, nextPath, true, devOnly);
    }
    // Workspace-owned devDependencies are part of the functional-core closure.
    // Third-party packages' own devDependencies are build/test metadata for those
    // upstream projects and are neither installed nor part of our shipped closure.
    const isWorkspaceManifest =
      typeof manifest.name === "string" &&
      workspace.get(manifest.name) !== undefined &&
      resolve(workspace.get(manifest.name)!) === normalized;
    if (isWorkspaceManifest) {
      for (const dependency of dependencyNames(manifest.devDependencies)) {
        const target = resolveDependency(dependency, dirname(normalized), root, workspace);
        const nextPath = [...dependencyPath, dependency];
        if (!target) {
          if (strict) findings.push({ package: dependency, version: "unknown", path: nextPath.join(" > "), reason: "uninspectable" });
        } else inspect(target, nextPath, strict, true);
      }
    }
    // `optionalDependencies` + `peerDependencies` differ from `dependencies` in that
    // they may legitimately be absent; we walk them when present, never fail when
    // absent, and never propagate uninspectable findings for the absent case.
    const optionalDependencies = new Set([
      ...dependencyNames(manifest.optionalDependencies),
      ...dependencyNames(manifest.peerDependencies),
    ]);
    for (const dependency of [...optionalDependencies].sort()) {
      const target = resolveDependency(dependency, dirname(normalized), root, workspace);
      if (target) inspect(target, [...dependencyPath, dependency], false, devOnly);
    }
  };
  for (const manifest of manifests) inspect(manifest, [packageLabel(readManifest(manifest) ?? {}, manifest).name], true, false);
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.package.localeCompare(b.package) || a.reason.localeCompare(b.reason) || (a.license ?? "").localeCompare(b.license ?? ""));
  return { ok: findings.length === 0, findings, packages: manifests.length };
}

function human(report: LicenseReport): string {
  if (report.ok) return `License guard passed (${report.packages} workspace package${report.packages === 1 ? "" : "s"}).`;
  return [`License guard failed (${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}):`, ...report.findings.map((finding) => `- ${finding.package}@${finding.version} [${finding.path || finding.package}]: ${finding.reason}${finding.license ? ` (${finding.license})` : ""}`)].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = new Set(process.argv.slice(2));
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 && process.argv[rootIndex + 1] ? process.argv[rootIndex + 1]! : process.cwd();
  const report = inspectWorkspace(root, { strict: !args.has("--non-strict") });
  process.stdout.write(args.has("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${human(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
