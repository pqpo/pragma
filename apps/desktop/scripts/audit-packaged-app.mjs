import { auditRuntimeResources } from "./audit-runtime-resources.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { forbiddenPackageFile } from "./packaging-policy.mjs";
import { applicationInventory, nativeBinaryTarget, summarizeInventory } from "./packaging-size.mjs";
import { auditDesktopCli } from "./audit-desktop-cli.mjs";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { extractFile, listPackage, statFile } from "@electron/asar";

const sdkDirectory = /(?:^|\/)@anthropic-ai\/claude-agent-sdk\//;
const nativeMagic = new Set([
  "cffaedfe",
  "cefaedfe",
  "feedfacf",
  "feedface",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
  "7f454c46",
]);

export function forbiddenClaudePayload(path, size, prefix = Buffer.alloc(0)) {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|\/)@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/.test(normalized))
    return "SDK platform CLI package";
  if (/(?:^|\/)@anthropic-ai\/claude-code(?:\/|$)/.test(normalized))
    return "Claude Code installation";
  if (/(?:^|\/)claude(?:\.(?:exe|com|cmd|js|cjs|mjs))?$/i.test(normalized))
    return "Claude CLI payload";
  if (!sdkDirectory.test(normalized)) return undefined;
  if (/\/(?:vendor|bin)\//.test(normalized) || /\/cli\.(?:js|cjs|mjs)$/.test(normalized))
    return "Embedded SDK CLI layout";
  if (
    nativeMagic.has(prefix.subarray(0, 4).toString("hex")) ||
    prefix.subarray(0, 2).toString() === "MZ"
  )
    return "Native executable inside SDK";
  // Catch renamed script/embedded payloads on SDK upgrades, without filtering
  // other runtimes' native dependencies. Current SDK JS files are < 2 MiB.
  if (size > 5 * 1024 * 1024) return "Unexpected large SDK payload; review dependency upgrade";
  return undefined;
}

export async function auditPackagedResources(resourcesDirectory, options = {}) {
  const inventory = [];
  const failures = [];
  const archive = join(resourcesDirectory, "app.asar");
  for (const [filename, label] of [
    ["claude-acp-worker.js", "Claude ACP worker"],
    ["pragma-command-client.js", "Pragma command client"],
  ]) {
    const path = join("out", "main", filename);
    let unpacked = false;
    try {
      unpacked =
        statFile(archive, path).unpacked &&
        (await stat(join(`${archive}.unpacked`, path))).isFile();
    } catch {
      /* Report missing archive entries and unpacked files as the same actionable failure. */
    }
    if (!unpacked) throw new Error(`Packaged ${label} must exist outside ASAR.`);
  }

  for (const entry of listPackage(archive)) {
    // ASAR queries use host separators; policy matching and reports use '/'.
    const archivePath = entry.replace(/^[\\/]+/, "");
    const portablePath = archivePath.replaceAll("\\", "/");
    const metadata = statFile(archive, archivePath);
    if (metadata.files) continue;
    const label = `app.asar/${portablePath}`;
    if (metadata.link) {
      record(label, 0, Buffer.alloc(0), "asar-link");
      continue;
    }
    const data = extractFile(archive, archivePath);
    record(label, metadata.size, data, metadata.unpacked ? "unpacked-reference" : "asar");
  }
  let physicalBytes = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const { size } = await stat(path);
        physicalBytes += size;
        const label = relative(resourcesDirectory, path).replaceAll("\\", "/");
        // The archive is a container, not a second copy of its logical files.
        const data = label === "app.asar" ? Buffer.alloc(0) : await readFile(path);
        record(label, size, data, "resources");
      } else if (entry.isSymbolicLink()) {
        // Packaged resources must be self-contained and fully auditable.
        failures.push({
          path: relative(resourcesDirectory, path),
          reason: "Unexpected resource symlink",
        });
      }
    }
  }
  await walk(resourcesDirectory);
  function record(path, bytes, data, location) {
    const nativeTarget = nativeBinaryTarget(data);
    const entry = { path, bytes, location };
    if (data.length) entry.sha256 = createHash("sha256").update(data).digest("hex");
    if (nativeTarget) entry.nativeTarget = nativeTarget;
    else if (/\.(?:node|dylib|dll|exe)$/.test(path))
      entry.nativeWarning = "Unrecognized native payload";
    inventory.push(entry);
    const reason = forbiddenClaudePayload(path, bytes, data) ?? forbiddenPackageFile(path, options);
    if (reason) failures.push({ path, bytes, reason });
    if (
      options.platform &&
      options.arch &&
      nativeTarget &&
      (nativeTarget.platform !== options.platform || !nativeTarget.arches.includes(options.arch))
    )
      failures.push({
        path,
        bytes,
        reason: `Native payload ${nativeTarget.platform}/${nativeTarget.arches.join(",")}; expected ${options.platform}/${options.arch}`,
      });
  }
  const report = {
    physicalBytes,
    summary: summarizeInventory(inventory, (await stat(archive)).size),
    largestFiles: [...inventory].sort((a, b) => b.bytes - a.bytes).slice(0, 30),
    failures,
    inventory,
  };
  return report;
}

