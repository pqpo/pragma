#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const packageJsonPath = join(packageDirectory, "package.json");
const defaultReleaseDirectory = join(repositoryDirectory, "release-assets");
const versionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const platformDefinitions = new Map([
  [
    "mac-arm64",
    {
      hostPlatform: "darwin",
      script: "dist:mac:arm64",
      artifactExtensions: ["dmg", "zip"],
    },
  ],
  [
    "mac-x64",
    {
      hostPlatform: "darwin",
      script: "dist:mac:x64",
      artifactExtensions: ["dmg", "zip"],
    },
  ],
]);

function printUsage() {
  console.log(`Usage:
  pnpm --filter @pragma/desktop run release:desktop -- --version <version> --platform <platform>
  pnpm --filter @pragma/desktop run release:desktop -- --version <version> --publish

Platforms:
  mac-arm64    Build macOS Apple Silicon DMG and ZIP (run on macOS)
  mac-x64      Build macOS Intel DMG and ZIP (run on macOS)

Options:
  --version <version>       Version without the leading v, for example 0.2.0
  --platform <platform>     Build and stage a platform; may be repeated
  --stage-dir <directory>   Staging directory (default: release-assets/v<version>)
  --publish                  Create the tag and GitHub Release after validating all assets
  --stable                   Publish a stable Release instead of a pre-release
  --notes-file <file>        Release notes file; otherwise GitHub generates notes
  --skip-checks              Skip pnpm check (use only after an explicit local verification)
  --help                     Show this help

Build both macOS architectures, then run the command with --publish from the checkout that
has all four macOS release assets.
`);
}

function parseArguments(argumentsList) {
  const options = {
    help: false,
    notesFile: undefined,
    platforms: [],
    publish: false,
    skipChecks: false,
    stable: false,
    stageDirectory: undefined,
    version: undefined,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--") {
      continue;
    }
    const separatorIndex = argument.indexOf("=");
    const name = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
    let value = separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1);

    const requireValue = () => {
      if (value === undefined) {
        index += 1;
        value = argumentsList[index];
      }
      if (value === undefined || value.length === 0) {
        throw new Error(`${name} requires a value.`);
      }
      return value;
    };

    switch (name) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
        options.version = requireValue();
        break;
      case "--platform":
        options.platforms.push(requireValue());
        break;
      case "--stage-dir":
        options.stageDirectory = requireValue();
        break;
      case "--notes-file":
        options.notesFile = requireValue();
        break;
      case "--publish":
        options.publish = true;
        break;
      case "--stable":
        options.stable = true;
        break;
      case "--skip-checks":
        options.skipChecks = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (options.help) {
    return options;
  }

  if (options.version === undefined) {
    throw new Error("--version is required.");
  }
  if (!versionPattern.test(options.version)) {
    throw new Error(`Invalid version: ${options.version}`);
  }
  if (options.platforms.length === 0 && !options.publish) {
    throw new Error("Provide at least one --platform or use --publish.");
  }
  if (options.stable && !options.publish) {
    throw new Error("--stable only applies when --publish is used.");
  }
  if (options.notesFile !== undefined && !options.publish) {
    throw new Error("--notes-file only applies when --publish is used.");
  }

  options.platforms = [...new Set(options.platforms)];
  for (const platform of options.platforms) {
    if (!platformDefinitions.has(platform)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  return options;
}

function executable(command) {
  return process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
}

function formatCommand(command, argumentsList) {
  return [command, ...argumentsList]
    .map((argument) => (/[\s"]/.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function runCommand(command, argumentsList, cwd) {
  const actualCommand = executable(command);
  console.log(`\n$ ${formatCommand(actualCommand, argumentsList)}`);

  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(actualCommand, argumentsList, {
      cwd,
      shell: false,
      stdio: "inherit",
    });
    let settled = false;

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectCommand(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolveCommand();
        return;
      }
      rejectCommand(
        new Error(
          `${actualCommand} exited with ${signal === null ? `code ${code}` : `signal ${signal}`}.`,
        ),
      );
    });
  });
}

function captureCommand(command, argumentsList, cwd, { allowFailure = false } = {}) {
  const actualCommand = executable(command);

  try {
    const stdout = execFileSync(actualCommand, argumentsList, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: String(stdout) };
  } catch (error) {
    if (!allowFailure) {
      throw error;
    }
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout === undefined ? "" : String(error.stdout),
    };
  }
}

