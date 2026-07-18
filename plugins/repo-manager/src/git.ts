import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { ExpertAgentProcessEnvironmentPatch } from "@pragma/core";

import type { CodeRepositoryAuth, RepoManagerConfig } from "./schema.ts";

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
  readonly gitCommand?: string | undefined;
  readonly env?: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface GitSessionEnvironment {
  readonly gitVersion: string;
  readonly authStrategy: CodeRepositoryAuth["strategy"];
  readonly processEnvironment: ExpertAgentProcessEnvironmentPatch;
  readonly cleanup: () => Promise<void>;
}

export async function prepareGitSessionEnvironment(
  config: RepoManagerConfig,
  options: GitCommandOptions = {},
): Promise<GitSessionEnvironment> {
  const env = options.env ?? process.env;
  const gitVersion = await checkGitCli(options);
  const localHttpExtraHeaderKeys = await readLocalHttpExtraHeaderKeys(options);
  const prepared = await createGitSessionEnvironment(config.auth, localHttpExtraHeaderKeys);

  return {
    gitVersion,
    authStrategy: config.auth.strategy,
    processEnvironment: {
      set: prepared.env,
      unset: Object.keys(env).filter(
        (name) => isInheritedGitEnvironmentVariable(name) && prepared.env[name] === undefined,
      ),
    },
    cleanup: prepared.cleanup,
  };
}

export async function checkGitCli(options: GitCommandOptions = {}): Promise<string> {
  const result = await execGit(["--version"], {
    ...options,
    env: createGitProcessEnv(options.env ?? process.env),
  });
  return result.stdout.trim();
}

