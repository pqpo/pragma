import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sourceIdentity } from "./build-artifact.mjs";

const archivePath = fileURLToPath(
  new URL("../.test-results/workspace-build.tar.gz", import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL("../.test-results/workspace-build.json", import.meta.url),
);
const archiveDigest = async () =>
  createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");

export async function recordWorkspaceArchive() {
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      ...(await sourceIdentity()),
      sha256: await archiveDigest(),
    }) + "\n",
  );
}

export async function verifyWorkspaceArchive() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const current = await sourceIdentity();
  if (
    manifest.schemaVersion !== 1 ||
    manifest.commit !== current.commit ||
    manifest.sourceHash !== current.sourceHash
  )
    throw new Error("Stale workspace archive; prepare the current source first.");
  if (manifest.sha256 !== (await archiveDigest()))
    throw new Error("Workspace archive digest mismatch");
}
