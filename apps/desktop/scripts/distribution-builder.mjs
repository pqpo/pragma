import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadDistribution } from "../../../scripts/distribution.mjs";

export async function prepareDistributionBuilder(profile = undefined) {
  profile ??= await loadDistribution();
  const directory = fileURLToPath(new URL("../.packaging/", import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL("../.packaging/distribution.json", import.meta.url),
    JSON.stringify(profile, null, 2) + "\n",
  );
  const builder = createDistributionBuilderConfig(profile);
  const path = fileURLToPath(new URL("../.packaging/electron-builder.json", import.meta.url));
  await writeFile(path, JSON.stringify(builder, null, 2) + "\n");
  return path;
}

export function createDistributionBuilderConfig({ config, windowsUninstallGuid }) {
  return {
    extends: fileURLToPath(new URL("../electron-builder.yml", import.meta.url)),
    appId: config.applicationId,
    productName: config.productName,
    executableName: config.executableName,
    extraMetadata: {
      name: config.id === "pragma" ? "@pragma/desktop" : `${config.id}-desktop`,
      productName: config.productName,
      ...(config.desktopVersion ? { version: config.desktopVersion } : {}),
    },
    mac: { artifactName: `${config.productName}-\${version}-mac-\${arch}.\${ext}` },
    win: { artifactName: `${config.productName}-\${version}-win-\${arch}.\${ext}` },
    nsis: { guid: windowsUninstallGuid, shortcutName: config.productName },
  };
}