async function readDesktopVersion() {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error(`${packageJsonPath} does not contain a string version.`);
  }
  return packageJson.version;
}

function artifactNamesForPlatform(platform, version) {
  const definition = platformDefinitions.get(platform);
  return definition.artifactExtensions.map(
    (extension) => `Pragma-${version}-${platform}.${extension}`,
  );
}

function allArtifactNames(version) {
  return [...platformDefinitions.keys()].flatMap((platform) =>
    artifactNamesForPlatform(platform, version),
  );
}

async function runQualityChecks(skipChecks, includeBuild) {
  if (skipChecks) {
    console.log("Skipping local quality checks because --skip-checks was provided.");
    return;
  }

  await runCommand("pnpm", ["check"], repositoryDirectory);
  if (includeBuild) {
    await runCommand("pnpm", ["build"], repositoryDirectory);
  }
}

async function buildAndStage(platform, version, stageDirectory) {
  const definition = platformDefinitions.get(platform);
  if (process.platform !== definition.hostPlatform) {
    throw new Error(
      `${platform} must be built on ${definition.hostPlatform}; current platform is ${process.platform}.`,
    );
  }

  await runCommand("pnpm", ["run", definition.script], packageDirectory);
  await mkdir(stageDirectory, { recursive: true });

  for (const artifactName of artifactNamesForPlatform(platform, version)) {
    const sourcePath = join(packageDirectory, "dist", artifactName);
    const sourceStats = await stat(sourcePath).catch(() => undefined);
    if (sourceStats === undefined || !sourceStats.isFile() || sourceStats.size === 0) {
      throw new Error(`Expected non-empty build artifact was not found: ${sourcePath}`);
    }
    const targetPath = join(stageDirectory, artifactName);
    await copyFile(sourcePath, targetPath);
    console.log(`Staged ${targetPath}`);
  }
}

async function inspectStage(stageDirectory, version) {
  await mkdir(stageDirectory, { recursive: true });
  const expectedNames = allArtifactNames(version);
  const allowedNames = new Set([...expectedNames, "SHA256SUMS.txt"]);
  const entries = await readdir(stageDirectory, { withFileTypes: true });
  const entryNames = new Set(entries.map((entry) => entry.name));
  const unexpectedNames = entries
    .filter((entry) => !allowedNames.has(entry.name))
    .map((entry) => entry.name);
  const missingNames = expectedNames.filter((name) => !entryNames.has(name));

  for (const artifactName of expectedNames.filter((name) => entryNames.has(name))) {
    const artifactStats = await stat(join(stageDirectory, artifactName));
    if (!artifactStats.isFile() || artifactStats.size === 0) {
      throw new Error(
        `Release asset must be a non-empty file: ${join(stageDirectory, artifactName)}`,
      );
    }
  }

  if (unexpectedNames.length > 0) {
    throw new Error(
      `Unexpected entries in release staging directory: ${unexpectedNames.join(", ")}`,
    );
  }

  return { expectedNames, missingNames };
}

function hashFile(filePath) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function writeChecksums(stageDirectory, artifactNames) {
  const lines = [];
  for (const artifactName of artifactNames) {
    const digest = await hashFile(join(stageDirectory, artifactName));
    lines.push(`${digest}  ${artifactName}`);
  }
  await writeFile(join(stageDirectory, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${join(stageDirectory, "SHA256SUMS.txt")}`);
}

function assertCleanWorktree() {
  const result = captureCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    repositoryDirectory,
  );
  if (result.stdout.trim().length > 0) {
    throw new Error(
      "The Git worktree has tracked changes. Commit the release changes before using --publish.",
    );
  }
}

function assertTagDoesNotExist(tag) {
  const localTag = captureCommand(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}`],
    repositoryDirectory,
    { allowFailure: true },
  );
  if (localTag.status === 0) {
    throw new Error(`Local tag already exists: ${tag}; published versions are immutable.`);
  }

  const remoteTag = captureCommand(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`],
    repositoryDirectory,
    { allowFailure: true },
  );
  if (remoteTag.status === 0) {
    throw new Error(`Remote tag already exists: ${tag}; published versions are immutable.`);
  }
}

function assertGitHubAuthentication() {
  const result = captureCommand("gh", ["auth", "status"], repositoryDirectory, {
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login` before --publish.");
  }
}

