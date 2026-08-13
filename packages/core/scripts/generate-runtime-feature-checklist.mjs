import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const catalogPath = resolve(repositoryRoot, "packages/core/src/runtime/features.ts");
const checklistPath = resolve(
  repositoryRoot,
  "docs/conventions/runtime-adapter-integration-checklist.md",
);
const startMarker = "<!-- RUNTIME_FEATURE_CATALOG_GENERATED_START -->";
const endMarker = "<!-- RUNTIME_FEATURE_CATALOG_GENERATED_END -->";

const [catalogSource, checklistSource] = await Promise.all([
  readFile(catalogPath, "utf8"),
  readFile(checklistPath, "utf8"),
]);
const catalog = readCatalog(catalogSource);
const generated = renderCatalog(catalog);
const nextChecklist = replaceGeneratedSection(checklistSource, generated);

if (process.argv.includes("--check")) {
  if (nextChecklist !== checklistSource) {
    process.stderr.write(
      "Runtime feature checklist is stale. Run `pnpm runtime:features:generate` and commit the result.\n",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(checklistPath, nextChecklist, "utf8");
  process.stdout.write(`Updated ${checklistPath}\n`);
}

function readCatalog(source) {
  const block = source.match(
    /\/\/ RUNTIME_FEATURE_CATALOG_START([\s\S]*?)\/\/ RUNTIME_FEATURE_CATALOG_END/,
  )?.[1];
  if (block === undefined) {
    throw new Error(`Runtime feature catalog markers were not found in ${catalogPath}.`);
  }
  const entries = [
    ...block.matchAll(
      /\{\s*"?name"?\s*:\s*"([^"]+)"\s*,\s*"?lifecycle"?\s*:\s*"([^"]+)"\s*,\s*"?description"?\s*:\s*"([^"]+)"\s*,?\s*\}/g,
    ),
  ].map((match) => ({
    name: match[1],
    lifecycle: match[2],
    description: match[3],
  }));
  if (entries.length === 0) {
    throw new Error(`No Runtime features could be parsed from ${catalogPath}.`);
  }
  const names = new Set(entries.map(({ name }) => name));
  if (names.size !== entries.length) {
    throw new Error("Runtime feature catalog contains duplicate names.");
  }
  return entries;
}

function renderCatalog(catalog) {
  const lifecycleLabels = {
    driver: "Driver 注册/探测",
    session: "Session 准备/清理",
    turn: "Turn 准备/清理",
  };
  const rows = catalog.map(
    ({ name, lifecycle, description }) =>
      `| \`${name}\` | ${lifecycleLabels[lifecycle] ?? lifecycle} | ${description} |`,
  );
  return [
    startMarker,
    "",
    "## 可执行特性目录（自动生成）",
    "",
    "下表直接由 `packages/core/src/runtime/features.ts` 的权威目录生成。新增、删除或重排特性后，",
    "`pnpm runtime:features:check` 会在文档未同步时失败。每个 Runtime 必须为每一行声明",
    "`runtimeFeature.native(readiness)`、`runtimeFeature.session({ readiness, prepare })` 或",
    "`runtimeFeature.turn({ readiness, prepare })`。启用的 lifecycle Feature 必须是后两种实现对象；",
    "`readiness` 只能说明证据与限制，不能代替 `prepare()`。私有装配节点使用 `runtimeStep` 并通过 typed",
    "`needs` 连接，不能把 Harness 内部目录、relay 或 tool assembly 塞进公开 catalog。",
    "",
    "<!-- prettier-ignore -->",
    "| Feature slot | Core 生命周期阶段 | 验收结果 |",
    "| --- | --- | --- |",
    ...rows,
    "",
    endMarker,
  ].join("\n");
}

function replaceGeneratedSection(source, generated) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error(
      `Generated Runtime feature section markers were not found in ${checklistPath}.`,
    );
  }
  return `${source.slice(0, start)}${generated}${source.slice(end + endMarker.length)}`;
}
