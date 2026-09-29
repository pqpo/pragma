import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canUseClaudeCodeRuntime } from "../src/availability.ts";
import { createClaudeCodeRuntime } from "../src/adapter.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("user-installed Claude CLI boundary", () => {
  it("reports a clean environment without consulting the installed SDK CLI packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-without-claude-"));
    roots.push(root);
    const worker = join(root, "worker.js");
    await writeFile(worker, "// worker");
    const runtime = createClaudeCodeRuntime({
      acpWorkerPath: worker,
      env: { PATH: root, HOME: root, USERPROFILE: root },
    });
    await expect(runtime.canUse()).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining("Install Claude Code yourself"),
      details: { code: "claude_cli_unavailable" },
    });
  });
  it("keeps runtime composition safe and reports an invalid external CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-external-cli-"));
    roots.push(root);
    const worker = join(root, "worker.js");
    await writeFile(worker, "// worker");
    const runtime = createClaudeCodeRuntime({
      executablePath: join(root, "missing"),
      acpWorkerPath: worker,
    });
    await expect(runtime.canUse()).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining("Install Claude Code yourself"),
      details: { code: "claude_cli_unavailable" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "detects installation, permission loss and removal at a path with spaces",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pragma-external-cli-"));
      roots.push(root);
      const directory = join(root, "User Installed Claude");
      await mkdir(directory);
      const executablePath = join(directory, "claude");
      const acpWorkerPath = join(root, "worker.js");
      await writeFile(acpWorkerPath, "// worker");
      const options = { executablePath, acpWorkerPath, forceRefresh: true };
      const discovered = {
        acpWorkerPath,
        env: { PATH: directory, HOME: root, USERPROFILE: root },
        forceRefresh: true,
      };
      expect((await canUseClaudeCodeRuntime(options)).usable).toBe(false);
      expect((await canUseClaudeCodeRuntime(discovered)).usable).toBe(false);
      await writeFile(executablePath, "#!/bin/sh\nprintf '2.1.195 (Claude Code)\\n'\n");
      await chmod(executablePath, 0o755);
      await expect(canUseClaudeCodeRuntime(options)).resolves.toMatchObject({
        usable: true,
        details: { executablePath, version: "2.1.195 (Claude Code)" },
      });
      await expect(canUseClaudeCodeRuntime(discovered)).resolves.toMatchObject({
        usable: true,
        details: { executablePath },
      });
      await chmod(executablePath, 0o644);
      expect((await canUseClaudeCodeRuntime(options)).usable).toBe(false);
      expect((await canUseClaudeCodeRuntime(discovered)).usable).toBe(false);
      await rm(executablePath);
      expect((await canUseClaudeCodeRuntime(options)).usable).toBe(false);
      expect((await canUseClaudeCodeRuntime(discovered)).usable).toBe(false);
    },
    15_000,
  );
});
