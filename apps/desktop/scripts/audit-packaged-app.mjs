import { open, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export async function auditPackagedResources(resourcesDirectory) {
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
    // Read only SDK files for content inspection; names identify platform packages.
    const prefix =
      sdkDirectory.test(portablePath) && metadata.size <= 5 * 1024 * 1024
        ? extractFile(archive, archivePath).subarray(0, 4)
        : Buffer.alloc(0);
    record(label, metadata.size, prefix, metadata.unpacked ? "unpacked-reference" : "asar");
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
        let prefix = Buffer.alloc(0);
        if (sdkDirectory.test(label)) {
          const file = await open(path, "r");
          try {
            prefix = Buffer.alloc(4);
            await file.read(prefix, 0, 4, 0);
          } finally {
            await file.close();
          }
        }
        record(label, size, prefix, "resources");
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
  function record(path, bytes, prefix, location) {
    inventory.push({ path, bytes, location });
    const reason = forbiddenClaudePayload(path, bytes, prefix);
    if (reason) failures.push({ path, bytes, reason });
  }
  const report = {
    physicalBytes,
    largestFiles: [...inventory].sort((a, b) => b.bytes - a.bytes).slice(0, 30),
    failures,
    inventory,
  };
  return report;
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
  const report = await auditPackagedResources(resources);
  const reportPath = join(
    context.outDir,
    `packaging-audit-${context.electronPlatformName}-${context.arch}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assertClean(report);
  console.log(
    `Desktop packaging audit passed: ${report.physicalBytes} resource bytes. Report: ${reportPath}`,
  );
}

function assertClean(report) {
  if (report.failures.length)
    throw new Error(
      `Desktop must not bundle Claude Code CLI:\n${report.failures.map((failure) => `${failure.path}: ${failure.reason}`).join("\n")}`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await auditPackagedResources(resolve(process.argv[2]));
  console.log(JSON.stringify(report, null, 2));
  assertClean(report);
}
