import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ExpertAgentProcessEnvironmentPatch } from "@pragma/core";

import { prepareGitSessionEnvironment } from "../src/git.ts";
import { parseRepoManagerConfig } from "../src/schema.ts";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("Git session environment", () => {
  it("prepares token auth without mutating the host environment", async () => {
    const root = await createTempDir();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: "/user/home",
      GIT_ASKPASS: "/user/askpass",
      SSH_AUTH_SOCK: "/user/ssh-agent",
      UNRELATED_SECRET: "preserved",
    };
    const original = { ...env };
    const prepared = await prepareGitSessionEnvironment(
      parseRepoManagerConfig({
        auth: { strategy: "token", token: "secret-token", username: "oauth2" },
      }),
      { gitCommand: await createFakeGit(root), env },
    );
    const sessionEnv = applyPatch(env, prepared.processEnvironment);

    expect(prepared.authStrategy).toBe("token");
    expect(env).toEqual(original);
    expect(sessionEnv.GIT_ASKPASS).toBeDefined();
    expect(sessionEnv.GIT_TERMINAL_PROMPT).toBe("0");
    expect(sessionEnv.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(sessionEnv.GIT_CONFIG_GLOBAL).toBe(devNull);
    expect(readInjectedGitConfig(sessionEnv)).toEqual([
      ["credential.helper", ""],
      ["http.extraHeader", ""],
      ["credential.username", "oauth2"],
    ]);
    expect(sessionEnv.PRAGMA_GIT_USERNAME).toBe("oauth2");
    expect(sessionEnv.PRAGMA_GIT_TOKEN).toBe("secret-token");
    expect(sessionEnv.HOME).not.toBe(env.HOME);
    expect(sessionEnv.XDG_CONFIG_HOME).toBe(sessionEnv.HOME);
    expect(sessionEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(sessionEnv.UNRELATED_SECRET).toBe("preserved");

    const homePath = sessionEnv.HOME;
    expect((await stat(homePath ?? "")).isDirectory()).toBe(true);
    await prepared.cleanup();
    expect(env).toEqual(original);
    await expect(stat(homePath ?? "")).rejects.toThrow();
  });

  it("uses independent token patches for concurrent sessions", async () => {
    const root = await createTempDir();
    const gitCommand = await createFakeGit(root);
    const base = { PATH: process.env.PATH };
    const [first, second] = await Promise.all([
      prepareGitSessionEnvironment(
        parseRepoManagerConfig({ auth: { strategy: "token", token: "token-a" } }),
        { gitCommand, env: base },
      ),
      prepareGitSessionEnvironment(
        parseRepoManagerConfig({ auth: { strategy: "token", token: "token-b" } }),
        { gitCommand, env: base },
      ),
    ]);

    expect(applyPatch(base, first.processEnvironment).PRAGMA_GIT_TOKEN).toBe("token-a");
    expect(applyPatch(base, second.processEnvironment).PRAGMA_GIT_TOKEN).toBe("token-b");
    expect(first.processEnvironment.set?.HOME).not.toBe(second.processEnvironment.set?.HOME);
    expect(base).toEqual({ PATH: process.env.PATH });

    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it("rejects token auth without a resolved token", () => {
    expect(() => parseRepoManagerConfig({ auth: { strategy: "token" } as never })).toThrow();
  });

  it("writes SSH identity to a temporary session file and removes it on cleanup", async () => {
    const root = await createTempDir();
    const base = {
      PATH: process.env.PATH,
      GIT_SSH_COMMAND: "user-command",
      SSH_AUTH_SOCK: "/user/agent",
    };
    const prepared = await prepareGitSessionEnvironment(
      parseRepoManagerConfig({
        auth: {
          strategy: "ssh",
          privateKey: "test-private-key",
          knownHosts: "github.com ssh-ed25519 AAAA",
        },
      }),
      { gitCommand: await createFakeGit(root), env: base },
    );
    const sessionEnv = applyPatch(base, prepared.processEnvironment);
    const identityPath = sessionEnv.GIT_SSH_COMMAND?.match(/-i '([^']+)'/)?.[1];

    expect(prepared.authStrategy).toBe("ssh");
    expect(identityPath).toBeDefined();
    expect(sessionEnv.SSH_AUTH_SOCK).toBeUndefined();
    expect(sessionEnv.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    expect(sessionEnv.GIT_SSH_COMMAND).toContain(`GlobalKnownHostsFile='${devNull}'`);
    await expect(readFile(identityPath ?? "", "utf8")).resolves.toBe("test-private-key");

    await prepared.cleanup();
    await expect(readFile(identityPath ?? "", "utf8")).rejects.toThrow();
    expect(base.GIT_SSH_COMMAND).toBe("user-command");
  });

  it("uses accept-new with a session known_hosts file when knownHosts is omitted", async () => {
    const root = await createTempDir();
    const prepared = await prepareGitSessionEnvironment(
      parseRepoManagerConfig({
        auth: { strategy: "ssh", privateKey: "test-private-key" },
      }),
      { gitCommand: await createFakeGit(root), env: { PATH: process.env.PATH } },
    );
    const sessionEnv = applyPatch({ PATH: process.env.PATH }, prepared.processEnvironment);
    const knownHostsPath = sessionEnv.GIT_SSH_COMMAND?.match(/UserKnownHostsFile='([^']+)'/)?.[1];

    expect(sessionEnv.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=accept-new");
    expect(knownHostsPath).toBeDefined();
    await expect(stat(knownHostsPath ?? "")).rejects.toThrow();

    await prepared.cleanup();
    await expect(stat(sessionEnv.HOME ?? "")).rejects.toThrow();
  });

  it("selects only the explicitly configured credential helper", async () => {
    const root = await createTempDir();
    const base = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/user/.gitconfig" };
    const prepared = await prepareGitSessionEnvironment(
      parseRepoManagerConfig({
        auth: { strategy: "credential_helper", helper: "!test-git-credential-helper" },
      }),
      { gitCommand: await createFakeGit(root), env: base },
    );
    const sessionEnv = applyPatch(base, prepared.processEnvironment);

    expect(prepared.authStrategy).toBe("credential_helper");
    expect(sessionEnv.GIT_CONFIG_GLOBAL).toBe(devNull);
    expect(readInjectedGitConfig(sessionEnv)).toEqual([
      ["credential.helper", ""],
      ["http.extraHeader", ""],
      ["credential.helper", "!test-git-credential-helper"],
    ]);

    const homePath = sessionEnv.HOME;
    await prepared.cleanup();
    expect(base.GIT_CONFIG_GLOBAL).toBe("/user/.gitconfig");
    await expect(stat(homePath ?? "")).rejects.toThrow();
  });

  it("rejects credential.helper values with control characters", async () => {
    const root = await createTempDir();
    await expect(
      prepareGitSessionEnvironment(
        parseRepoManagerConfig({
          auth: { strategy: "credential_helper", helper: "!helper\nextra-command" },
        }),
        { gitCommand: await createFakeGit(root), env: { PATH: process.env.PATH } },
      ),
    ).rejects.toThrow(/control characters/);
  });

  it("isolates Git config for unauthenticated sessions", async () => {
    const root = await createTempDir();
    const base = {
      PATH: process.env.PATH,
      HOME: "/user/home",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "secret",
    };
    const prepared = await prepareGitSessionEnvironment(
      parseRepoManagerConfig({ auth: { strategy: "none" } }),
      { gitCommand: await createFakeGit(root), env: base },
    );
    const sessionEnv = applyPatch(base, prepared.processEnvironment);

    expect(prepared.authStrategy).toBe("none");
    expect(sessionEnv.GIT_CONFIG_GLOBAL).toBe(devNull);
    expect(readInjectedGitConfig(sessionEnv)).toEqual([
      ["credential.helper", ""],
      ["http.extraHeader", ""],
    ]);
    expect(sessionEnv.HOME).not.toBe(base.HOME);

    const homePath = sessionEnv.HOME;
    await prepared.cleanup();
    expect(base.HOME).toBe("/user/home");
    await expect(stat(homePath ?? "")).rejects.toThrow();
  });

  it("overrides checkout credential helpers and URL-scoped authentication headers", async () => {
    const root = await createTempDir();
    const repository = resolve(root, "repository");
    await mkdir(repository);
    await runGit(["-C", repository, "init", "-q"]);
    await runGit([
      "-C",
      repository,
      "config",
      "credential.https://example.com.helper",
      "!f() { echo username=local-user; echo password=local-secret; }; f",
    ]);
    await runGit([
      "-C",
      repository,
      "config",
      "http.https://example.com.extraHeader",
      "Authorization: local-secret",
    ]);

    const base = { PATH: process.env.PATH };
    const none = await prepareGitSessionEnvironment(
      parseRepoManagerConfig({ auth: { strategy: "none" } }),
      { env: base, workspaceRoot: repository },
    );
    const noneResult = await runGitCredential(
      repository,
      applyPatch(base, none.processEnvironment),
    );
    expect(`${noneResult.stdout}\n${noneResult.stderr}`).not.toContain("local-secret");
    expect(noneResult.stdout).not.toContain("local-user");
    await none.cleanup();

    const token = await prepareGitSessionEnvironment(
      parseRepoManagerConfig({
        auth: { strategy: "token", token: "session-token", username: "session-user" },
      }),
      { env: base, workspaceRoot: repository },
    );
    const tokenEnv = applyPatch(base, token.processEnvironment);
    const tokenResult = await runGitCredential(repository, tokenEnv);
    expect(tokenResult.code).toBe(0);
    expect(tokenResult.stdout).toContain("username=session-user");
    expect(tokenResult.stdout).toContain("password=session-token");
    expect(tokenResult.stdout).not.toContain("local-secret");
    const extraHeader = await runGit(
      ["-C", repository, "config", "--get-urlmatch", "http.extraHeader", "https://example.com"],
      tokenEnv,
    );
    expect(extraHeader.stdout.trim()).toBe("");
    await token.cleanup();
  });
});

function applyPatch(
  base: Readonly<NodeJS.ProcessEnv>,
  patch: ExpertAgentProcessEnvironmentPatch,
): NodeJS.ProcessEnv {
  const result = { ...base };
  for (const name of patch.unset ?? []) delete result[name];
  Object.assign(result, patch.set ?? {});
  return result;
}

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), "pragma-git-test-"));
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

function readInjectedGitConfig(env: Readonly<NodeJS.ProcessEnv>): [string, string][] {
  return Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`] ?? "",
    env[`GIT_CONFIG_VALUE_${index}`] ?? "",
  ]);
}

async function runGit(
  args: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync("git", [...args], { env: { ...env } });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runGitCredential(
  repository: string,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-C", repository, "credential", "fill"], {
      env: { ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end("protocol=https\nhost=example.com\n\n");
  });
}