/** Prevent Node's parent-directory resolver from borrowing repository dependencies. */
export async function withIsolatedPackagedApp(appOutDir, resources, executable, action) {
  const temporary = await mkdtemp(join(tmpdir(), "pragma-isolated-app-"));
  const isolated = join(temporary, "app");
  try {
    await cp(appOutDir, isolated, { recursive: true, dereference: false, verbatimSymlinks: true });
    return await action(
      join(isolated, relative(appOutDir, resources)),
      join(isolated, relative(appOutDir, executable)),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export default async function afterPack(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  const policy = JSON.parse(
    await readFile(
      join(context.outDir, `packaging-policy-${context.electronPlatformName}-${context.arch}.json`),
      "utf8",
    ),
  );
  const report = await auditPackagedResources(resources, policy);
  const applicationRoot =
    context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents")
      : context.appOutDir;
  const applicationFiles = await applicationInventory(applicationRoot, resources);
  report.inventory.push(...applicationFiles);
  for (const entry of applicationFiles)
    if (
      entry.nativeTarget &&
      (entry.nativeTarget.platform !== policy.platform ||
        !entry.nativeTarget.arches.includes(policy.arch))
    )
      report.failures.push({
        path: entry.path,
        bytes: entry.bytes,
        reason: "Electron native payload target mismatch",
      });
  report.applicationBytes =
    report.physicalBytes + applicationFiles.reduce((total, entry) => total + entry.bytes, 0);
  report.summary = summarizeInventory(
    report.inventory,
    (await stat(join(resources, "app.asar"))).size,
  );
  report.largestFiles = report.summary.largestFiles;
  report.identity = {
    platform: policy.platform,
    arch: policy.arch,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: context.packager.projectDir,
      encoding: "utf8",
    }).trim(),
    lockfileSha256: createHash("sha256")
      .update(await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url)))
      .digest("hex"),
    electronVersion: context.packager.info.framework.version,
    appVersion: context.packager.appInfo.version,
    compression: context.packager.config.compression ?? "normal",
    signingIdentity: context.packager.platformSpecificBuildOptions.identity ?? null,
    hardenedRuntime: context.packager.platformSpecificBuildOptions.hardenedRuntime ?? false,
  };
  report.policy = policy;
  report.installers = {};
  report.validation = {
    cli: "pending",
    runtimeExecution: "requires-native-authenticated-smoke",
    desktopUI: "requires-native-visual-smoke",
  };
  const reportPath = join(
    context.outDir,
    `packaging-audit-${context.electronPlatformName}-${context.arch}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assertClean(report);
  const executable =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents/MacOS",
          context.packager.appInfo.productFilename,
        )
      : join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  try {
    await withIsolatedPackagedApp(
      context.appOutDir,
      resources,
      executable,
      async (isolatedResources, isolatedExecutable) => {
        report.cli = await auditDesktopCli(isolatedResources, isolatedExecutable);
        report.validation.cli = "passed";
        report.validation.resources = await auditRuntimeResources(
          isolatedResources,
          isolatedExecutable,
        );
      },
    );
  } catch (error) {
    report.failures.push({
      path: "packaged-smoke",
      reason: error instanceof Error ? error.message : String(error),
    });
    report.validation.smoke = "failed";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Desktop packaging audit passed: ${report.physicalBytes} resource bytes. Report: ${reportPath}`,
  );
}

function assertClean(report) {
  if (report.failures.length)
    throw new Error(
      `Desktop packaging policy violations:\n${report.failures.map((failure) => `${failure.path}: ${failure.reason}`).join("\n")}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await auditPackagedResources(resolve(process.argv[2]));
  console.log(JSON.stringify(report, null, 2));
  assertClean(report);
}
