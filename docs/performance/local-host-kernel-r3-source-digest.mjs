import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// Stable source identity for the selected checkout; generated files, tests,
// fixtures and dependencies are excluded. Run before and after serial probes.
const checkout = resolve(process.argv[2] ?? process.cwd());
const ignored = new Set([
  "node_modules",
  "dist",
  "out",
  "test",
  "tests",
  "testing",
  "fixtures",
  ".git",
  ".turbo",
]);
const files = [];
async function collect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (ignored.has(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs|json)$/.test(entry.name))
      files.push(absolute);
  }
}
for (const root of ["apps/desktop/src", "apps/cli/src", "packages"])
  await collect(join(checkout, root));
const digest = createHash("sha256");
for (const file of files.sort()) {
  digest.update(relative(checkout, file).split("\\").join("/") + "\0");
  digest.update(
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex") + "\n",
  );
}
process.stdout.write(
  JSON.stringify(
    {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: checkout,
        encoding: "utf8",
      }).trim(),
      fileCount: files.length,
      sha256: digest.digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
