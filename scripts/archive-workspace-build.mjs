import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
const packages = JSON.parse(
  execFileSync("pnpm", ["list", "-r", "--depth=-1", "--json"], { encoding: "utf8" }),
);
const paths = new Set();
for (const pkg of packages) {
  if (pkg.name === "@pragma/desktop") continue;
  const dist = resolve(pkg.path, "dist");
  if (existsSync(dist)) paths.add(relative(process.cwd(), dist));
}
for (const path of [
  "apps/cli/.release",
  "apps/desktop/out",
  "apps/desktop/.plugin-bundles",
  "apps/desktop/.packaging/cli-metafiles.json",
  "apps/desktop/.packaging/prepared.json",
]) {
  if (!existsSync(path)) throw new Error(`Missing prepared workspace output: ${path}`);
  paths.add(path);
}
execFileSync("tar", ["-czf", ".test-results/workspace-build.tar.gz", ...paths], {
  stdio: "inherit",
});
