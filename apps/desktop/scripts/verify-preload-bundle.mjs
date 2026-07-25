import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";

const preloadPath = new URL("../out/preload/index.mjs", import.meta.url);
const source = await readFile(preloadPath, "utf8");
const externalSpecifiers = new Set();
const importPatterns = [
  /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
];

for (const pattern of importPatterns) {
  for (const match of source.matchAll(pattern)) {
    externalSpecifiers.add(match[1]);
  }
}

const nodeBuiltIns = new Set(builtinModules);
const unexpectedSpecifiers = [...externalSpecifiers].filter(
  (specifier) =>
    specifier !== "electron" &&
    !specifier.startsWith("electron/") &&
    !specifier.startsWith("node:") &&
    !nodeBuiltIns.has(specifier),
);

if (unexpectedSpecifiers.length > 0) {
  throw new Error(
    `Desktop preload must be self-contained. Unexpected external imports: ${unexpectedSpecifiers.join(", ")}.`,
  );
}

if (!/contextBridge\.exposeInMainWorld\(["']pragmaDesktop["']/u.test(source)) {
  throw new Error("Desktop preload does not expose the pragmaDesktop bridge.");
}

console.log("Desktop preload bundle is self-contained and exposes pragmaDesktop.");
