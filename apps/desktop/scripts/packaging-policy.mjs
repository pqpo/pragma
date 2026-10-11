import { createRequire } from "node:module";
import { readFile, readdir, realpath, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectJavaScript } from "../../cli/scripts/package-audit-lib.mjs";

export const rendererPackages = [
  "react",
  "react-dom",
  "@phosphor-icons/react",
  "@lobehub/icons-static-svg",
  "@codemirror/commands",
  "@codemirror/merge",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@dagrejs/dagre",
  "@tanstack/react-virtual",
  "@xyflow/react",
  "i18next",
  "react-i18next",
];

/** Only these well-known platform package families are filtered by target. */
export function nativePackageTarget(name) {
  const match = name.match(
    /^(?:@img\/sharp-(?:libvips-)?|@napi-rs\/keyring-|@mariozechner\/clipboard-|@esbuild\/|@msgpackr-extract\/msgpackr-extract-)(darwin|win32|linux|freebsd|android|openbsd|netbsd|aix|sunos|openharmony)-(x64|arm64|ia32|arm|riscv64|ppc64|s390x|loong64|mips64el)(?:-|$)/,
  );
  return match ? { platform: match[1], arch: match[2] } : undefined;
}

export function forbiddenPackageFile(path, { platform, arch, excludedPackages = [] } = {}) {
  const normalized = path.replaceAll("\\", "/").replace(/^app\.asar(?:\.unpacked)?\//, "");
  if (/\.map$/.test(normalized)) return "Production source map";
  if (
    !normalized.startsWith("node_modules/") &&
    /^(?:src|scripts|test|tests|\.turbo|\.packaging)(?:\/|$)/.test(normalized)
  )
    return "Application development files";
  if (!normalized.startsWith("node_modules/") && /(?:\.tsbuildinfo|\.log)$/.test(normalized))
    return "Application build cache or log";
  const embedded = normalized.match(
    /\/native\/(darwin|win32|linux)\/prebuilds\/(?:darwin|win32|linux)-(x64|arm64)\//,
  );
  if (platform && arch && embedded && (embedded[1] !== platform || embedded[2] !== arch))
    return "Embedded native prebuild target mismatch";
  const match = normalized.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (!match) return undefined;
  const name = match[1];
  if (excludedPackages.includes(name)) return "Bundled dependency copy";
  const target = nativePackageTarget(name);
  if (platform && arch && target && (target.platform !== platform || target.arch !== arch))
    return `Native package target ${target.platform}/${target.arch}; expected ${platform}/${arch}`;
  return undefined;
}

async function resolvePackage(name, directory) {
  const require = createRequire(resolve(directory, "package.json"));
  for (const root of require.resolve.paths(name) ?? []) {
    const candidate = join(root, name);
    try {
      const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
      return { directory: await realpath(candidate), manifest };
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  return undefined;
}

export async function collectProductionPackages(directory) {
  const root = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const packages = new Map();
  async function visit(name, from) {
    const resolved = await resolvePackage(name, from);
    if (!resolved || packages.has(resolved.directory)) return;
    packages.set(resolved.directory, resolved);
    for (const dependency of Object.keys({
      ...resolved.manifest.dependencies,
      ...resolved.manifest.optionalDependencies,
    }))
      await visit(dependency, resolved.directory);
  }
  for (const name of Object.keys({ ...root.dependencies, ...root.optionalDependencies }))
    await visit(name, directory);
  return [...packages.values()];
}

export async function inspectOutput(directory) {
  const files = [];
  const specifiers = new Set();
  const literals = new Set();
  let dynamicLoads = 0;
  async function walk(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.[cm]?js$/.test(entry.name)) {
        const inspected = inspectJavaScript(await readFile(path, "utf8"));
        files.push({
          path: path.slice(directory.length + 1),
          specifiers: inspected.specifiers,
          dynamicLoads: inspected.dynamicLoads,
        });
        for (const name of inspected.specifiers) specifiers.add(name);
        for (const name of inspected.literals) literals.add(name);
        dynamicLoads += inspected.dynamicLoads;
      }
    }
  }
  await walk(directory);
  return { files, specifiers: [...specifiers], literals: [...literals], dynamicLoads };
}

export function selectBundledPackages(packages, inspected) {
  const candidates = new Set([
    ...rendererPackages,
    "gpt-tokenizer",
    ...packages.map(({ manifest }) => manifest.name).filter((name) => name.startsWith("@pragma/")),
  ]);
  // A literal reference can also be used by a nonliteral import/require resolver.
  for (const candidate of [...candidates])
    if (
      [...inspected.specifiers, ...inspected.literals].some(
        (name) => name === candidate || name.startsWith(`${candidate}/`),
      )
    )
      candidates.delete(candidate);
  // Retained third-party packages may load dependencies dynamically. Their manifest
  // requirements are conservative roots; propagate until the graph stabilizes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { manifest } of packages) {
      if (candidates.has(manifest.name)) continue;
      for (const name of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }))
        if (candidates.delete(name)) changed = true;
    }
  }
  return [...candidates]
    .filter((name) => packages.some(({ manifest }) => manifest.name === name))
    .sort();
}

