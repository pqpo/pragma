import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const version = process.env.RELEASE_VERSION;
const tag = process.env.RELEASE_DIST_TAG;
const pack = JSON.parse(await readFile("release-artifact/pack.json", "utf8"))[0];
if (!pack?.integrity || !pack?.shasum) throw new Error("Missing canonical npm integrity evidence");
const deadline = performance.now() + 300_000;
let lastDiagnostic = "No response";
while (performance.now() < deadline) {
  const remaining = deadline - performance.now();
  let response;
  let document;
  try {
    response = await fetch("https://registry.npmjs.org/@pqpo%2fpragma", {
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, Math.floor(remaining)))),
      headers: { "cache-control": "no-cache" },
    });
    if (response.ok) document = await response.json();
  } catch (error) {
    lastDiagnostic = `Registry request failed: ${error.message}`;
  }
  if (response && !response.ok) {
    lastDiagnostic = `Registry HTTP ${response.status}`;
    if (![404, 408, 429].includes(response.status) && response.status < 500)
      throw new Error(lastDiagnostic);
  }
  const metadata = document?.versions?.[version];
  if (metadata) {
    const failures = [];
    if (metadata.name !== "@pqpo/pragma" || metadata.version !== version) failures.push("identity");
    if (metadata.engines?.node !== ">=22") failures.push("engines.node");
    if (JSON.stringify(metadata.os) !== JSON.stringify(["darwin", "win32"])) failures.push("os");
    if (!["./dist/pragma.js", "dist/pragma.js"].includes(metadata.bin?.pragma))
      failures.push("bin.pragma");
    if (metadata.dist?.integrity !== pack.integrity) failures.push("dist.integrity");
    if (metadata.dist?.shasum !== pack.shasum) failures.push("dist.shasum");
    if (failures.length) throw new Error(`Immutable npm metadata mismatch: ${failures.join(", ")}`);
    lastDiagnostic = `Version visible; dist-tag ${tag} points to ${document["dist-tags"]?.[tag]}`;
    if (document["dist-tags"]?.[tag] === version) {
      await writeFile(
        process.env.METADATA_PATH,
        JSON.stringify({ ...metadata, "dist-tags": document["dist-tags"] }, null, 2),
      );
      console.log(`Verified @pqpo/pragma@${version}, dist-tag ${tag}, integrity ${pack.integrity}`);
      process.exit(0);
    }
  } else if (document)
    lastDiagnostic = `@pqpo/pragma@${version} absent; dist-tag ${tag} points to ${document["dist-tags"]?.[tag]}`;
  console.log(lastDiagnostic);
  if (performance.now() < deadline)
    await setTimeout(Math.min(10_000, deadline - performance.now()));
}
throw new Error(
  `Public npm metadata did not converge within 5 minutes. ${lastDiagnostic}. Rerun the failed verification jobs; do not publish again.`,
);
