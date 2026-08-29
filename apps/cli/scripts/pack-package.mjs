import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const releaseDirectory = join(packageDirectory, ".release");
const stagingDirectory = join(releaseDirectory, "package");
const buildScript = join(scriptDirectory, "build-package.mjs");
const auditScript = join(scriptDirectory, "package-audit.mjs");

await run(process.execPath, [buildScript], packageDirectory);

const dryRun = await run(
  "npm",
  ["pack", "--json", "--dry-run", "--ignore-scripts"],
  stagingDirectory,
);
const dryRunReport = parseNpmJson(dryRun.stdout, "npm pack --dry-run");
await writeFile(
  join(releaseDirectory, "pack-dry-run.json"),
  `${JSON.stringify(dryRunReport, null, 2)}\n`,
  "utf8",
);

const actualPack = await run(
  "npm",
  ["pack", "--json", "--ignore-scripts", "--pack-destination", releaseDirectory],
  stagingDirectory,
);
const actualReport = parseNpmJson(actualPack.stdout, "npm pack");
const filename = actualReport[0]?.filename;
if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename.");
const tarballPath = resolve(releaseDirectory, filename);
await run(process.execPath, [auditScript, tarballPath], packageDirectory);
await writeFile(
  join(releaseDirectory, "pack.json"),
  `${JSON.stringify(actualReport, null, 2)}\n`,
  "utf8",
);

console.log(`Packed and audited ${tarballPath}.`);

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}.\n${stderr || stdout}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function parseNpmJson(stdout, command) {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty JSON result");
    return parsed;
  } catch (error) {
    throw new Error(
      `${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}`,
    );
  }
}
