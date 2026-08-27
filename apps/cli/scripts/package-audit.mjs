import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";

import {
  allowedExternalSpecifiers,
  assertNoBuildPathLeaks,
  assertNoExternalWorkspaceImports,
  assertSafeText,
  isAllowedExternalSpecifier,
} from "./package-audit-lib.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const releaseDirectory = join(packageDirectory, ".release");
const buildDirectories = [
  process.env.GITHUB_WORKSPACE,
  process.env.RUNNER_TEMP,
  process.env.RUNNER_WORKSPACE,
  process.env.RUNNER_TOOL_CACHE,
].filter((value) => typeof value === "string" && value.length > 0);
const expectedFiles = new Set([
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/THIRD_PARTY_NOTICES.txt",
  "package/dist/pragma.js",
  "package/dist/cli.js",
  "package/dist/code-service-worker.js",
]);
const expectedDirectories = new Set(["package", "package/dist"]);
const maxTarballBytes = 32 * 1024 * 1024;
const maxUnpackedBytes = 40 * 1024 * 1024;

const tarballArguments = process.argv.slice(2);
if (tarballArguments.length > 1) {
  throw new Error("Usage: node scripts/package-audit.mjs [actual-package.tgz]");
}

const tarballPath = await resolveTarballPath(tarballArguments[0]);
if (!tarballPath.endsWith(".tgz")) {
  throw new Error(`Audit input must be an actual .tgz file: ${tarballPath}`);
}

const tarball = await readFile(tarballPath);
if (tarball.byteLength > maxTarballBytes) {
  throw new Error(`Tarball is larger than the 32 MiB audit limit: ${tarball.byteLength} bytes.`);
}

const entries = parseTarball(tarballPath, tarball);
const entryMap = new Map(entries.map((entry) => [entry.name, entry]));
const unexpectedEntries = entries
  .filter((entry) => entry.type === "file" && !expectedFiles.has(entry.name))
  .map((entry) => entry.name);
const unexpectedDirectories = entries
  .filter((entry) => entry.type === "directory" && !expectedDirectories.has(entry.name))
  .map((entry) => entry.name);
if (unexpectedEntries.length > 0 || unexpectedDirectories.length > 0) {
  throw new Error(
    `Tarball contains files outside the allowlist: ${[...unexpectedEntries, ...unexpectedDirectories].join(", ")}.`,
  );
}
for (const expectedFile of expectedFiles) {
  const entry = entryMap.get(expectedFile);
  if (entry === undefined || entry.type !== "file") {
    throw new Error(`Tarball is missing required file: ${expectedFile}.`);
  }
  if (entry.data.byteLength === 0)
    throw new Error(`Tarball contains an empty file: ${expectedFile}.`);
}

const packageJson = parsePackageJson(entryMap.get("package/package.json").data);
assertManifest(packageJson);

let unpackedBytes = 0;
for (const entry of entries) {
  if (entry.type !== "file") continue;
  unpackedBytes += entry.data.byteLength;
  if (entry.data.includes(0)) {
    throw new Error(`Tarball contains binary content in an unexpected file: ${entry.name}.`);
  }
  const text = entry.data.toString("utf8");
  const isBundle = entry.name.endsWith("/cli.js") || entry.name.endsWith("/code-service-worker.js");
  assertSafeText(text, entry.name, {
    repositoryDirectory,
    checkDependencyProtocols: true,
    checkAbsolutePaths: !isBundle,
    allowFileUrls: isBundle,
  });
  if (isBundle) {
    assertNoBuildPathLeaks(text, entry.name, { repositoryDirectory, buildDirectories });
    assertNoExternalWorkspaceImports(text, entry.name);
  }
}
if (unpackedBytes > maxUnpackedBytes) {
  throw new Error(
    `Unpacked package is larger than the 40 MiB audit limit: ${unpackedBytes} bytes.`,
  );
}

