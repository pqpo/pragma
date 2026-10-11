import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

export function nativeBinaryTarget(bytes) {
  if (bytes.length < 8) return undefined;
  const magic = bytes.readUInt32BE(0);
  function cpu(value) {
    return value === 0x1000007
      ? "x64"
      : value === 0x100000c
        ? "arm64"
        : value === 7
          ? "ia32"
          : `cpu-${value}`;
  }
  if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic))
    return {
      platform: "darwin",
      arches: [
        cpu(
          magic === 0xcffaedfe || magic === 0xcefaedfe
            ? bytes.readUInt32LE(4)
            : bytes.readUInt32BE(4),
        ),
      ],
    };
  if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const read = (offset) => (little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset));
    const count = read(4),
      step = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
    if (count > 32 || bytes.length < 8 + count * step) return undefined;
    return {
      platform: "darwin",
      arches: Array.from({ length: count }, (_, i) => cpu(read(8 + i * step))),
    };
  }
  if (bytes.subarray(0, 4).toString("hex") === "7f454c46" && bytes.length >= 20) {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
    return {
      platform: "linux",
      arches: [
        machine === 62
          ? "x64"
          : machine === 183
            ? "arm64"
            : machine === 3
              ? "ia32"
              : `cpu-${machine}`,
      ],
    };
  }
  if (bytes.subarray(0, 2).toString() === "MZ" && bytes.length >= 64) {
    const offset = bytes.readUInt32LE(60);
    if (
      offset + 6 <= bytes.length &&
      bytes.subarray(offset, offset + 4).toString("hex") === "50450000"
    ) {
      const machine = bytes.readUInt16LE(offset + 4);
      return {
        platform: "win32",
        arches: [
          machine === 0x8664
            ? "x64"
            : machine === 0xaa64
              ? "arm64"
              : machine === 0x14c
                ? "ia32"
                : `cpu-${machine}`,
        ],
      };
    }
  }
  return undefined;
}

export function categorize(path) {
  if (/\.(?:lproj\/.*|pak)$/.test(path) && /(?:locales\/|\.lproj\/)/.test(path)) return "languages";
  if (path.includes("Frameworks/")) return "electron";
  if (/\.(?:node|dylib|dll|exe)$/.test(path) || /\/(?:esbuild|rg)$/.test(path)) return "native";
  if (/^(?:app\.asar(?:\.unpacked)?\/)?node_modules\//.test(path)) return "dependencies";
  if (/\.[cm]?js$/.test(path) && path.includes("out/")) return "application-js";
  return "resources";
}

export function summarizeInventory(inventory, archiveBytes) {
  const logical = inventory.filter(
    (entry) =>
      ["asar", "unpacked-reference", "application"].includes(entry.location) ||
      (entry.location === "resources" &&
        entry.path !== "app.asar" &&
        !entry.path.startsWith("app.asar.unpacked/")),
  );
  const categories = {},
    packages = {},
    extensions = {},
    hashes = new Map();
  for (const entry of logical) {
    const category =
      entry.location === "application" && categorize(entry.path) !== "languages"
        ? "electron"
        : entry.nativeTarget
          ? "native"
          : categorize(entry.path);
    categories[category] = (categories[category] ?? 0) + entry.bytes;
    const match = entry.path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (match) packages[match[1]] = (packages[match[1]] ?? 0) + entry.bytes;
    const extension = extname(entry.path) || "[none]";
    extensions[extension] = (extensions[extension] ?? 0) + entry.bytes;
    if (entry.sha256 && entry.bytes > 0) {
      const group = hashes.get(entry.sha256) ?? [];
      group.push(entry);
      hashes.set(entry.sha256, group);
    }
  }
  categories["asar-metadata"] =
    archiveBytes -
    inventory.filter((entry) => entry.location === "asar").reduce((n, entry) => n + entry.bytes, 0);
  const duplicates = [...hashes.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => ({
      sha256,
      bytes: files[0].bytes,
      redundantBytes: files[0].bytes * (files.length - 1),
      paths: files.map((file) => file.path),
    }))
    .sort((a, b) => b.redundantBytes - a.redundantBytes);
  return {
    categories,
    packages,
    extensions,
    duplicates,
    largestFiles: [...logical].sort((a, b) => b.bytes - a.bytes).slice(0, 30),
  };
}

export async function applicationInventory(applicationRoot, resourcesDirectory) {
  const inventory = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (path === resourcesDirectory || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const file = await open(path, "r");
        let target;
        try {
          const prefix = Buffer.alloc(4096);
          const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
          target = nativeBinaryTarget(prefix.subarray(0, bytesRead));
        } finally {
          await file.close();
        }
        inventory.push({
          path: relative(applicationRoot, path).replaceAll("\\", "/"),
          bytes: (await lstat(path)).size,
          location: "application",
          sha256: await hashFile(path),
          ...(target ? { nativeTarget: target } : {}),
        });
      }
    }
  }
  await walk(applicationRoot);
  return inventory;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function assertSizeBudget(bytes, baseline, label) {
  if (bytes > baseline * 1.05 && bytes - baseline > 5 * 1024 * 1024)
    throw new Error(
      `${label} exceeds size baseline: ${bytes} bytes vs ${baseline}. Update the reviewed size explanation and baseline.`,
    );
}

/** Installers are added after they finish, before package-desktop trims app directories. */
async function recordArtifact(event) {
  if (!event.file || !/\.(?:dmg|zip|exe)$/i.test(event.file)) return;
  const directory = dirname(event.file);
  const name = basename(event.file);
  const match = name.match(/-(mac|win)-(arm64|x64)\.(dmg|zip|exe)$/);
  if (!match) throw new Error(`Unexpected installer identity: ${name}`);
  const platform = match[1] === "mac" ? "darwin" : "win32";
  const arch = match[2] === "x64" ? 1 : 3;
  const reportPath = join(directory, `packaging-audit-${platform}-${arch}.json`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const bytes = (await lstat(event.file)).size;
  const key = `${platform}-${match[2]}-${match[3]}`;
  const budget = JSON.parse(
    await readFile(new URL("../build/size-baselines.json", import.meta.url), "utf8"),
  );
  const baseline = budget.installers[key];
  report.installers ??= {};
  report.installers[name] = {
    bytes,
    sha256: await hashFile(event.file),
    baselineBytes: baseline?.bytes ?? null,
    deltaBytes: baseline ? bytes - baseline.bytes : null,
    baselineStatus: baseline ? "measured" : "awaiting-native-measurement",
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (baseline) assertSizeBudget(bytes, baseline.bytes, name);
}

// DMG and ZIP targets can complete concurrently and update the same report.
const reportUpdates = new Map();
export default async function artifactBuildCompleted(event) {
  if (!event.file) return;
  const directory = dirname(event.file);
  const previous = reportUpdates.get(directory) ?? Promise.resolve();
  const next = previous.then(() => recordArtifact(event));
  reportUpdates.set(directory, next);
  try {
    await next;
  } finally {
    if (reportUpdates.get(directory) === next) reportUpdates.delete(directory);
  }
}
