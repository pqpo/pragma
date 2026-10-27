#!/usr/bin/env node
import { loadDistribution, assertDesktopDistribution } from "../../../scripts/distribution.mjs";
import { prepareDistributionBuilder } from "./distribution-builder.mjs";
import { verifyArtifact } from "../../../scripts/build-artifact.mjs";

import { lstat, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const distDirectory = resolve(packageDirectory, "dist");
const installerPattern = /\.(?:dmg|zip|exe)$/i;
const auditReportPattern = /^packaging-(?:audit|policy)-[a-z0-9-]+\.json$/i;

function commandInvocation(command, argumentsList) {
  if (process.platform === "win32" && command === "pnpm") {
    const pnpmEntryPoint = process.env.npm_execpath;
    if (pnpmEntryPoint === undefined || !/\.(?:cjs|mjs|js)$/i.test(pnpmEntryPoint)) {
      throw new Error(
        "Windows packaging requires npm_execpath to point to pnpm's JavaScript entry point.",
      );
    }

    return {
      command: process.execPath,
      argumentsList: [pnpmEntryPoint, ...argumentsList],
    };
  }

  return { command, argumentsList };
}

function formatCommand(command, argumentsList) {
  return [command, ...argumentsList]
    .map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
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

async function pathSize(path) {
  const entryStats = await lstat(path);
  if (!entryStats.isDirectory() || entryStats.isSymbolicLink()) {
    return entryStats.size;
  }

  let totalBytes = 0;
  for (const entry of await readdir(path)) {
    totalBytes += await pathSize(resolve(path, entry));
  }
  return totalBytes;
}

async function existingDistStats() {
  try {
    const entryStats = await lstat(distDirectory);
    if (!entryStats.isDirectory() || entryStats.isSymbolicLink()) {
      throw new Error(`Refusing to modify unexpected dist path: ${distDirectory}`);
    }
    return entryStats;
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function clearDist() {
  if ((await existingDistStats()) === undefined) {
    console.log("Desktop dist directory is already empty.");
    return 0;
  }

  const bytesRemoved = await pathSize(distDirectory);
  await rm(distDirectory, { recursive: true, force: true });
  console.log(`Removed ${formatBytes(bytesRemoved)} from apps/desktop/dist.`);
  return bytesRemoved;
}

export async function trimDist({ keepInstallers, keepReports = true }, directory = distDirectory) {
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error(`Unexpected dist path: ${directory}`);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const keptEntries = entries.filter(
    (entry) =>
      entry.isFile() &&
      ((keepInstallers && installerPattern.test(entry.name)) ||
        (keepReports && auditReportPattern.test(entry.name))),
  );
  const installerCount = keptEntries.filter((entry) => installerPattern.test(entry.name)).length;

  if (keepInstallers && installerCount === 0) {
    await trimDist({ keepInstallers: false, keepReports }, directory);
    throw new Error("electron-builder completed without leaving any installer files in dist.");
  }

  const keptNames = new Set(keptEntries.map((entry) => entry.name));
  let bytesRemoved = 0;
  for (const entry of entries) {
    if (keptNames.has(entry.name)) {
      continue;
    }

    const entryPath = resolve(directory, entry.name);
    bytesRemoved += await pathSize(entryPath);
    await rm(entryPath, { recursive: true, force: true });
  }

  const retainedBytes = await Promise.all(
    keptEntries.map(async (entry) => (await stat(resolve(directory, entry.name))).size),
  ).then((sizes) => sizes.reduce((total, size) => total + size, 0));

  console.log(
    `Removed ${formatBytes(bytesRemoved)} of temporary packaging output; retained ${installerCount} installer(s) and ${formatBytes(retainedBytes)} in apps/desktop/dist.`,
  );
}

function runCommand(command, argumentsList) {
  const invocation = commandInvocation(command, argumentsList);
  console.log(`\n$ ${formatCommand(invocation.command, invocation.argumentsList)}`);

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(invocation.command, invocation.argumentsList, {
      cwd: packageDirectory,
      shell: false,
      stdio: "inherit",
    });

    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          `${invocation.command} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}.`,
        ),
      );
    });
  });
}

export function assertDistributionBuilderArguments(argumentsList) {
  if (
    argumentsList.some((argument) => argument.startsWith("--config") || argument.startsWith("-c"))
  ) {
    throw new Error("Use PRAGMA_DISTRIBUTION_CONFIG to configure packaging identity.");
  }
}

async function main() {
  const prepared = process.argv.includes("--prepared");
  const builderArguments = process.argv.slice(2).filter((argument) => argument !== "--prepared");
  if (builderArguments.length === 1 && builderArguments[0] === "--clean-only") {
    await clearDist();
    return;
  }

  assertDistributionBuilderArguments(builderArguments);
  const keepUnpackedDirectory = builderArguments.includes("--dir");
  await clearDist();

  let packagingSucceeded = false;
  try {
    if (prepared) {
      await verifyArtifact("desktop");
      for (const check of [
        "verify:styles",
        "verify:main",
        "verify:preload",
        "verify:storage-worker",
      ])
        await runCommand("pnpm", ["run", check]);
    } else await runCommand("pnpm", ["run", "build"]);
    const profile = await loadDistribution();
    await assertDesktopDistribution(resolve(packageDirectory, "out/main"), profile);
    const distributionConfig = await prepareDistributionBuilder(profile);
    await runCommand("pnpm", [
      "exec",
      "electron-builder",
      "--config",
      distributionConfig,
      ...builderArguments,
    ]);
    packagingSucceeded = true;
  } finally {
    if (packagingSucceeded && keepUnpackedDirectory) {
      console.log("Kept the requested unpacked app output in apps/desktop/dist.");
    } else if (packagingSucceeded) {
      await trimDist({ keepInstallers: true });
    } else {
      await trimDist({ keepInstallers: false });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nDesktop packaging failed: ${message}`);
    process.exitCode = 1;
  }
}
