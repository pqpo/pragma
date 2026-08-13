import fs from "node:fs";
import path from "node:path";

import postcss from "postcss";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const rendererRoot = path.join(desktopRoot, "src/renderer/src");
const stylesRoot = path.join(rendererRoot, "styles");
const indexPath = path.join(stylesRoot, "index.css");
const formerEntryPath = path.join(rendererRoot, "styles.css");
const maximumOwnedStylesheetLines = 3_000;

function fail(message) {
  throw new Error(`Renderer stylesheet verification failed: ${message}`);
}

function cssFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...cssFiles(target));
    else if (entry.name.endsWith(".css")) result.push(target);
  }
  return result.sort();
}

if (fs.existsSync(formerEntryPath)) {
  fail("the former monolithic styles.css entry still exists");
}

const indexSource = fs.readFileSync(indexPath, "utf8");
const indexRoot = postcss.parse(indexSource, { from: indexPath });
if (indexRoot.nodes.some((node) => node.type !== "atrule" || node.name !== "import")) {
  fail("styles/index.css must contain imports only");
}

const imports = indexRoot.nodes.map((node) => node.params.replace(/^['"]|['"]$/gu, ""));
if (imports[0] !== "@xyflow/react/dist/style.css") {
  fail("the React Flow base stylesheet must be imported before application styles");
}

const localImports = imports.filter((value) => value.startsWith("./"));
if (new Set(localImports).size !== localImports.length) {
  fail("styles/index.css contains duplicate imports");
}

const ownedFiles = cssFiles(stylesRoot).filter((file) => file !== indexPath);
const importedFiles = localImports.map((value) => path.resolve(stylesRoot, value)).sort();
if (JSON.stringify(importedFiles) !== JSON.stringify(ownedFiles)) {
  fail("every owned stylesheet must be imported exactly once by styles/index.css");
}

const selectorOwners = new Map();
let ruleCount = 0;
let declarationCount = 0;

for (const file of ownedFiles) {
  const source = fs.readFileSync(file, "utf8");
  const lineCount = source.split("\n").length;
  if (lineCount > maximumOwnedStylesheetLines) {
    fail(
      `${path.relative(desktopRoot, file)} has ${lineCount} lines; limit is ${maximumOwnedStylesheetLines}`,
    );
  }
  if (/^\s*@import\b/mu.test(source)) {
    fail(`${path.relative(desktopRoot, file)} must not import another stylesheet`);
  }

  const root = postcss.parse(source, { from: file });
  root.walkDecls(() => declarationCount++);
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/u.test(rule.parent.name)) return;
    ruleCount++;
    const contexts = [];
    for (let parent = rule.parent; parent?.type !== "root"; parent = parent?.parent) {
      if (parent?.type === "atrule") contexts.unshift(`@${parent.name} ${parent.params}`);
    }
    const selector = rule.selector.replace(/\s+/gu, " ").trim();
    const key = `${contexts.join("|")}|${selector}`;
    const owner = selectorOwners.get(key);
    if (owner !== undefined && owner !== file) {
      fail(
        `selector ${JSON.stringify(selector)} is owned by both ${path.relative(desktopRoot, owner)} and ${path.relative(desktopRoot, file)}`,
      );
    }
    selectorOwners.set(key, file);
  });
}

const rendererCssImports = [];
for (const file of cssImportingSourceFiles(rendererRoot)) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/import\s+["']([^"']+\.css)["'];/gu)) {
    rendererCssImports.push({ file, specifier: match[1] });
  }
}
if (
  rendererCssImports.length !== 1 ||
  path.relative(rendererRoot, rendererCssImports[0].file) !== "main.tsx" ||
  rendererCssImports[0].specifier !== "./styles/index.css"
) {
  fail("main.tsx must be the only renderer source importing CSS, through ./styles/index.css");
}

console.log(
  `Renderer styles verified: ${ownedFiles.length} files, ${ruleCount} rules, ${declarationCount} declarations, no cross-file selector ownership conflicts.`,
);

function cssImportingSourceFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...cssImportingSourceFiles(target));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) result.push(target);
  }
  return result;
}
