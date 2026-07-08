import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ExpertAgent } from "@pragma/core";
import { prepareManagedCodexHome } from "../src/codex-home.ts";

describe("prepareManagedCodexHome", () => {
  it("copies config file contents before stripping skills config entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-codex-home-test-"));
    const sharedHome = join(root, "shared");
    const sessionDir = join(root, "session");
    const realConfig = join(root, "real-config.toml");
    await mkdir(sharedHome, { recursive: true });
    await writeFile(
      realConfig,
      [
        'model = "gpt-5"',
        "",
        "[[skills.config]]",
        'path = "/tmp/skill/SKILL.md"',
        "enabled = false",
        "",
      ].join("\n"),
    );
    await symlink(realConfig, join(sharedHome, "config.toml"));
    const agent = await createTestAgent(join(root, "workspace"));

    const codexHome = await prepareManagedCodexHome({
      agent,
      sessionDir,
      env: { CODEX_HOME: sharedHome },
      logger: { warn: vi.fn() },
    });

    await expect(readFile(realConfig, "utf8")).resolves.toContain("[[skills.config]]");
    await expect(readFile(join(codexHome, "config.toml"), "utf8")).resolves.toBe(
      'model = "gpt-5"\n',
    );
  });
});

async function createTestAgent(workspace: string): Promise<ExpertAgent> {
  await mkdir(workspace, { recursive: true });

  return await ExpertAgent.create({
    id: "agent-codex-home-test",
    name: "Codex Home Test Agent",
    description: "Agent used by Codex home tests.",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace,
  });
}
