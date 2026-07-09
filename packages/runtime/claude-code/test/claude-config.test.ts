import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { prepareManagedClaudeCodeConfig } from "../src/claude-config.ts";

describe("prepareManagedClaudeCodeConfig", () => {
  it("copies settings files and links shared state directories into the managed config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-claude-config-test-"));
    const sharedConfigDir = join(root, "shared-claude");
    const sessionDir = join(root, "session");
    await mkdir(sharedConfigDir, { recursive: true });
    await writeFile(
      join(sharedConfigDir, "settings.json"),
      `${JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://example.invalid",
          ANTHROPIC_AUTH_TOKEN: "test-token",
        },
      })}\n`,
    );
    await writeFile(join(sharedConfigDir, "settings.local.json"), '{"theme":"dark"}\n');

    const config = await prepareManagedClaudeCodeConfig({
      sessionDir,
      env: { CLAUDE_CONFIG_DIR: sharedConfigDir },
      logger: { warn: () => undefined },
    });

    await expect(readFile(join(config.configDir, "settings.json"), "utf8")).resolves.toContain(
      "ANTHROPIC_AUTH_TOKEN",
    );
    await writeFile(join(config.configDir, "settings.json"), '{"env":{}}\n');

    await expect(readFile(join(sharedConfigDir, "settings.json"), "utf8")).resolves.toContain(
      "ANTHROPIC_AUTH_TOKEN",
    );
    const refreshedConfig = await prepareManagedClaudeCodeConfig({
      sessionDir,
      env: { CLAUDE_CONFIG_DIR: sharedConfigDir },
      logger: { warn: () => undefined },
    });

    await expect(readFile(join(config.configDir, "settings.local.json"), "utf8")).resolves.toBe(
      '{"theme":"dark"}\n',
    );
    expect((await lstat(join(config.configDir, "projects"))).isSymbolicLink()).toBe(true);
    expect(config.settingsPath).toBe(join(config.configDir, "settings.json"));
    expect(refreshedConfig.settingsPath).toBe(join(config.configDir, "settings.json"));
  });
});
