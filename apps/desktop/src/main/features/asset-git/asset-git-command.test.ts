import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runAssetGit } from "./asset-git-command.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const originalSshCommand = process.env.GIT_SSH_COMMAND;
const originalSsh = process.env.GIT_SSH;
const originalPath = process.env.PATH;

afterEach(async () => {
  if (originalSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
  else process.env.GIT_SSH_COMMAND = originalSshCommand;
  if (originalSsh === undefined) delete process.env.GIT_SSH;
  else process.env.GIT_SSH = originalSsh;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; ssh: string; marker: string }> {
  const root = await mkdtemp(join(tmpdir(), "pragma-asset-git-command-test-"));
  roots.push(root);
  await execFileAsync("git", ["-C", root, "init"]);
  await execFileAsync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "ssh://git@example.test/repo",
  ]);
  const marker = join(root, "ssh-invoked");
  const bin = join(root, "bin");
  await mkdir(bin);
  const ssh = join(bin, "ssh");
  await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(ssh, 0o700);
  return { root, ssh, marker };
}

async function expectConfiguredTransport(root: string, marker: string): Promise<void> {
  await expect(runAssetGit(root, ["ls-remote", "origin"])).rejects.toThrow();
  await expect(readFile(marker, "utf8")).resolves.toContain("example.test");
}

describe("asset Git command", () => {
  it("reports a timeout even when Git has already written stderr", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error) => void;
        callback(
          Object.assign(new Error("Command failed."), {
            killed: true,
            stderr: "Connecting to origin...",
            code: null,
          }),
        );
      },
    }));
    try {
      const { runAssetGit: timedOutGit } = await import("./asset-git-command.ts");
      await expect(timedOutGit("/tmp", ["fetch", "origin"])).rejects.toMatchObject({
        message: "Git fetch failed: Git operation timed out.\nConnecting to origin...",
        killed: true,
        stderr: "Connecting to origin...",
      });
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
  it("preserves the Git cause and exit code without the exec command wrapper", async () => {
    const { root } = await fixture();
    await expect(runAssetGit(root, ["rev-parse", "--verify", "missing"])).rejects.toMatchObject({
      code: 128,
      message: expect.stringContaining("Git rev-parse failed: fatal:"),
      stderr: expect.stringContaining("fatal:"),
    });
  });
  it("preserves GIT_SSH_COMMAND", async () => {
    const { root, ssh, marker } = await fixture();
    process.env.GIT_SSH_COMMAND = ssh;
    delete process.env.GIT_SSH;

    await expectConfiguredTransport(root, marker);
  });

  it("preserves GIT_SSH", async () => {
    const { root, ssh, marker } = await fixture();
    delete process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH = ssh;

    await expectConfiguredTransport(root, marker);
  });

  it("preserves core.sshCommand", async () => {
    const { root, ssh, marker } = await fixture();
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    await execFileAsync("git", ["-C", root, "config", "core.sshCommand", ssh]);

    await expectConfiguredTransport(root, marker);
  });

  it("uses BatchMode for the default SSH transport", async () => {
    const { root, marker } = await fixture();
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    process.env.PATH = `${join(root, "bin")}:${originalPath ?? ""}`;

    await expectConfiguredTransport(root, marker);
    await expect(readFile(marker, "utf8")).resolves.toContain("BatchMode=yes");
  });
});
