import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function recordSizeBaseline(
  reportPath,
  baselinePath = fileURLToPath(new URL("../build/size-baselines.json", import.meta.url)),
) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    report.failures.length ||
    report.validation?.cli !== "passed" ||
    Object.values(report.validation?.resources ?? {}).length === 0 ||
    Object.values(report.validation.resources).some((status) => status !== "passed")
  )
    throw new Error(
      "Only audited installers with successful packaged resource smoke can become a size baseline.",
    );
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  if (!Object.keys(report.installers ?? {}).length)
    throw new Error("Report contains no completed installers.");
  for (const [name, artifact] of Object.entries(report.installers)) {
    const match = name.match(/-(mac|win)-(x64|arm64)\.(dmg|zip|exe)$/);
    if (!match || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0)
      throw new Error(`Invalid installer: ${name}`);
    const platform = match[1] === "mac" ? "darwin" : "win32";
    if (platform !== report.identity.platform || match[2] !== report.identity.arch)
      throw new Error(`Installer identity mismatch: ${name}`);
    baseline.installers[`${platform}-${match[2]}-${match[3]}`] = {
      bytes: artifact.bytes,
      explanation:
        "Measured native installer after packaging size optimization; full Runtime execution and visual release validation are tracked separately.",
      identity: report.identity,
    };
  }
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2])
    throw new Error("Usage: node record-size-baseline.mjs <packaging-audit.json>");
  await recordSizeBaseline(process.argv[2]);
}
