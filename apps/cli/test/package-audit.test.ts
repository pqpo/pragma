import { describe, expect, it } from "vitest";

import {
  assertNoBuildPathLeaks,
  assertNoExternalWorkspaceImports,
  assertSafeText,
  findBuildPathLeaks,
  findExternalWorkspaceImports,
  findSecretPatterns,
} from "../scripts/package-audit-lib.mjs";

describe("CLI package audit canaries", () => {
  it("rejects external workspace imports", () => {
    expect(findExternalWorkspaceImports('import { value } from "@pragma/secret";')).toEqual([
      "@pragma/secret",
    ]);
    expect(findExternalWorkspaceImports('require("@pragma/secret");')).toEqual(["@pragma/secret"]);
    expect(findExternalWorkspaceImports("const value = require(\n  '@pragma/secret'\n);")).toEqual([
      "@pragma/secret",
    ]);
    expect(findExternalWorkspaceImports('require("node:fs");')).toEqual([]);
    expect(() => assertNoExternalWorkspaceImports('import "@pragma/secret";', "canary.js")).toThrow(
      "external @pragma imports",
    );
  });

  it("rejects secret patterns", () => {
    const canary = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456";
    expect(findSecretPatterns(canary)).toContain("Bearer token");
    expect(() => assertSafeText(canary, "canary.txt")).toThrow("Bearer token");
  });

  it("accepts normal package text", () => {
    expect(() => assertSafeText("Pragma CLI uses Node.js 22.\n", "README.md")).not.toThrow();
  });

  it("accepts runtime file URLs but rejects npm file protocols", () => {
    expect(() =>
      assertSafeText('const url = "file:///tmp/input";', "bundle.js", { allowFileUrls: true }),
    ).not.toThrow();
    expect(() => assertSafeText('"workspace:*"', "package.json")).toThrow("workspace protocol");
    expect(() => assertSafeText('"file:../local"', "package.json")).toThrow("file protocol");
  });

  it("rejects a concrete repository path even in bundle mode", () => {
    expect(() =>
      assertSafeText("source: /workspace/pragma/apps/cli/src/index.ts", "bundle.js", {
        repositoryDirectory: "/workspace/pragma",
        checkAbsolutePaths: false,
      }),
    ).toThrow("repository absolute path");
  });

  it("rejects build-machine source paths without rejecting legal runtime literals", () => {
    const repositoryDirectory = "/Users/build/Workspace/expert-mesh-cli";
    expect(
      findBuildPathLeaks(
        'const source = "/Users/build/Workspace/expert-mesh-cli/apps/cli/src/index.ts";',
        { repositoryDirectory },
      ),
    ).toContain("repository absolute path");
    expect(
      findBuildPathLeaks(String.raw`\Users\build\Workspace\expert-mesh-cli\apps\cli\src\index.ts`, {
        repositoryDirectory,
      }),
    ).toContain("repository absolute path");
    expect(
      findBuildPathLeaks("/home/runner/work/pragma/pragma/packages/core/src/index.ts"),
    ).toContain("build machine source path");
    expect(
      findBuildPathLeaks(
        String.raw`C:\Users\runneradmin\_work\pragma\pragma\apps\cli\src\index.ts`,
      ),
    ).toContain("build machine source path");
    expect(
      findBuildPathLeaks("/home/runner/work/_temp/cache/artifact", {
        buildDirectories: ["/home/runner/work/_temp"],
      }),
    ).toContain("build machine path");
    expect(findBuildPathLeaks("/home/web_user")).toEqual([]);
    expect(findBuildPathLeaks('new URL("./worker.js", import.meta.url)')).toEqual([]);
    expect(findBuildPathLeaks('const worker = "file:///tmp/worker.js";')).toEqual([]);
    expect(() =>
      assertNoBuildPathLeaks("/home/web_user", "bundle.js", { repositoryDirectory }),
    ).not.toThrow();
  });
});
