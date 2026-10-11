import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forbiddenPackageFile,
  nativePackageTarget,
  selectBundledPackages,
} from "./packaging-policy.mjs";
import { nativeBinaryTarget, summarizeInventory, assertSizeBudget } from "./packaging-size.mjs";
import {
  inspectJavaScript,
  findExternalWorkspaceImports,
  findBuildPathLeaks,
} from "../../cli/scripts/package-audit-lib.mjs";

test("parses compressed imports and resolvers without confusing strings with imports", () => {
  const source = `import"node:fs";export*from"@pragma/shared";import("@pragma/core");require("@pragma/memory");require.resolve("sharp");import(dynamicPath);const example='import "@pragma/example"';`;
  assert.deepEqual(findExternalWorkspaceImports(source), [
    "@pragma/shared",
    "@pragma/core",
    "@pragma/memory",
  ]);
  assert.deepEqual(inspectJavaScript(source).specifiers, [
    "node:fs",
    "@pragma/shared",
    "@pragma/core",
    "@pragma/memory",
    "sharp",
  ]);
  assert.equal(inspectJavaScript(source).dynamicLoads, 1);
  assert.ok(
    findBuildPathLeaks(
      String.raw`const file="/home\u002frunner/work/pragma/apps/cli/src/index.ts";`,
    ).includes("build machine source path"),
  );
  assert.deepEqual(
    inspectJavaScript(
      'import{createRequire as c}from"node:module";const r=c(import.meta.url),s=r;s.resolve("sharp");r("@pragma/core");',
    ).specifiers,
    ["node:module", "sharp", "@pragma/core"],
  );
  assert.deepEqual(
    findBuildPathLeaks(`const x="/home/runner/work/pragma/apps/desktop/src/index.ts";`),
    ["build machine source path"],
  );
});

test("keeps packages referenced by generated code or retained transitive dependencies", () => {
  const packages = [
    { manifest: { name: "react", dependencies: { "react-dom": "1" } } },
    { manifest: { name: "react-dom" } },
    { manifest: { name: "@pragma/core", dependencies: { "gpt-tokenizer": "1" } } },
    { manifest: { name: "gpt-tokenizer" } },
    { manifest: { name: "sdk", optionalDependencies: { react: "1" } } },
  ];
  assert.deepEqual(selectBundledPackages(packages, { specifiers: [], literals: [] }), [
    "@pragma/core",
    "gpt-tokenizer",
  ]);
  assert.deepEqual(
    selectBundledPackages(packages, {
      specifiers: ["gpt-tokenizer/encoding/o200k_base"],
      literals: ["@pragma/core"],
    }),
    [],
  );
});

test("filters target packages without dropping dynamic TypeScript or SDK assets", () => {
  assert.deepEqual(nativePackageTarget("@img/sharp-libvips-darwin-arm64"), {
    platform: "darwin",
    arch: "arm64",
  });
  assert.deepEqual(nativePackageTarget("@napi-rs/keyring-win32-x64-msvc"), {
    platform: "win32",
    arch: "x64",
  });
  assert.ok(
    forbiddenPackageFile("node_modules/@esbuild/darwin-arm64/bin/esbuild", {
      platform: "darwin",
      arch: "x64",
    }),
  );
  assert.ok(forbiddenPackageFile("src/main/index.ts"));
  assert.ok(forbiddenPackageFile("node_modules/effect/dist/index.js.map"));
  for (const file of [
    "node_modules/jiti/src/index.ts",
    "node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs",
    "node_modules/sharp/package.json",
    "node_modules/sharp/LICENSE",
  ])
    assert.equal(forbiddenPackageFile(file), undefined);
});

test("detects Mach-O, universal, PE and ELF architectures", () => {
  const macho = Buffer.alloc(32);
  macho.writeUInt32BE(0xcffaedfe);
  macho.writeUInt32LE(0x1000007, 4);
  assert.deepEqual(nativeBinaryTarget(macho), { platform: "darwin", arches: ["x64"] });
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x1000007, 8);
  fat.writeUInt32BE(0x100000c, 28);
  assert.deepEqual(nativeBinaryTarget(fat), { platform: "darwin", arches: ["x64", "arm64"] });
  const pe = Buffer.alloc(128);
  pe.write("MZ");
  pe.writeUInt32LE(64, 60);
  pe.write("PE\0\0", 64);
  pe.writeUInt16LE(0x8664, 68);
  assert.deepEqual(nativeBinaryTarget(pe), { platform: "win32", arches: ["x64"] });
  const elf = Buffer.alloc(32);
  elf.write("\x7fELF");
  elf[5] = 1;
  elf.writeUInt16LE(183, 18);
  assert.deepEqual(nativeBinaryTarget(elf), { platform: "linux", arches: ["arm64"] });
});

test("counts unpacked content once and separates ASAR overhead", () => {
  const summary = summarizeInventory(
    [
      { path: "app.asar/out/main/index.js", bytes: 10, location: "asar", sha256: "a" },
      {
        path: "app.asar/out/main/desktop-cli/cli.js",
        bytes: 10,
        location: "unpacked-reference",
        sha256: "a",
      },
      {
        path: "app.asar.unpacked/out/main/desktop-cli/cli.js",
        bytes: 10,
        location: "resources",
        sha256: "a",
      },
      { path: "app.asar", bytes: 15, location: "resources" },
    ],
    15,
  );
  assert.equal(summary.categories["application-js"], 20);
  assert.equal(summary.categories["asar-metadata"], 5);
  assert.equal(summary.duplicates[0].redundantBytes, 10);
});

test("size budget requires both five percent and five MiB growth", () => {
  const mib = 1024 ** 2;
  assert.doesNotThrow(() => assertSizeBudget(104 * mib, 100 * mib, "app"));
  assert.doesNotThrow(() => assertSizeBudget(212 * mib, 210 * mib, "app"));
  assert.throws(() => assertSizeBudget(112 * mib, 100 * mib, "app"), /exceeds size baseline/);
});

test("concurrent DMG and ZIP completion retains both measurements", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { default: recordArtifact } = await import("./packaging-size.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pragma-size-artifacts-"));
  try {
    const reportPath = join(directory, "packaging-audit-darwin-1.json");
    await writeFile(reportPath, JSON.stringify({ installers: {} }));
    const files = ["Pragma-0.0.0-mac-x64.dmg", "Pragma-0.0.0-mac-x64.zip"];
    await Promise.all(
      files.map(async (name) => {
        const file = join(directory, name);
        await writeFile(file, "installer-canary");
        await recordArtifact({ file, packager: { info: { outDir: directory } } });
      }),
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(Object.keys(report.installers).sort(), files.sort());
    assert.ok(
      Object.values(report.installers).every(
        (entry) => entry.bytes === 16 && /^[a-f0-9]{64}$/.test(entry.sha256),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
