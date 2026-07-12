import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Expert } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareManagedCodexHome } from "../src/codex-home.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("managed Codex home", () => {
  it("exposes authentication and copies environment-based runtime configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-codex-home-"));
    temporaryDirectories.push(root);
    const sharedCodexHome = join(root, "shared");
    const sessionDir = join(root, "session");
    await mkdir(sharedCodexHome, { recursive: true });
    await Promise.all([
      writeFile(join(sharedCodexHome, "auth.json"), '{"auth_mode":"chatgpt"}'),
      writeFile(join(sharedCodexHome, ".env"), "HTTPS_PROXY=http://127.0.0.1:7890\n"),
    ]);

    const codexHome = await prepareManagedCodexHome({
      agent: { workspace: root } as Expert,
      sessionDir,
      env: { CODEX_HOME: sharedCodexHome },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(join(codexHome, "auth.json"), "utf8")).resolves.toContain("chatgpt");
    await expect(readFile(join(codexHome, ".env"), "utf8")).resolves.toContain("HTTPS_PROXY");
  });
});
