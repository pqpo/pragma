import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureRepository, resolveRepositoryWorkspacePath } from "./git.ts";
import { parseCodeRepositoryManagerConfig } from "./schema.ts";

interface GitLogEntry {
  readonly command: string | undefined;
  readonly args: readonly string[];
  readonly token: string | undefined;
  readonly unrelatedSecret: string | undefined;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("Git workspace path resolution", () => {
  it("resolves default repository paths inside workspace", () => {
    expect(
      resolveRepositoryWorkspacePath("/tmp/expertmesh", {
        id: "repo",
      }),
    ).toBe("/tmp/expertmesh/repos/repo");
  });

  it("rejects existing repository paths that resolve outside workspace", async () => {
    const root = await createTempDir();
    const workspace = resolve(root, "workspace");
    const outside = resolve(root, "outside");
    const link = resolve(workspace, "repos", "repo");
    await mkdir(resolve(workspace, "repos"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, link);

    const config = parseCodeRepositoryManagerConfig({
      auth: { strategy: "none" },
      repositories: [
        {
          id: "repo",
          name: "Repo",
          cloneUrl: "https://github.com/example/repo.git",
          defaultBranch: "main",
        },
      ],
    });

    await expect(
      ensureRepository(config, {
        repoId: "repo",
        workspaceRoot: workspace,
        gitCommand: await createFakeGit(root, "https://github.com/example/repo.git"),
      }),
    ).rejects.toThrow("must resolve inside workspace");
  });

  it("rejects existing repositories whose origin does not match the configured cloneUrl", async () => {
    const root = await createTempDir();
    const workspace = resolve(root, "workspace");
    const target = resolve(workspace, "repos", "repo");
    await mkdir(target, { recursive: true });

    const config = parseCodeRepositoryManagerConfig({
      auth: { strategy: "none" },
      repositories: [
        {
          id: "repo",
          name: "Repo",
          cloneUrl: "https://github.com/example/repo.git",
          defaultBranch: "main",
        },
      ],
    });

    await expect(
      ensureRepository(config, {
        repoId: "repo",
        workspaceRoot: workspace,
        gitCommand: await createFakeGit(root, "https://github.com/other/repo.git"),
      }),
    ).rejects.toThrow("origin does not match");
  });

  it("uses token auth only for network fetch and keeps unrelated secrets out of git env", async () => {
    const root = await createTempDir();
    const workspace = resolve(root, "workspace");
    const target = resolve(workspace, "repos", "repo");
    const logPath = resolve(root, "git-log.jsonl");
    await mkdir(target, { recursive: true });

    const config = parseCodeRepositoryManagerConfig({
      auth: {
        strategy: "token",
        tokenEnv: "TEST_GIT_TOKEN",
      },
      repositories: [
        {
          id: "repo",
          name: "Repo",
          cloneUrl: "https://github.com/example/repo.git",
          defaultBranch: "main",
        },
      ],
    });

    await ensureRepository(config, {
      repoId: "repo",
      workspaceRoot: workspace,
      gitCommand: await createFakeGit(root, "https://github.com/example/repo.git", logPath),
      env: {
        PATH: process.env.PATH,
        TEST_GIT_TOKEN: "secret-token",
        UNRELATED_SECRET: "do-not-pass",
      },
    });

    const entries = await readGitLog(logPath);
    const byCommand = new Map(entries.map((entry) => [entry.command, entry]));

    expect(byCommand.get("fetch")?.token).toBe("secret-token");
    expect(byCommand.get("fetch")).not.toHaveProperty("unrelatedSecret");
    expect(byCommand.get("checkout")).not.toHaveProperty("token");
    expect(byCommand.get("checkout")).not.toHaveProperty("unrelatedSecret");
    expect(byCommand.get("merge")).not.toHaveProperty("token");
    expect(byCommand.get("merge")).not.toHaveProperty("unrelatedSecret");
  });
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), "expertmesh-git-test-"));
  tempDirs.push(path);
  return path;
}

async function createFakeGit(root: string, origin: string, logPath?: string): Promise<string> {
  const scriptPath = resolve(root, "fake-git.cjs");
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "const { appendFileSync } = require('node:fs');",
      `const origin = ${JSON.stringify(origin)};`,
      `const logPath = ${JSON.stringify(logPath)};`,
      "const args = process.argv.slice(2);",
      "let index = 0;",
      "while (args[index] === '-c') index += 2;",
      "while (args[index] === '-C') index += 2;",
      "const command = args[index];",
      "if (logPath !== undefined) {",
      "  appendFileSync(logPath, JSON.stringify({",
      "    command,",
      "    args,",
      "    token: process.env.EXPERTMESH_GIT_TOKEN,",
      "    unrelatedSecret: process.env.UNRELATED_SECRET,",
      "  }) + '\\n');",
      "}",
      "if (args.includes('--version')) {",
      "  process.stdout.write('git version fake\\n');",
      "} else if (command === 'rev-parse') {",
      "  process.stdout.write('true\\n');",
      "} else if (command === 'remote') {",
      "  process.stdout.write(origin + '\\n');",
      "}",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

async function readGitLog(path: string): Promise<readonly GitLogEntry[]> {
  const content = await readFile(path, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GitLogEntry);
}
