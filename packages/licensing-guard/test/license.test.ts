import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_LICENSES, inspectWorkspace } from "../src/index.js";

interface ManifestInput {
  name?: string;
  version?: string;
  license?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function workspace(rootManifest: ManifestInput, dependencies: Record<string, ManifestInput> = {}, options: { nestedPackages?: Record<string, ManifestInput> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "licensing-guard-"));
  await writeFile(join(root, "package.json"), JSON.stringify(rootManifest));
  for (const [name, dependency] of Object.entries(dependencies)) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", ...dependency }));
  }
  for (const [subdir, manifest] of Object.entries(options.nestedPackages ?? {})) {
    const directory = join(root, "packages", subdir);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

const sourceDir = dirname(fileURLToPath(import.meta.url));
const allowlistPath = resolve(sourceDir, "..", "allowlist.json");

describe("licensing guard", () => {
  it("allows the approved licenses in dependency closure", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "Apache-2.0", dependencies: { good: "1.0.0" } }, { good: { license: "MIT" } });
    expect(inspectWorkspace(root)).toMatchObject({ ok: true, findings: [] });
  });
  it("denies copyleft and proprietary licenses", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "GPL-3.0-only" });
    const report = inspectWorkspace(root);
    expect(report.ok).toBe(false);
    expect(report.findings[0]).toMatchObject({ reason: "denied-license", license: "GPL-3.0-only" });
  });
  it("requires every branch of an AND expression", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "MIT AND GPL-3.0-only" });
    expect(inspectWorkspace(root).findings[0]?.reason).toBe("denied-license");
  });
  it("accepts an approved branch of an OR expression", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "MIT OR GPL-3.0-only" });
    expect(inspectWorkspace(root).ok).toBe(true);
  });
  it("rejects unknown and missing metadata", async () => {
    const unknown = await workspace({ name: "app", version: "1.0.0", license: "LicenseRef-Custom" });
    const missing = await workspace({ name: "app", version: "1.0.0" });
    expect(inspectWorkspace(unknown).findings[0]?.reason).toBe("unknown-license");
    expect(inspectWorkspace(missing).findings[0]?.reason).toBe("missing-license");
  });
  it("validates workspace packages before installation", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "Apache-2.0" }, {}, { nestedPackages: { local: { name: "local", version: "1.0.0", license: "ISC" } } });
    expect(inspectWorkspace(root).packages).toBe(2);
  });
  it("fails closed for an uninspectable declared external dependency in strict mode", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "MIT", dependencies: { absent: "1.0.0" } });
    expect(inspectWorkspace(root).findings[0]?.reason).toBe("uninspectable");
    expect(inspectWorkspace(root, { strict: false }).ok).toBe(true);
  });
  it("exposes the shipped allowlist as the authoritative policy source", () => {
    const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as {
      allowed: string[];
      devToolExceptions: Array<{ package: string; license: string }>;
    };
    expect([...ALLOWED_LICENSES].sort()).toEqual([...allowlist.allowed].sort());
    expect(allowlist.devToolExceptions).toEqual([
      expect.objectContaining({ package: "@axe-core/playwright", license: "MPL-2.0" }),
      expect.objectContaining({ package: "axe-core", license: "MPL-2.0" }),
    ]);
  });
  it("allows only the audited Axe WCAG tools on an exclusively dev-only path", async () => {
    const root = await workspace(
      { name: "app", version: "1.0.0", license: "Apache-2.0", devDependencies: { "@axe-core/playwright": "4.12.1" } },
      {
        "@axe-core/playwright": { license: "MPL-2.0", dependencies: { "axe-core": "4.12.1" } },
        "axe-core": { license: "MPL-2.0" },
      },
    );
    expect(inspectWorkspace(root)).toMatchObject({ ok: true, findings: [] });
  });

  it("rejects the audited Axe packages when promoted to a runtime dependency", async () => {
    const root = await workspace(
      { name: "app", version: "1.0.0", license: "Apache-2.0", dependencies: { "@axe-core/playwright": "4.12.1" } },
      {
        "@axe-core/playwright": { license: "MPL-2.0", dependencies: { "axe-core": "4.12.1" } },
        "axe-core": { license: "MPL-2.0" },
      },
    );
    const report = inspectWorkspace(root);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: "@axe-core/playwright", license: "MPL-2.0", reason: "unknown-license" }),
      expect.objectContaining({ package: "axe-core", license: "MPL-2.0", reason: "unknown-license" }),
    ]));
  });

  it("rejects wrong-license and lookalike dev tools instead of broadening the exception", async () => {
    const wrongLicense = await workspace(
      { name: "app", version: "1.0.0", license: "Apache-2.0", devDependencies: { "@axe-core/playwright": "4.12.1" } },
      { "@axe-core/playwright": { license: "GPL-3.0-only" } },
    );
    const lookalike = await workspace(
      { name: "app", version: "1.0.0", license: "Apache-2.0", devDependencies: { "axe-core-fork": "1.0.0" } },
      { "axe-core-fork": { license: "MPL-2.0" } },
    );
    expect(inspectWorkspace(wrongLicense).findings[0]).toMatchObject({ package: "@axe-core/playwright", reason: "denied-license" });
    expect(inspectWorkspace(lookalike).findings[0]).toMatchObject({ package: "axe-core-fork", reason: "unknown-license" });
  });
  it("inspects devDependencies in strict mode and denies tooling found there", async () => {
    const root = await workspace(
      { name: "app", version: "1.0.0", license: "MIT", devDependencies: { denied: "1.0.0" } },
      { denied: { license: "GPL-3.0-only" } },
    );
    const report = inspectWorkspace(root);
    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.path.includes("denied") && finding.reason === "denied-license")).toBe(true);
  });
  it("flags an uninspectable devDependency in strict mode and tolerates it in non-strict", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "MIT", devDependencies: { absent: "1.0.0" } });
    expect(inspectWorkspace(root).findings.some((finding) => finding.reason === "uninspectable" && finding.path.includes("absent"))).toBe(true);
    expect(inspectWorkspace(root, { strict: false }).ok).toBe(true);
  });
  it("walks optionalDependencies and peerDependencies only when installed", async () => {
    const root = await workspace(
      { name: "app", version: "1.0.0", license: "MIT", dependencies: { has: "1.0.0" } },
      { has: { license: "ISC", optionalDependencies: { present: "1.0.0", missing: "1.0.0" }, peerDependencies: { peerPresent: "1.0.0", peerMissing: "1.0.0" } }, present: { license: "Apache-2.0" }, peerPresent: { license: "MIT" } },
    );
    expect(inspectWorkspace(root).ok).toBe(true);
  });
  it("does not record a finding for an absent optional/peer dependency", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "MIT", peerDependencies: { missing: "1.0.0" } });
    expect(inspectWorkspace(root).ok).toBe(true);
  });
  it("follows a workspace cycle A→B→A without infinite recursion", async () => {
    const root = await mkdtemp(join(tmpdir(), "licensing-guard-cycle-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "root", version: "1.0.0", license: "MIT", dependencies: { "@scope/a": "1.0.0" } }));
    await mkdir(join(root, "packages", "a"), { recursive: true });
    await mkdir(join(root, "packages", "b"), { recursive: true });
    await writeFile(join(root, "packages", "a", "package.json"), JSON.stringify({ name: "@scope/a", version: "1.0.0", license: "Apache-2.0", dependencies: { "@scope/b": "1.0.0" } }));
    await writeFile(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "@scope/b", version: "1.0.0", license: "MIT", dependencies: { "@scope/a": "1.0.0" } }));
    const report = inspectWorkspace(root);
    expect(report.ok).toBe(true);
  });
  it("evaluates nested parenthesized expressions against the full allow/deny matrix", async () => {
    const cases: Array<{ license: string; ok: boolean; reason?: string }> = [
      { license: "MIT AND ISC AND BSD-3-Clause", ok: true },
      { license: "(MIT OR Apache-2.0) AND (ISC OR BSD-3-Clause)", ok: true },
      { license: "(MIT) AND (GPL-3.0-only)", ok: false, reason: "denied-license" },
      { license: "(MIT OR Apache-2.0) AND (GPL-3.0-only OR AGPL-3.0-only)", ok: false, reason: "denied-license" },
      { license: "LicenseRef-Custom OR MIT", ok: true },
      { license: "LicenseRef-Custom OR GPL-3.0-only", ok: false, reason: "denied-license" },
      { license: "(MIT", ok: false, reason: "unknown-license" },
      { license: "MIT AND", ok: false, reason: "unknown-license" },
      { license: "MIT WITH", ok: false, reason: "unknown-license" },
      { license: "(MIT))", ok: false, reason: "unknown-license" },
      { license: "  MIT  ", ok: true },
    ];
    for (const sample of cases) {
      const root = await workspace({ name: "app", version: "1.0.0", license: sample.license });
      const report = inspectWorkspace(root);
      expect({ license: sample.license, ok: report.ok, findings: report.findings.map((finding) => finding.reason) }).toEqual(
        sample.reason === undefined ? { license: sample.license, ok: sample.ok, findings: [] } : { license: sample.license, ok: sample.ok, findings: [sample.reason] },
      );
    }
  });
  it("treats SPDX WITH with an unlisted exception as fail-closed (unknown-license)", async () => {
    const root = await workspace({ name: "app", version: "1.0.0", license: "Apache-2.0 WITH LLVM-exception" });
    const report = inspectWorkspace(root);
    expect(report.ok).toBe(false);
    expect(report.findings[0]).toMatchObject({ reason: "unknown-license", license: "Apache-2.0 WITH LLVM-exception" });
  });
  it("ships a conservative empty WITH exception list that pins documented rejection", () => {
    const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as { withExceptions: string[] };
    expect(allowlist.withExceptions).toEqual([]);
  });
  it("rejects non-string license metadata as missing-license", async () => {
    const array = await workspace({ name: "app", version: "1.0.0", license: ["MIT"] });
    const object = await workspace({ name: "app", version: "1.0.0", license: { type: "MIT" } });
    const nullMeta = await workspace({ name: "app", version: "1.0.0", license: null });
    const number = await workspace({ name: "app", version: "1.0.0", license: 42 });
    expect(inspectWorkspace(array).findings[0]?.reason).toBe("missing-license");
    expect(inspectWorkspace(object).findings[0]?.reason).toBe("missing-license");
    expect(inspectWorkspace(nullMeta).findings[0]?.reason).toBe("missing-license");
    expect(inspectWorkspace(number).findings[0]?.reason).toBe("missing-license");
  });
  it("deterministically orders findings across repeated calls", async () => {
    const root = await workspace(
      { name: "app", version: "1.0.0", license: "Apache-2.0", dependencies: { b: "1.0.0", c: "1.0.0" } },
      { b: { license: "GPL-3.0-only" }, c: { license: "LicenseRef-Custom" } },
    );
    const first = JSON.stringify(inspectWorkspace(root).findings);
    const second = JSON.stringify(inspectWorkspace(root).findings);
    expect(first).toBe(second);
  });
  it("honors a custom root via the rootDirectory parameter", async () => {
    const stage = await mkdtemp(join(tmpdir(), "licensing-guard-root-"));
    await mkdir(join(stage, "real-root", "node_modules", "good"), { recursive: true });
    await writeFile(join(stage, "real-root", "package.json"), JSON.stringify({ name: "app", license: "MIT", dependencies: { good: "1.0.0" } }));
    await writeFile(join(stage, "real-root", "node_modules", "good", "package.json"), JSON.stringify({ name: "good", version: "1.0.0", license: "Apache-2.0" }));
    const report = inspectWorkspace(join(stage, "real-root"));
    expect(report.ok).toBe(true);
    expect(report.packages).toBe(1);
  });
  it("scopes dependency closure walks to the chosen root", async () => {
    // Stage one: declaring a dep that resolves into `node_modules/outside` (a
    // workspace-internal package) should surface a denied license finding.
    const root = await mkdtemp(join(tmpdir(), "licensing-guard-closure-"));
    const inner = join(root, "packages", "inner");
    await mkdir(join(inner, "node_modules", "outside"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "root-app", version: "1.0.0", license: "MIT" }));
    await writeFile(join(inner, "package.json"), JSON.stringify({ name: "inner-app", version: "1.0.0", license: "MIT", dependencies: { outside: "1.0.0" } }));
    await writeFile(join(inner, "node_modules", "outside", "package.json"), JSON.stringify({ name: "outside", version: "1.0.0", license: "GPL-3.0-only" }));
    const innerReport = inspectWorkspace(inner);
    expect(innerReport.findings.find((finding) => finding.path.includes("outside"))).toBeDefined();
    // Stage two: an unstaged copy of an unrelated `node_modules/stale` package
    // sitting next to a workspace manifest MUST be ignored when the package
    // has no declared dependency on it — auto-traversing `node_modules/`
    // would surface false positives.
    const staleStage = await mkdtemp(join(tmpdir(), "licensing-guard-stale-"));
    await mkdir(join(staleStage, "node_modules", "stale"), { recursive: true });
    await writeFile(join(staleStage, "package.json"), JSON.stringify({ name: "stale-app", version: "1.0.0", license: "MIT" }));
    await writeFile(join(staleStage, "node_modules", "stale", "package.json"), JSON.stringify({ name: "stale", version: "1.0.0", license: "GPL-3.0-only" }));
    const staleReport = inspectWorkspace(staleStage);
    expect(staleReport.findings).toEqual([]);
  });
  it("resolves a hoisted dependency installed at the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "licensing-guard-hoisted-"));
    const nested = join(root, "packages", "app");
    await mkdir(join(nested, "node_modules"), { recursive: true });
    await mkdir(join(root, "node_modules", "hoisted"), { recursive: true });
    await writeFile(join(nested, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", license: "MIT", dependencies: { hoisted: "1.0.0" } }));
    await writeFile(join(root, "node_modules", "hoisted", "package.json"), JSON.stringify({ name: "hoisted", version: "1.0.0", license: "Apache-2.0" }));
    expect(inspectWorkspace(root).ok).toBe(true);
  });
  it("distinguishes required dependency uninspectability from dev-only uninspectability", async () => {
    const root = await workspace(
      { name: "app", version: "1.0.0", license: "MIT", dependencies: { missing: "1.0.0" }, devDependencies: { devMissing: "1.0.0" } },
    );
    const report = inspectWorkspace(root);
    expect(report.ok).toBe(false);
    expect(report.findings.filter((finding) => finding.reason === "uninspectable").length).toBeGreaterThanOrEqual(2);
  });
});

describe("licensing guard pnpm-aware resolution", () => {
  it("treats symlinked workspace members as a single workspace manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "licensing-guard-symlink-"));
    const repo = join(root, "packages", "lib");
    const nodeModules = join(root, "node_modules");
    await mkdir(repo, { recursive: true });
    await mkdir(join(nodeModules, "@scope"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "@scope/lib", version: "1.0.0", license: "MIT" }));
    try {
      await symlink(repo, join(nodeModules, "@scope", "lib"), "dir");
    } catch (error: unknown) {
      // Some hosts disallow symlink creation in tmp; we treat that as a skip.
      expect(String(error)).toMatch(/EPERM|ELOOP|EACCES/);
      return;
    }
    const report = inspectWorkspace(root);
    expect(report.ok).toBe(true);
    expect(report.packages).toBe(1);
  });
});
