import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

// Build tools use the authoritative Shared schema even before workspace dist exists.
const { DistributionConfigSchema, DEFAULT_DISTRIBUTION } = await tsImport(
  "../packages/shared/src/distribution.ts",
  import.meta.url,
);
export async function loadDistribution(env = process.env) {
  const path = env.PRAGMA_DISTRIBUTION_CONFIG;
  const config = DistributionConfigSchema.parse(
    path ? JSON.parse(await readFile(resolve(path), "utf8")) : DEFAULT_DISTRIBUTION,
  );
  if (config.id !== DEFAULT_DISTRIBUTION.id) {
    for (const key of [
      "productName",
      "applicationId",
      "applicationName",
      "executableName",
      "homeDirectory",
      "developmentHomeDirectory",
      "userDataDirectory",
      "userDataDevelopmentDirectory",
      "homeEnvironmentVariable",
      "credentialNamespace",
      "cliPackageName",
      "cliCommand",
      "desktopCliCommand",
    ]) {
      if (config[key].toLowerCase() === DEFAULT_DISTRIBUTION[key].toLowerCase())
        throw new Error(`Derived distribution must use its own ${key}.`);
    }
    for (const keys of [
      ["homeDirectory", "developmentHomeDirectory"],
      ["userDataDirectory", "userDataDevelopmentDirectory"],
    ]) {
      const reserved = keys.map((key) => DEFAULT_DISTRIBUTION[key].toLowerCase());
      if (keys.some((key) => reserved.includes(config[key].toLowerCase())))
        throw new Error("Derived directories must not overlap any Pragma directory.");
    }
    if (
      [config.cliCommand, config.desktopCliCommand].some((name) =>
        ["pragma", "pragma-desktop"].includes(name),
      )
    )
      throw new Error("Derived commands must not claim Pragma commands.");
  } else {
    for (const [key, value] of Object.entries(DEFAULT_DISTRIBUTION)) {
      if (config[key] !== value)
        throw new Error(
          `The pragma identity must retain its default ${key}; choose another id for a derived distribution.`,
        );
    }
  }
  const digest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  // Match electron-builder's default NSIS UUID v5; explicit in generated config too.
  const namespace = Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex");
  const bytes = createHash("sha1")
    .update(namespace)
    .update(config.applicationId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  const windowsUninstallGuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return Object.freeze({ config: Object.freeze(config), digest, windowsUninstallGuid });
}
export function distributionBanner(config) {
  return `if (globalThis.__PRAGMA_DISTRIBUTION__ !== undefined) { if (JSON.stringify(globalThis.__PRAGMA_DISTRIBUTION__) !== ${JSON.stringify(JSON.stringify(config))}) throw new Error("Conflicting distribution identities in one process."); } else Object.defineProperty(globalThis, "__PRAGMA_DISTRIBUTION__", {value: Object.freeze(${JSON.stringify(config)}), configurable: false, writable: false});`;
}
export async function assertDesktopDistribution(directory, profile = undefined) {
  profile ??= await loadDistribution();
  for (const relative of ["distribution.json", "desktop-cli/distribution.json"]) {
    const metadata = JSON.parse(await readFile(resolve(directory, relative), "utf8"));
    if (
      metadata.distributionId !== profile.config.id ||
      metadata.distributionDigest !== profile.digest
    ) {
      throw new Error(`Desktop distribution mismatch in ${relative}; rebuild first.`);
    }
  }
}

export async function assertOpenSourceDistribution() {
  const { config } = await loadDistribution();
  if (
    config.id !== "pragma" ||
    config.desktopVersion !== undefined ||
    config.cliVersion !== undefined
  )
    throw new Error(
      "Open-source publication requires the default Pragma distribution and package versions.",
    );
}
if (process.argv[2] === "--assert-open-source") await assertOpenSourceDistribution();
