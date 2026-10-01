import { lstatSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const turboDirectory = resolve(workspaceRoot, ".turbo");
const cacheDirectory = resolve(turboDirectory, "cache");

function directorySize(path) {
  let totalBytes = 0;

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name);
    const entryStats = lstatSync(entryPath);
    totalBytes +=
      entryStats.isDirectory() && !entryStats.isSymbolicLink()
        ? directorySize(entryPath)
        : entryStats.size;
  }

  return totalBytes;
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

let turboStats;
let cacheStats;

try {
  turboStats = lstatSync(turboDirectory);
  cacheStats = lstatSync(cacheDirectory);
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("Turborepo local cache is already empty.");
    process.exit(0);
  }

  throw error;
}

if (
  !turboStats.isDirectory() ||
  turboStats.isSymbolicLink() ||
  !cacheStats.isDirectory() ||
  cacheStats.isSymbolicLink()
) {
  throw new Error("Refusing to clean an unexpected Turborepo cache path.");
}

const bytesFreed = directorySize(cacheDirectory);
rmSync(cacheDirectory, { recursive: true, force: true });
console.log(`Removed ${formatBytes(bytesFreed)} from .turbo/cache.`);