const originalFilePatterns = new WeakMap();

export default async function beforePack(context) {
  const directory = context.packager.projectDir;
  const arch = ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch];
  const platform = context.electronPlatformName;
  if (!arch || arch === "universal")
    throw new Error(`Unsupported Desktop packaging target: ${platform}/${arch}`);
  const inspected = await inspectOutput(join(directory, "out/main"));
  const packages = await collectProductionPackages(directory);
  const excludedPackages = selectBundledPackages(packages, inspected);
  const wrongNativePackages = packages
    .map(({ manifest }) => manifest.name)
    .filter((name) => {
      const target = nativePackageTarget(name);
      return target && (target.platform !== platform || target.arch !== arch);
    });
  const exclusions = [...new Set([...excludedPackages, ...wrongNativePackages])].map(
    (name) => `!**/node_modules/${name}{,/**/*}`,
  );
  const embeddedExclusions = [];
  for (const embeddedPlatform of ["darwin", "win32", "linux"])
    for (const embeddedArch of ["x64", "arm64"])
      if (embeddedPlatform !== platform || embeddedArch !== arch)
        embeddedExclusions.push(
          `!**/node_modules/@earendil-works/pi-tui/native/${embeddedPlatform}/prebuilds/${embeddedPlatform}-${embeddedArch}{,/**/*}`,
        );
  exclusions.push(...embeddedExclusions);
  // Both application and dependency matchers read these config exclusions.
  const config = context.packager.config;
  if (!originalFilePatterns.has(config)) originalFilePatterns.set(config, [...config.files]);
  config.files = [...originalFilePatterns.get(config), ...exclusions];
  const noticesDirectory = join(directory, ".packaging/third-party-notices");
  await rm(noticesDirectory, { recursive: true, force: true });
  await mkdir(noticesDirectory, { recursive: true });
  // Bundling changes where code lives, not its attribution requirements.
  for (const { directory: packageDirectory, manifest } of packages) {
    const destination = join(
      noticesDirectory,
      manifest.name.replaceAll("/", "__"),
      manifest.version,
    );
    for (const entry of await readdir(packageDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(entry.name)) {
        await mkdir(destination, { recursive: true });
        await cp(join(packageDirectory, entry.name), join(destination, entry.name));
      }
    }
  }
  const report = {
    platform,
    arch,
    excludedPackages,
    wrongNativePackages,
    embeddedExclusions,
    rules: excludedPackages.map((name) => ({
      package: name,
      reason: "No generated reference or retained production dependency",
      verification: "packaged runtime and CLI smoke",
    })),
    retainedDynamicResources: [
      "@qoder-ai/qoder-agent-sdk",
      "@earendil-works/pi-coding-agent",
      "jiti",
      "esbuild",
    ],
    packages: packages.map(({ manifest }) => ({ name: manifest.name, version: manifest.version })),
    files: inspected.files,
    buildMetadata: await readFile(join(directory, ".packaging/cli-metafiles.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    dynamicLoads: inspected.dynamicLoads,
  };
  await mkdir(context.outDir, { recursive: true });
  await writeFile(
    join(context.outDir, `packaging-policy-${platform}-${context.arch}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
}
