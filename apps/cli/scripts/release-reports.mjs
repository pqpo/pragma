import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const releaseDirectory = join(packageDirectory, ".release");
const stagingDirectory = join(releaseDirectory, "package");
const reportDirectory = join(releaseDirectory, "reports");
const artifactDirectory = join(releaseDirectory, "ci-artifact");

const packageManifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
const packReport = await readJson(join(releaseDirectory, "pack.json"));
const packRecord = packReport[0];
if (packRecord === undefined || typeof packRecord.filename !== "string") {
  throw new Error(".release/pack.json does not contain an npm pack result.");
}

const tarballPath = resolve(releaseDirectory, packRecord.filename);
const tarball = await readFile(tarballPath);
const sha256 = createHash("sha256").update(tarball).digest("hex");
const cliBundle = await readFile(join(stagingDirectory, "dist", "cli.js"));
const cliSha256 = createHash("sha256").update(cliBundle).digest("hex");
const commit = await readGitCommit();
const metafiles = await Promise.all(
  ["cli.metafile.json", "code-service-worker.metafile.json"].map(
    async (filename) => await readJson(join(releaseDirectory, filename)),
  ),
);

await rm(reportDirectory, { recursive: true, force: true });
await rm(artifactDirectory, { recursive: true, force: true });
await mkdir(reportDirectory, { recursive: true });
await mkdir(artifactDirectory, { recursive: true });

const components = await collectComponents(packageManifest, metafiles);
const sbom = createSbom(packageManifest, components);
const licenseReport = createLicenseReport(packageManifest, components);
const packFiles = (packRecord.files ?? []).map((file) => ({
  path: file.path,
  size: file.size,
  mode: file.mode,
}));
const artifactManifest = {
  package: packageManifest.name,
  version: packageManifest.version,
  buildIdentity: {
    version: packageManifest.version,
    commit,
    cliSha256,
  },
  tarball: "pragma-cli.tgz",
  sha256,
  tarballBytes: tarball.byteLength,
  unpackedBytes: packRecord.unpackedSize,
  files: packFiles.map((file) => file.path),
};

await writeReport("sbom.cdx.json", `${JSON.stringify(sbom, null, 2)}\n`);
await writeReport("license-report.txt", licenseReport);
await writeReport("pack-files.json", `${JSON.stringify(packFiles, null, 2)}\n`);
await writeReport("artifact-manifest.json", `${JSON.stringify(artifactManifest, null, 2)}\n`);
await writeReport("SHA256SUMS.txt", `${sha256}  pragma-cli.tgz\n`);
await copyFile(tarballPath, join(artifactDirectory, "pragma-cli.tgz"));
await copyFile(join(releaseDirectory, "pack.json"), join(artifactDirectory, "pack.json"));
await copyFile(join(reportDirectory, "sbom.cdx.json"), join(artifactDirectory, "sbom.cdx.json"));
await copyFile(
  join(reportDirectory, "license-report.txt"),
  join(artifactDirectory, "license-report.txt"),
);
await copyFile(
  join(reportDirectory, "pack-files.json"),
  join(artifactDirectory, "pack-files.json"),
);
await copyFile(
  join(reportDirectory, "artifact-manifest.json"),
  join(artifactDirectory, "artifact-manifest.json"),
);
await copyFile(join(reportDirectory, "SHA256SUMS.txt"), join(artifactDirectory, "SHA256SUMS.txt"));

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      package: packageManifest.name,
      version: packageManifest.version,
      tarball: tarballPath,
      sha256,
      tarballBytes: tarball.byteLength,
      sbom: join(reportDirectory, "sbom.cdx.json"),
      licenseReport: join(reportDirectory, "license-report.txt"),
      artifactDirectory,
    },
    null,
    2,
  ) + "\n",
);

async function readGitCommit() {
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`Unable to determine a full git commit for the CLI artifact: ${commit}`);
  }
  return commit;
}

async function collectComponents(rootManifest, metafiles) {
  const manifests = new Map();
  await addManifest(manifests, join(stagingDirectory, "package.json"));

  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs ?? {})) {
      const manifestPath = await findNearestPackageJson(resolve(repositoryDirectory, input));
      if (manifestPath !== undefined) await addManifest(manifests, manifestPath);
    }
  }

  for (const dependencyName of Object.keys(rootManifest.dependencies ?? {})) {
    const dependencyPath = await findInstalledPackageJson(dependencyName);
    if (dependencyPath !== undefined) await addManifest(manifests, dependencyPath);
  }

  return [...manifests.values()]
    .map((manifest) => toComponent(manifest))
    .sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));
}

async function addManifest(manifests, manifestPath) {
  const manifest = await readJson(resolve(manifestPath));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;
  const key = `${manifest.name}@${manifest.version}`;
  if (manifests.has(key)) return;
  manifests.set(key, manifest);
}

async function findNearestPackageJson(inputPath) {
  let current = inputPath;
  try {
    if ((await stat(current)).isFile()) current = dirname(current);
  } catch {
    current = dirname(current);
  }

  while (isWithinRepository(current)) {
    const candidate = join(current, "package.json");
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Continue walking towards the repository root.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function findInstalledPackageJson(packageName) {
  const candidate = join(
    packageDirectory,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  try {
    await stat(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

function isWithinRepository(path) {
  const relativePath = relative(repositoryDirectory, path);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

function toComponent(manifest) {
  const name = manifest.name;
  const version = manifest.version;
  const bomRef = npmPurl(name, version);
  return {
    type: "library",
    name,
    version,
    "bom-ref": bomRef,
    scope: "required",
    purl: bomRef,
    licenses: normalizeLicenses(manifest),
  };
}

function npmPurl(name, version) {
  if (name.startsWith("@")) {
    const separator = name.indexOf("/");
    if (separator > 1 && separator < name.length - 1) {
      const namespace = name.slice(0, separator);
      const packageName = name.slice(separator + 1);
      return `pkg:npm/${encodeURIComponent(namespace)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
    }
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function normalizeLicenses(manifest) {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === "string" && value.length > 0) {
    return [{ license: { name: value } }];
  }
  if (Array.isArray(value) && value.length > 0) {
    return value.map((license) => {
      if (typeof license === "string") return { license: { name: license } };
      if (license && typeof license === "object") {
        const name = license.type ?? license.name ?? "NOASSERTION";
        return { license: { name: String(name) } };
      }
      return { license: { name: "NOASSERTION" } };
    });
  }
  return [{ license: { name: "NOASSERTION" } }];
}

function createSbom(manifest, components) {
  const root = toComponent(manifest);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "Pragma", name: "cli release reports", version: "1" }],
      component: root,
    },
    components: components.filter((component) => component["bom-ref"] !== root["bom-ref"]),
    dependencies: [
      {
        ref: root["bom-ref"],
        dependsOn: components
          .filter((component) => component["bom-ref"] !== root["bom-ref"])
          .map((component) => component["bom-ref"]),
      },
    ],
  };
}

function createLicenseReport(manifest, components) {
  const lines = [
    `Package: ${manifest.name}@${manifest.version}`,
    "Generated from the package manifest and esbuild metafiles.",
    "",
  ];
  for (const component of [
    toComponent(manifest),
    ...components.filter((item) => item.name !== manifest.name),
  ]) {
    const licenses = (component.licenses ?? [])
      .map((entry) => entry.license?.name ?? "NOASSERTION")
      .join(", ");
    lines.push(`${component.name}@${component.version}\t${licenses || "NOASSERTION"}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeReport(filename, content) {
  await writeFile(join(reportDirectory, filename), content, "utf8");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read JSON ${path}: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error },
    );
  }
}
