import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
export async function sourceIdentity() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256").update(commit).update(diff);
  for (const name of untracked) hash.update(name).update(await readFile(resolve(root, name)));
  return { commit, sourceHash: hash.digest("hex") };
}
const roots = {
  desktop: [
    "apps/desktop/out",
    "apps/desktop/.plugin-bundles",
    "apps/desktop/.packaging/cli-metafiles.json",
  ],
  cli: [
    "apps/cli/dist",
    "apps/cli/.release/package",
    ...[
      "cli",
      "code-service-worker",
      "canonical-event-feed-worker",
      "vector-worker",
      "claude-acp-worker",
      "sqlite-execution-worker",
    ].map((name) => `apps/cli/.release/${name}.metafile.json`),
  ],
};
const manifestPath = (kind) =>
  resolve(
    root,
    kind === "desktop"
      ? "apps/desktop/.packaging/prepared.json"
      : "apps/cli/.release/prepared.json",
  );
async function filesAt(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => filesAt(resolve(path, entry.name))))).flat();
  } catch (error) {
    if (error.code === "ENOTDIR") return [path];
    throw error;
  }
}
export async function recordArtifact(kind) {
  if (!Object.hasOwn(roots, kind)) throw new Error("Unknown artifact kind");
  const files = {};
  for (const entry of roots[kind])
    for (const path of await filesAt(resolve(root, entry)))
      files[relative(root, path).replaceAll("\\", "/")] = sha(await readFile(path));
  const versions = await Promise.all(
    ["apps/desktop/package.json", "apps/cli/package.json"].map(
      async (p) => JSON.parse(await readFile(resolve(root, p), "utf8")).version,
    ),
  );
  const manifest = {
    schemaVersion: 1,
    kind,
    ...(await sourceIdentity()),
    desktopVersion: versions[0],
    cliVersion: versions[1],
    files,
  };
  await mkdir(dirname(manifestPath(kind)), { recursive: true });
  await writeFile(manifestPath(kind), JSON.stringify(manifest, null, 2) + "\n");
}
export async function verifyArtifact(kind) {
  if (!Object.hasOwn(roots, kind)) throw new Error("Unknown artifact kind");
  const manifest = JSON.parse(await readFile(manifestPath(kind), "utf8"));
  const current = await sourceIdentity();
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== kind ||
    manifest.commit !== current.commit ||
    manifest.sourceHash !== current.sourceHash
  )
    throw new Error(`Stale ${kind} artifact; prepare the current source first.`);
  const desktopVersion = JSON.parse(
    await readFile(resolve(root, "apps/desktop/package.json"), "utf8"),
  ).version;
  const cliVersion = JSON.parse(
    await readFile(resolve(root, "apps/cli/package.json"), "utf8"),
  ).version;
  if (manifest.desktopVersion !== desktopVersion || manifest.cliVersion !== cliVersion)
    throw new Error("Prepared artifact version mismatch");
  // GitHub's file artifact format omits empty directories. Restore only a
  // directory whose producer manifest declares no plugin files.
  if (
    kind === "desktop" &&
    !Object.keys(manifest.files).some((name) => name.startsWith("apps/desktop/.plugin-bundles/"))
  ) {
    await mkdir(resolve(root, "apps/desktop/.plugin-bundles/plugins"), { recursive: true });
  }
  const paths = [];
  for (const entry of roots[kind]) paths.push(...(await filesAt(resolve(root, entry))));
  if (paths.length !== Object.keys(manifest.files).length)
    throw new Error(`Incomplete ${kind} artifact manifest`);
  for (const path of paths) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (manifest.files[name] !== sha(await readFile(path)))
      throw new Error(`Artifact digest mismatch: ${name}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, kind] = process.argv.slice(2);
  if (operation === "create") await recordArtifact(kind);
  else if (operation === "verify") await verifyArtifact(kind);
  else throw new Error("Usage: build-artifact.mjs create|verify desktop|cli");
}
