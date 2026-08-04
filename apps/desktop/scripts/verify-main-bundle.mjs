import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const mainOutputDirectory = fileURLToPath(new URL("../out/main/", import.meta.url));
const javascriptExtensions = new Set([".cjs", ".js", ".mjs"]);

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectJavaScriptFiles(path);
      }
      return javascriptExtensions.has(extname(entry.name)) ? [path] : [];
    }),
  );

  return files.flat();
}

function findExternalWorkspaceImports(source) {
  const specifiers = new Set();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:[^"'()\n;]*?\s+from\s+)?["'](@pragma\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](@pragma\/[^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }

  return [...specifiers];
}

const failures = [];
for (const file of await collectJavaScriptFiles(mainOutputDirectory)) {
  const source = await readFile(file, "utf8");
  const specifiers = findExternalWorkspaceImports(source);
  if (specifiers.length > 0) {
    failures.push({ file: relative(mainOutputDirectory, file), specifiers });
  }
}

if (failures.length > 0) {
  const details = failures
    .map(({ file, specifiers }) => `- ${file}: ${specifiers.join(", ")}`)
    .join("\n");
  throw new Error(
    `Desktop main bundle must compile workspace TypeScript instead of loading it at runtime. External @pragma imports:\n${details}`,
  );
}

console.log("Desktop main bundle contains no external @pragma imports.");