async function createGitSessionEnvironment(
  auth: CodeRepositoryAuth,
  localHttpExtraHeaderKeys: readonly string[],
): Promise<{
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}> {
  if (auth.strategy === "credential_helper") {
    assertSafeCredentialHelperValue(auth.helper, "configured helper");
  }

  const tempDir = await mkdtemp(resolve(tmpdir(), "pragma-git-session-"));
  const sharedEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    ...createProtectedGitConfigEnvironment(auth, localHttpExtraHeaderKeys),
  };

  if (auth.strategy === "none") {
    const askPassPath = await writeAskPassScript(tempDir, ["#!/bin/sh", "exit 0", ""]);

    return {
      env: {
        ...sharedEnv,
        GIT_ASKPASS: askPassPath,
        HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      },
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  if (auth.strategy === "token") {
    const askPassPath = await writeAskPassScript(tempDir, [
      "#!/bin/sh",
      'case "$1" in',
      "*Username*) printf '%s\\n' \"$PRAGMA_GIT_USERNAME\" ;;",
      "*Password*) printf '%s\\n' \"$PRAGMA_GIT_TOKEN\" ;;",
      "*) printf '\\n' ;;",
      "esac",
      "",
    ]);

    return {
      env: {
        ...sharedEnv,
        GIT_ASKPASS: askPassPath,
        PRAGMA_GIT_USERNAME: auth.username,
        PRAGMA_GIT_TOKEN: auth.token,
        HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      },
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  if (auth.strategy === "credential_helper") {
    const askPassPath = await writeAskPassScript(tempDir, ["#!/bin/sh", "exit 0", ""]);

    return {
      env: {
        ...sharedEnv,
        GIT_ASKPASS: askPassPath,
        HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      },
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  const privateKeyPath = resolve(tempDir, "identity");
  const knownHosts = auth.knownHosts;
  const knownHostsPath = resolve(tempDir, "known_hosts");
  await writeFile(privateKeyPath, auth.privateKey, {
    mode: 0o600,
  });
  await chmod(privateKeyPath, 0o600);

  if (knownHosts !== undefined) {
    await writeFile(knownHostsPath, knownHosts, {
      mode: 0o600,
    });
  }

  return {
    env: {
      ...sharedEnv,
      GIT_SSH_COMMAND: [
        "ssh",
        "-i",
        shellQuote(privateKeyPath),
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        `StrictHostKeyChecking=${knownHosts === undefined ? "accept-new" : "yes"}`,
        "-o",
        `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
        "-o",
        `GlobalKnownHostsFile=${shellQuote(devNull)}`,
      ].join(" "),
      HOME: tempDir,
      XDG_CONFIG_HOME: tempDir,
    },
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function writeAskPassScript(tempDir: string, lines: readonly string[]): Promise<string> {
  const askPassPath = resolve(tempDir, "askpass.sh");
  await writeFile(askPassPath, lines.join("\n"), { mode: 0o700 });
  await chmod(askPassPath, 0o700);
  return askPassPath;
}

function createProtectedGitConfigEnvironment(
  auth: CodeRepositoryAuth,
  localHttpExtraHeaderKeys: readonly string[],
): Readonly<Record<string, string>> {
  const entries: [string, string][] = [
    ["credential.helper", ""],
    ["http.extraHeader", ""],
    ...localHttpExtraHeaderKeys.map((key): [string, string] => [key, ""]),
  ];

  if (auth.strategy === "token") {
    entries.push(["credential.username", auth.username]);
  } else if (auth.strategy === "credential_helper") {
    entries.push(["credential.helper", auth.helper]);
  }

  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
}

async function readLocalHttpExtraHeaderKeys(
  options: GitCommandOptions,
): Promise<readonly string[]> {
  if (options.workspaceRoot === undefined) return [];
  const env = createGitProcessEnv(options.env ?? process.env);
  try {
    await execGit(["-C", options.workspaceRoot, "rev-parse", "--git-dir"], {
      ...options,
      env,
    });
  } catch {
    return [];
  }

  try {
    const result = await execGit(
      [
        "-C",
        options.workspaceRoot,
        "config",
        "--local",
        "--name-only",
        "--get-regexp",
        "^http\\..*\\.extraheader$",
      ],
      { ...options, env },
    );
    return [
      ...new Set(
        result.stdout
          .split("\n")
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    ];
  } catch (error) {
    if (readExitCode(error) === 1) return [];
    throw error;
  }
}

async function execGit(
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const gitCommand = options.gitCommand ?? "git";
  const isNodeScript = /\.(?:c|m)?js$/iu.test(gitCommand);
  const command = isNodeScript ? process.execPath : gitCommand;
  const commandArgs = isNodeScript
    ? [gitCommand, ...createSafeGitArgs(args)]
    : createSafeGitArgs(args);
  const result = await execFileAsync(command, commandArgs, {
    env: options.env === undefined ? undefined : { ...options.env },
    signal: options.signal,
    maxBuffer: 1024 * 1024 * 5,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function createSafeGitArgs(args: readonly string[]): readonly string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args];
}

function createGitProcessEnv(baseEnv: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  return {
    ...(baseEnv.PATH === undefined ? {} : { PATH: baseEnv.PATH }),
    ...(baseEnv.LANG === undefined ? {} : { LANG: baseEnv.LANG }),
    ...(baseEnv.LC_ALL === undefined ? {} : { LC_ALL: baseEnv.LC_ALL }),
    ...(baseEnv.SystemRoot === undefined ? {} : { SystemRoot: baseEnv.SystemRoot }),
    ...(baseEnv.windir === undefined ? {} : { windir: baseEnv.windir }),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
  };
}

function isInheritedGitEnvironmentVariable(name: string): boolean {
  return (
    name.startsWith("GIT_") ||
    name === "PRAGMA_GIT_USERNAME" ||
    name === "PRAGMA_GIT_TOKEN" ||
    name === "SSH_AUTH_SOCK" ||
    name === "SSH_AGENT_PID" ||
    name === "SSH_ASKPASS" ||
    name === "SSH_ASKPASS_REQUIRE"
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertSafeCredentialHelperValue(value: string, envName: string): void {
  if (hasControlCharacter(value)) {
    throw new Error(
      `Git credential.helper environment variable contains control characters: ${envName}`,
    );
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function readExitCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}
