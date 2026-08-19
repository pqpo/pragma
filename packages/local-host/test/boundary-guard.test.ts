import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

function lintStdin(source: string, filename: string): string {
  try {
    execFileSync("pnpm", ["exec", "eslint", "--stdin", "--stdin-filename", filename], {
      cwd: workspaceRoot,
      encoding: "utf8",
      input: source,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "";
  } catch (error) {
    const failure = error as { readonly stderr?: string; readonly stdout?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
}

describe("Local Host boundary guards", () => {
  it("rejects a concrete Runtime import from Local Host", () => {
    expect(
      lintStdin('import "@pragma/runtime-codex";\n', "packages/local-host/src/illegal.ts"),
    ).toContain("Local Host is a Node application layer");
  });

  it("keeps the local-host manifest free of forbidden application dependencies", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly dependencies?: Readonly<Record<string, string>> };
    const dependencies = Object.keys(manifest.dependencies ?? {});

    expect(
      dependencies.some((name) => name === "electron" || name.startsWith("@pragma/runtime-")),
    ).toBe(false);
  });
});