const bootstrap = entryMap.get("package/dist/pragma.js");
if (!bootstrap.data.subarray(0, 3).equals(Buffer.from("#!/"))) {
  throw new Error("The packaged pragma bin must start with a shebang.");
}
if (bootstrap.data.includes(Buffer.from([0xef, 0xbb, 0xbf]))) {
  throw new Error("The packaged pragma bin must not contain a UTF-8 BOM.");
}
if (!bootstrap.data.toString("utf8").startsWith("#!/usr/bin/env node\n")) {
  throw new Error("The packaged pragma bin must use the Node shebang and LF line endings.");
}
if ((bootstrap.mode & 0o111) === 0) {
  throw new Error("The packaged pragma bin must retain an executable POSIX mode.");
}
assertBootstrapOrder(bootstrap.data.toString("utf8"));

const metafiles = await readMetafiles();
for (const [label, metafile] of metafiles) assertMetafile(label, metafile);
await verifyWorker(entryMap.get("package/dist/code-service-worker.js"));

console.log(
  JSON.stringify(
    {
      ok: true,
      package: packageJson.name,
      version: packageJson.version,
      tarballBytes: tarball.byteLength,
      unpackedBytes,
      files: [...expectedFiles],
      externalAllowlist: [...allowedExternalSpecifiers],
    },
    null,
    2,
  ),
);

function parseTarball(label, compressed) {
  let archive;
  try {
    archive = gunzipSync(compressed);
  } catch (error) {
    throw new Error(
      `Unable to gunzip ${label}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const entries = [];
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const size = readTarOctal(header, 124, 12);
    const mode = readTarOctal(header, 100, 8);
    if (size < 0 || offset + size > archive.byteLength) {
      throw new Error(`Invalid tar entry size for ${fullName}.`);
    }
    const data = Buffer.from(archive.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
    const type = typeFlag === "5" ? "directory" : typeFlag === "2" ? "symlink" : "file";
    if (type === "symlink") throw new Error(`Tarball contains a symlink: ${fullName}.`);
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "5") {
      throw new Error(`Tarball contains unsupported entry type ${typeFlag} at ${fullName}.`);
    }
    const normalizedName = normalize(fullName.split("/").join(sep)).split(sep).join("/");
    if (
      isAbsolute(fullName) ||
      normalizedName !== fullName ||
      normalizedName === ".." ||
      normalizedName.startsWith("../")
    ) {
      throw new Error(`Tarball contains an unsafe path: ${fullName}.`);
    }
    entries.push({ name: fullName, type, mode, data });
  }
  return entries;
}

async function resolveTarballPath(argument) {
  if (argument !== undefined) return resolve(argument);
  let entries;
  try {
    entries = await readdir(releaseDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `No release directory found; run package:pack first: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const tarballs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => entry.name);
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected exactly one actual package tarball in ${releaseDirectory}, found ${tarballs.length}.`,
    );
  }
  return join(releaseDirectory, tarballs[0]);
}

function readTarString(header, start, length) {
  return header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/u, "")
    .trim();
}

function readTarOctal(header, start, length) {
  const value = readTarString(header, start, length).replace(/\0/g, "").trim();
  if (value.length === 0) return 0;
  const parsed = Number.parseInt(value, 8);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

function parsePackageJson(data) {
  try {
    return JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Packaged package.json is invalid: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

function assertManifest(manifest) {
  if (manifest.name !== "@pragma/cli") throw new Error("Unexpected package name in tarball.");
  if (typeof manifest.version !== "string" || !isReleaseVersion(manifest.version)) {
    throw new Error("Tarball package.json must contain a release semver.");
  }
  if (manifest.private !== undefined) throw new Error("Published package must not be private.");
  if (manifest.type !== "module") throw new Error("Published package must be ESM.");
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ pragma: "./dist/pragma.js" })) {
    throw new Error("Tarball bin metadata is not the canonical pragma entry.");
  }
  if (manifest.exports === undefined || Object.keys(manifest.exports).length !== 0) {
    throw new Error("Published package must expose an empty exports map.");
  }
  if (manifest.engines?.node !== ">=22") throw new Error("Tarball Node engine must be >=22.");
  if (JSON.stringify(manifest.os) !== JSON.stringify(["darwin", "win32"])) {
    throw new Error("Tarball OS metadata must target darwin and win32.");
  }
  if (manifest.dependencies === undefined || Object.keys(manifest.dependencies).length !== 1) {
    throw new Error("Tarball dependencies must contain only the native keyring dependency.");
  }
  if (manifest.dependencies["@napi-rs/keyring"] !== "1.3.0") {
    throw new Error("Tarball keyring dependency must be pinned to 1.3.0.");
  }
  for (const field of ["devDependencies", "optionalDependencies", "scripts", "main"]) {
    if (manifest[field] !== undefined) throw new Error(`Tarball must not contain ${field}.`);
  }
  if (
    JSON.stringify(manifest.files) !==
    JSON.stringify(["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"])
  ) {
    throw new Error("Tarball files allowlist is not canonical.");
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error("Tarball publishConfig.access must be public.");
  }
}

async function readMetafiles() {
  const paths = [
    ["cli bundle", join(releaseDirectory, "cli.metafile.json")],
    ["code service worker", join(releaseDirectory, "code-service-worker.metafile.json")],
  ];
  return await Promise.all(
    paths.map(async ([label, path]) => {
      try {
        return [label, JSON.parse(await readFile(path, "utf8"))];
      } catch (error) {
        throw new Error(
          `Unable to read ${label} metafile: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }),
  );
}

