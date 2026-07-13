import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const scannedRoots = ["apps", "packages", "plugins", "examples", "docs"];
const scannedRootFiles = ["AGENTS.md", "README.md", "README.zh-CN.md", "design-qa.md"];
const textExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".md", ".json", ".mjs"]);

const legacyTokens = [
  ["ExpertAgent", ".create"].join(""),
  ["define", "Agent"].join(""),
  ["Workflow", "Run"].join(""),
  ["Root", "Workflow", "Run"].join(""),
  ["Child", "Workflow", "Run"].join(""),
  ["workflow", "RunId"].join(""),
  ["rootWorkflow", "RunId"].join(""),
  ["parentWorkflow", "RunId"].join(""),
  ["task", "RunId"].join(""),
];
const legacyExecutionSourceTokens = [
  ["append", "Output("].join(""),
  ["Execution", "OutputEvent"].join(""),
  ["execution", "Outputs("].join(""),
];

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".next", ".turbo", "coverage"].includes(entry.name)) {
        continue;
      }
      files.push(...(await listFiles(path)));
    } else if (textExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

describe("legacy execution API guard", () => {
  it("keeps removed APIs, runtime names, and source paths out of the repository", async () => {
    const files = [
      ...(
        await Promise.all(scannedRoots.map((root) => listFiles(resolve(repositoryRoot, root))))
      ).flat(),
      ...scannedRootFiles.map((file) => resolve(repositoryRoot, file)),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const repositoryPath = relative(repositoryRoot, file).replaceAll("\\", "/");
      const pathSegments = repositoryPath.toLowerCase().split("/");
      if (pathSegments.some((segment) => /^(workflow|directive)(\.|$)/u.test(segment))) {
        violations.push(`${repositoryPath}: legacy path`);
      }

      const content = await readFile(file, "utf8");
      for (const token of legacyTokens) {
        if (content.includes(token)) {
          violations.push(`${repositoryPath}: ${token}`);
        }
      }
      if (
        repositoryPath.startsWith("packages/") ||
        repositoryPath.startsWith("apps/") ||
        repositoryPath.startsWith("plugins/") ||
        repositoryPath.startsWith("examples/")
      ) {
        for (const token of legacyExecutionSourceTokens) {
          if (content.includes(token)) violations.push(`${repositoryPath}: ${token}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
