import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { defaultRepositoryWorkspacePath } from "./context.ts";
import type { CodeRepository, CodeRepositoryAuth, CodeRepositoryManagerConfig } from "./schema.ts";

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
  readonly gitCommand?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface GitSessionEnvironment {
  readonly gitVersion: string;
  readonly authStrategy: CodeRepositoryAuth["strategy"];
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}

export async function prepareGitSessionEnvironment(
  config: CodeRepositoryManagerConfig,
  options: GitCommandOptions = {},
): Promise<GitSessionEnvironment> {
  const env = options.env ?? process.env;
  const gitVersion = await checkGitCli(options);
  assertAuthEnvironment(config.auth, env);
  const prepared = await createGitSessionEnvironment(config.auth, env);
  const restore = applyGitEnvironment(env, prepared.env);

  return {
    gitVersion,
    authStrategy: config.auth.strategy,
    env: prepared.env,
    cleanup: async () => {
      restore();
      await prepared.cleanup();
    },
  };
}

export async function checkGitCli(options: GitCommandOptions = {}): Promise<string> {
  const result = await execGit(["--version"], {
    ...options,
    env: createGitProcessEnv(options.env ?? process.env),
  });
  return result.stdout.trim();
}

export function resolveRepositoryWorkspacePath(
  workspaceRoot: string,
  repository: Pick<CodeRepository, "id">,
): string {
  const workspace = resolve(workspaceRoot);
  const target = resolve(workspace, defaultRepositoryWorkspacePath(repository));
  const relativePath = relative(workspace, target);

  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Repository path must stay inside workspace: ${repository.id}`);
  }

  return target;
}

async function createGitSessionEnvironment(
  auth: CodeRepositoryAuth,
  baseEnv: NodeJS.ProcessEnv,
): Promise<{
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}> {
  const sharedEnv = {
    ...createGitProcessEnv(baseEnv),
    GIT_TERMINAL_PROMPT: "0",
  };

  if (auth.strategy === "none") {
    const tempDir = await mkdtemp(resolve(tmpdir(), "pragma-git-session-"));

    return {
      env: {
        ...sharedEnv,
        HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      },
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  const tempDir = await mkdtemp(resolve(tmpdir(), "pragma-git-session-"));

  if (auth.strategy === "token") {
    const askPassPath = resolve(tempDir, "askpass.sh");
    await writeFile(
      askPassPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        "*Username*) printf '%s\\n' \"$EXPERTMESH_GIT_USERNAME\" ;;",
        "*Password*) printf '%s\\n' \"$EXPERTMESH_GIT_TOKEN\" ;;",
        "*) printf '\\n' ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(askPassPath, 0o700);

    return {
      env: {
        ...sharedEnv,
        GIT_ASKPASS: askPassPath,
        EXPERTMESH_GIT_USERNAME: auth.username,
        EXPERTMESH_GIT_TOKEN: auth.token ?? readRequiredEnv(baseEnv, auth.tokenEnv),
        HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      },
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  if (auth.strategy === "credential_helper") {
    const gitConfigPath = resolve(tempDir, "gitconfig");
    const credentialHelper = auth.helper ?? readRequiredEnv(baseEnv, auth.helperEnv);
    assertSafeCredentialHelperValue(credentialHelper, auth.helperEnv ?? "configured helper");
    await writeFile(
      gitConfigPath,
      ["[credential]", `\thelper = ${escapeGitConfigValue(credentialHelper)}`, ""].join("\n"),
      { mode: 0o600 },
    );

    return {
      env: {
        ...sharedEnv,
        GIT_CONFIG_GLOBAL: gitConfigPath,
        HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      },
      cleanup: async () => {
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  const privateKeyPath = resolve(tempDir, "identity");
  const knownHostsEnv = auth.knownHostsEnv;
  const knownHosts = auth.knownHosts ?? readOptionalEnv(baseEnv, knownHostsEnv);
  const knownHostsPath = knownHosts === undefined ? undefined : resolve(tempDir, "known_hosts");
  await writeFile(privateKeyPath, auth.privateKey ?? readRequiredEnv(baseEnv, auth.privateKeyEnv), {
    mode: 0o600,
  });
  await chmod(privateKeyPath, 0o600);

  if (knownHostsPath !== undefined && knownHosts !== undefined) {
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
        "StrictHostKeyChecking=yes",
        ...(knownHostsPath === undefined
          ? []
          : ["-o", `UserKnownHostsFile=${shellQuote(knownHostsPath)}`]),
      ].join(" "),
      HOME: tempDir,
      XDG_CONFIG_HOME: tempDir,
    },
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function applyGitEnvironment(
  env: NodeJS.ProcessEnv,
  values: Readonly<Record<string, string>>,
): () => void {
  const previousValues = new Map<string, string | undefined>();

  for (const [name, value] of Object.entries(values)) {
    previousValues.set(name, env[name]);
    env[name] = value;
  }

  return () => {
    for (const [name, value] of previousValues) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
  };
}

async function execGit(
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const gitCommand = options.gitCommand ?? "git";
  const result = await execFileAsync(gitCommand, createSafeGitArgs(args), {
    env: options.env,
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

function createGitProcessEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...(baseEnv.PATH === undefined ? {} : { PATH: baseEnv.PATH }),
    ...(baseEnv.LANG === undefined ? {} : { LANG: baseEnv.LANG }),
    ...(baseEnv.LC_ALL === undefined ? {} : { LC_ALL: baseEnv.LC_ALL }),
    ...(baseEnv.SystemRoot === undefined ? {} : { SystemRoot: baseEnv.SystemRoot }),
    ...(baseEnv.windir === undefined ? {} : { windir: baseEnv.windir }),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

function assertAuthEnvironment(auth: CodeRepositoryAuth, env: NodeJS.ProcessEnv): void {
  if (
    auth.strategy === "token" &&
    auth.token === undefined &&
    auth.tokenEnv !== undefined &&
    readEnv(env, auth.tokenEnv) === undefined
  ) {
    throw new Error(`Missing Git token environment variable: ${auth.tokenEnv}`);
  }

  if (
    auth.strategy === "ssh" &&
    auth.privateKey === undefined &&
    auth.privateKeyEnv !== undefined &&
    readEnv(env, auth.privateKeyEnv) === undefined
  ) {
    throw new Error(`Missing Git SSH private key environment variable: ${auth.privateKeyEnv}`);
  }

  if (
    auth.strategy === "ssh" &&
    auth.knownHosts === undefined &&
    auth.knownHostsEnv !== undefined &&
    readEnv(env, auth.knownHostsEnv) === undefined
  ) {
    throw new Error(`Missing Git known_hosts environment variable: ${auth.knownHostsEnv}`);
  }

  if (
    auth.strategy === "credential_helper" &&
    auth.helper === undefined &&
    auth.helperEnv !== undefined &&
    readEnv(env, auth.helperEnv) === undefined
  ) {
    throw new Error(`Missing Git credential.helper environment variable: ${auth.helperEnv}`);
  }
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string | undefined): string {
  if (name === undefined) {
    throw new Error("Missing environment variable name.");
  }

  const value = readEnv(env, name);

  if (value === undefined) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function readOptionalEnv(env: NodeJS.ProcessEnv, name: string | undefined): string | undefined {
  return name === undefined ? undefined : readEnv(env, name);
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
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

function escapeGitConfigValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")}"`;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}
