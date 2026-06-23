import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareGitSessionEnvironment, resolveRepositoryWorkspacePath } from "./git.ts";
import { parseCodeRepositoryManagerConfig } from "./schema.ts";

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
});

describe("Git session environment", () => {
  it("prepares token auth for direct bash git and restores env on cleanup", async () => {
    const root = await createTempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TEST_GIT_TOKEN: "secret-token",
      UNRELATED_SECRET: "do-not-pass",
    };
    const config = parseCodeRepositoryManagerConfig({
      auth: {
        strategy: "token",
        tokenEnv: "TEST_GIT_TOKEN",
        username: "oauth2",
      },
    });

    const prepared = await prepareGitSessionEnvironment(config, {
      gitCommand: await createFakeGit(root),
      env,
    });

    expect(prepared.authStrategy).toBe("token");
    expect(env.GIT_ASKPASS).toBeDefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.EXPERTMESH_GIT_USERNAME).toBe("oauth2");
    expect(env.EXPERTMESH_GIT_TOKEN).toBe("secret-token");
    expect(env.HOME).toBeDefined();
    expect(env.XDG_CONFIG_HOME).toBe(env.HOME);
    expect(env.UNRELATED_SECRET).toBe("do-not-pass");

    const homePath = env.HOME;
    expect((await stat(homePath ?? "")).isDirectory()).toBe(true);

    await prepared.cleanup();

    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBeUndefined();
    expect(env.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.EXPERTMESH_GIT_USERNAME).toBeUndefined();
    expect(env.EXPERTMESH_GIT_TOKEN).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.UNRELATED_SECRET).toBe("do-not-pass");
    await expect(stat(homePath ?? "")).rejects.toThrow();
  });

  it("writes SSH identity to a temporary session file and removes it on cleanup", async () => {
    const root = await createTempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TEST_SSH_KEY: "test-private-key",
      TEST_KNOWN_HOSTS: "github.com ssh-ed25519 AAAA",
    };
    const config = parseCodeRepositoryManagerConfig({
      auth: {
        strategy: "ssh",
        privateKeyEnv: "TEST_SSH_KEY",
        knownHostsEnv: "TEST_KNOWN_HOSTS",
      },
    });

    const prepared = await prepareGitSessionEnvironment(config, {
      gitCommand: await createFakeGit(root),
      env,
    });
    const identityPath = env.GIT_SSH_COMMAND?.match(/-i '([^']+)'/)?.[1];

    expect(prepared.authStrategy).toBe("ssh");
    expect(identityPath).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.XDG_CONFIG_HOME).toBe(env.HOME);
    await expect(readFile(identityPath ?? "", "utf8")).resolves.toBe("test-private-key");

    await prepared.cleanup();

    await expect(readFile(identityPath ?? "", "utf8")).rejects.toThrow();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it("writes credential.helper to an isolated temporary Git config", async () => {
    const root = await createTempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TEST_CREDENTIAL_HELPER: "!test-git-credential-helper",
    };
    const config = parseCodeRepositoryManagerConfig({
      auth: {
        strategy: "credential_helper",
        helperEnv: "TEST_CREDENTIAL_HELPER",
      },
    });

    const prepared = await prepareGitSessionEnvironment(config, {
      gitCommand: await createFakeGit(root),
      env,
    });

    expect(prepared.authStrategy).toBe("credential_helper");
    expect(env.GIT_CONFIG_GLOBAL).toBeDefined();
    expect(env.GIT_CONFIG_GLOBAL).not.toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.HOME).toBeDefined();
    expect(env.XDG_CONFIG_HOME).toBe(env.HOME);
    await expect(readFile(env.GIT_CONFIG_GLOBAL ?? "", "utf8")).resolves.toContain(
      'helper = "!test-git-credential-helper"',
    );

    const homePath = env.HOME;
    await prepared.cleanup();

    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    await expect(stat(homePath ?? "")).rejects.toThrow();
  });

  it("rejects credential.helper values with control characters", async () => {
    const root = await createTempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TEST_CREDENTIAL_HELPER: "!helper\nextra-command",
    };
    const config = parseCodeRepositoryManagerConfig({
      auth: {
        strategy: "credential_helper",
        helperEnv: "TEST_CREDENTIAL_HELPER",
      },
    });

    await expect(
      prepareGitSessionEnvironment(config, {
        gitCommand: await createFakeGit(root),
        env,
      }),
    ).rejects.toThrow(/control characters/);
  });

  it("isolates Git config for unauthenticated sessions", async () => {
    const root = await createTempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
    };
    const config = parseCodeRepositoryManagerConfig({
      auth: { strategy: "none" },
    });

    const prepared = await prepareGitSessionEnvironment(config, {
      gitCommand: await createFakeGit(root),
      env,
    });

    expect(prepared.authStrategy).toBe("none");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.HOME).toBeDefined();
    expect(env.XDG_CONFIG_HOME).toBe(env.HOME);

    const homePath = env.HOME;
    expect((await stat(homePath ?? "")).isDirectory()).toBe(true);
    await prepared.cleanup();

    expect(env.GIT_TERMINAL_PROMPT).toBeUndefined();
    expect(env.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    await expect(stat(homePath ?? "")).rejects.toThrow();
  });
});

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), "expertmesh-git-test-"));
  tempDirs.push(path);
  return path;
}

async function createFakeGit(root: string): Promise<string> {
  const scriptPath = resolve(root, "fake-git.cjs");
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('git version fake\\n');",
      "}",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o700);
  return scriptPath;
}