function assertMetafile(label, metafile) {
  const external = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.external === true) external.add(imported.path);
    }
  }
  const unexpected = [...external].filter((specifier) => !isAllowedExternalSpecifier(specifier));
  if (unexpected.length > 0) {
    throw new Error(`${label} metafile contains unexpected externals: ${unexpected.join(", ")}.`);
  }
  for (const output of Object.values(metafile.outputs ?? {})) {
    if (output.entryPoint === undefined) continue;
    const entryPoint = output.entryPoint.replaceAll("\\", "/");
    if (entryPoint.endsWith("/src/index.ts") && label !== "cli bundle") {
      throw new Error(`${label} metafile has the CLI entry point.`);
    }
    if (entryPoint.endsWith("/code-service-worker.ts") && label !== "code service worker") {
      throw new Error(`${label} metafile has the worker entry point.`);
    }
  }
  const outputPaths = Object.keys(metafile.outputs ?? {}).map((path) => path.replaceAll("\\", "/"));
  if (label === "cli bundle" && !outputPaths.some((path) => path.endsWith("/cli.js"))) {
    throw new Error("CLI metafile is missing cli.js output.");
  }
  if (
    label === "code service worker" &&
    !outputPaths.some((path) => path.endsWith("/code-service-worker.js"))
  ) {
    throw new Error("Worker metafile is missing code-service-worker.js output.");
  }
}

async function verifyWorker(workerEntry) {
  const extractionDirectory = await mkdtemp(join(packageDirectory, ".worker-audit-"));
  const workerPath = join(extractionDirectory, "code-service-worker.js");
  try {
    await writeFile(workerPath, workerEntry.data, { mode: workerEntry.mode });
    await new Promise((resolvePromise, reject) => {
      const worker = new Worker(pathToFileURL(workerPath));
      let ready = false;
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error("Packaged code service worker did not become ready in 30 seconds."));
      }, 30_000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker
          .terminate()
          .finally(() => (error === undefined ? resolvePromise() : reject(error)));
      };
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (!ready && code !== 0)
          finish(new Error(`Packaged code service worker exited with ${code}.`));
      });
      worker.on("message", (message) => {
        if (message?.type !== "ready") return;
        ready = true;
        finish(undefined);
      });
    });
  } finally {
    await rm(extractionDirectory, { recursive: true, force: true });
  }
}

function assertBootstrapOrder(source) {
  const guard = source.indexOf("nodeMajor < 22");
  const dynamicImport = source.indexOf("import(mainBundle)");
  if (guard < 0 || dynamicImport < 0 || dynamicImport < guard) {
    throw new Error("Bootstrap must validate Node.js before dynamically importing cli.js.");
  }
  if (/\b(?:import|export)\s+(?:[^"'()]+\s+from\s+)?["'][^"']*cli\.js["']/u.test(source)) {
    throw new Error("Bootstrap must not statically import the main CLI bundle.");
  }
}

function isReleaseVersion(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    value,
  );
}