function assertReleaseDoesNotExist(tag) {
  const result = captureCommand(
    "gh",
    ["release", "view", tag, "--json", "isDraft"],
    repositoryDirectory,
    { allowFailure: true },
  );
  if (result.status === 0) {
    throw new Error(`GitHub Release already exists for ${tag}; published versions are immutable.`);
  }
}

async function publishRelease({ artifactNames, notesFile, stable, stageDirectory, version }) {
  const tag = `v${version}`;
  assertCleanWorktree();
  captureCommand("git", ["remote", "get-url", "origin"], repositoryDirectory);
  assertGitHubAuthentication();
  assertTagDoesNotExist(tag);
  assertReleaseDoesNotExist(tag);

  const resolvedNotesFile =
    notesFile === undefined ? undefined : resolve(repositoryDirectory, notesFile);
  if (resolvedNotesFile !== undefined) {
    const notesStats = await stat(resolvedNotesFile).catch(() => undefined);
    if (notesStats === undefined || !notesStats.isFile()) {
      throw new Error(`Release notes file was not found: ${resolvedNotesFile}`);
    }
  }

  await runCommand(
    "git",
    ["tag", "--annotate", tag, "--message", `Pragma ${tag}`],
    repositoryDirectory,
  );
  await runCommand("git", ["push", "origin", tag], repositoryDirectory);

  const releaseArguments = [
    "release",
    "create",
    tag,
    "--verify-tag",
    "--draft",
    "--title",
    `Pragma ${tag}`,
  ];
  if (resolvedNotesFile === undefined) {
    releaseArguments.push("--generate-notes");
  } else {
    releaseArguments.push("--notes-file", resolvedNotesFile);
  }
  if (!stable) {
    releaseArguments.push("--prerelease");
  }
  await runCommand("gh", releaseArguments, repositoryDirectory);

  const assetPaths = [...artifactNames, "SHA256SUMS.txt"].map((name) => join(stageDirectory, name));
  await runCommand(
    "gh",
    ["release", "upload", tag, ...assetPaths, "--clobber"],
    repositoryDirectory,
  );
  await runCommand("gh", ["release", "edit", tag, "--draft=false"], repositoryDirectory);

  const releaseView = captureCommand(
    "gh",
    ["release", "view", tag, "--json", "assets,isDraft,url"],
    repositoryDirectory,
  );
  const release = JSON.parse(releaseView.stdout);
  const uploadedNames = new Set(release.assets.map((asset) => asset.name));
  const missingNames = [...artifactNames, "SHA256SUMS.txt"].filter(
    (name) => !uploadedNames.has(name),
  );
  if (release.isDraft || missingNames.length > 0) {
    throw new Error(
      `Release verification failed. Draft: ${release.isDraft}; missing assets: ${missingNames.join(", ") || "none"}.`,
    );
  }
  console.log(`Published ${release.url}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const desktopVersion = await readDesktopVersion();
  if (desktopVersion !== options.version) {
    throw new Error(
      `Version mismatch: apps/desktop/package.json is ${desktopVersion}, but --version is ${options.version}.`,
    );
  }

  const tag = `v${options.version}`;
  const stageDirectory =
    options.stageDirectory === undefined
      ? join(defaultReleaseDirectory, tag)
      : resolve(repositoryDirectory, options.stageDirectory);

  if (options.platforms.length > 0) {
    await runQualityChecks(options.skipChecks, false);
    for (const platform of options.platforms) {
      await buildAndStage(platform, options.version, stageDirectory);
    }
  } else if (options.publish) {
    await runQualityChecks(options.skipChecks, true);
  }

  const stage = await inspectStage(stageDirectory, options.version);
  if (stage.missingNames.length > 0) {
    if (options.publish) {
      throw new Error(`Cannot publish; missing staged assets: ${stage.missingNames.join(", ")}`);
    }
    console.log(
      `Staged ${stage.expectedNames.length - stage.missingNames.length}/${stage.expectedNames.length} assets. Missing: ${stage.missingNames.join(", ")}`,
    );
    return;
  }

  await writeChecksums(stageDirectory, stage.expectedNames);
  if (!options.publish) {
    console.log(`All release assets are staged in ${stageDirectory}.`);
    return;
  }

  await publishRelease({
    artifactNames: stage.expectedNames,
    notesFile: options.notesFile,
    stable: options.stable,
    stageDirectory,
    version: options.version,
  });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nDesktop release failed: ${message}`);
  process.exitCode = 1;
}
