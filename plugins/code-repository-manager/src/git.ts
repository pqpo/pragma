import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { CodeRepository, CodeRepositoryAuth, CodeRepositoryManagerConfig } from "./schema.ts";
import { defaultRepositoryWorkspacePath } from "./document.ts";

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
  readonly gitCommand?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface GitPrepareResult {
  readonly gitVersion: string;
  readonly authStrategy: CodeRepositoryAuth["strategy"];
  readonly repositoryCount: number;
}

export interface EnsureRepositoryOptions extends GitCommandOptions {
  readonly repoId: string;
  readonly workspaceRoot: string;
}

export interface EnsureRepositoryResult {
  readonly repoId: string;
  readonly path: string;
  readonly action: "cloned" | "fetched";
  readonly branch: string;
}

export async function prepareGitEnvironment(
  config: CodeRepositoryManagerConfig,
  options: GitCommandOptions = {},
): Promise<GitPrepareResult> {
  const gitVersion = await checkGitCli(options);
  assertAuthEnvironment(config.auth, options.env ?? process.env);

  return {
    gitVersion,
    authStrategy: config.auth.strategy,
    repositoryCount: config.repositories.length,
  };
}

export async function checkGitCli(options: GitCommandOptions = {}): Promise<string> {
  const result = await execGit(["--version"], {
    ...options,
    env: createGitProcessEnv(options.env ?? process.env),
  });
  return result.stdout.trim();
}

export async function ensureRepository(
  config: CodeRepositoryManagerConfig,
  options: EnsureRepositoryOptions,
): Promise<EnsureRepositoryResult> {
  const repository = findRepository(config, options.repoId);
  const targetPath = resolveRepositoryWorkspacePath(options.workspaceRoot, repository);
  const branch = repository.defaultBranch;
  const baseEnv = options.env ?? process.env;
  const safeOptions = {
    ...options,
    env: createGitProcessEnv(baseEnv),
  };

  assertAuthEnvironment(config.auth, baseEnv);
  await mkdir(options.workspaceRoot, { recursive: true });

  if (await pathExists(targetPath)) {
    await assertRealPathInsideWorkspace(options.workspaceRoot, targetPath, repository.id);
    await assertExistingRepository(targetPath, safeOptions);
    await assertRepositoryOrigin(targetPath, repository, safeOptions);

    await withGitAuthEnvironment(config.auth, baseEnv, async (env) => {
      await execGit(["-C", targetPath, "fetch", "origin", branch], { ...options, env });
    });
    await execGit(["-C", targetPath, "checkout", branch], safeOptions);
    await execGit(["-C", targetPath, "merge", "--ff-only", `origin/${branch}`], safeOptions);

    return {
      repoId: repository.id,
      path: targetPath,
      action: "fetched",
      branch,
    };
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await assertRealPathInsideWorkspace(options.workspaceRoot, dirname(targetPath), repository.id);
  await withGitAuthEnvironment(config.auth, baseEnv, async (env) => {
    await execGit(createCloneArgs(repository, targetPath), { ...options, env });
  });

  return {
    repoId: repository.id,
    path: targetPath,
    action: "cloned",
    branch,
  };
}

export function resolveRepositoryWorkspacePath(
  workspaceRoot: string,
  repository: Pick<CodeRepository, "id" | "workspacePath">,
): string {
  const workspace = resolve(workspaceRoot);
  const configuredPath = repository.workspacePath ?? defaultRepositoryWorkspacePath(repository);
  const target = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(workspace, configuredPath);
  const relativePath = relative(workspace, target);

  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Repository workspacePath must stay inside workspace: ${repository.id}`);
  }

  return target;
}

async function assertRealPathInsideWorkspace(
  workspaceRoot: string,
  path: string,
  repoId: string,
): Promise<void> {
  const workspace = await realpath(workspaceRoot);
  const target = await realpath(path);
  const relativePath = relative(workspace, target);

  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Repository path must resolve inside workspace: ${repoId}`);
  }
}

function findRepository(config: CodeRepositoryManagerConfig, repoId: string): CodeRepository {
  const repository = config.repositories.find((candidate) => candidate.id === repoId);

  if (repository === undefined) {
    throw new Error(`Unknown repository id: ${repoId}`);
  }

  return repository;
}

function createCloneArgs(repository: CodeRepository, targetPath: string): readonly string[] {
  return [
    "clone",
    ...(repository.shallowClone ? ["--depth", "1"] : []),
    "--branch",
    repository.defaultBranch,
    "--",
    repository.cloneUrl,
    targetPath,
  ];
}

async function assertExistingRepository(
  targetPath: string,
  options: GitCommandOptions,
): Promise<void> {
  try {
    await execGit(["-C", targetPath, "rev-parse", "--is-inside-work-tree"], options);
  } catch (error) {
    throw new Error(`Target path exists but is not a Git repository: ${targetPath}`, {
      cause: error,
    });
  }
}

async function assertRepositoryOrigin(
  targetPath: string,
  repository: CodeRepository,
  options: GitCommandOptions,
): Promise<void> {
  const result = await execGit(["-C", targetPath, "remote", "get-url", "origin"], options);
  const origin = result.stdout.trim();

  if (origin !== repository.cloneUrl) {
    throw new Error(`Existing repository origin does not match configured cloneUrl: ${repository.id}`);
  }
}

function assertAuthEnvironment(auth: CodeRepositoryAuth, env: NodeJS.ProcessEnv): void {
  if (auth.strategy === "token" && readEnv(env, auth.tokenEnv) === undefined) {
    throw new Error(`Missing Git token environment variable: ${auth.tokenEnv}`);
  }

  if (auth.strategy === "ssh" && readEnv(env, auth.privateKeyEnv) === undefined) {
    throw new Error(`Missing Git SSH private key environment variable: ${auth.privateKeyEnv}`);
  }

  if (
    auth.strategy === "ssh" &&
    auth.knownHostsEnv !== undefined &&
    readEnv(env, auth.knownHostsEnv) === undefined
  ) {
    throw new Error(`Missing Git known_hosts environment variable: ${auth.knownHostsEnv}`);
  }
}

async function withGitAuthEnvironment<TValue>(
  auth: CodeRepositoryAuth,
  baseEnv: NodeJS.ProcessEnv,
  run: (env: NodeJS.ProcessEnv) => Promise<TValue>,
): Promise<TValue> {
  if (auth.strategy === "none") {
    return await run({
      ...createGitProcessEnv(baseEnv),
      GIT_TERMINAL_PROMPT: "0",
    });
  }

  const tempDir = await mkdtemp(resolve(tmpdir(), "expertmesh-git-"));

  try {
    if (auth.strategy === "token") {
      const askPassPath = resolve(tempDir, "askpass.sh");
      await writeFile(
        askPassPath,
        [
          "#!/bin/sh",
          "case \"$1\" in",
          "*Username*) printf '%s\\n' \"$EXPERTMESH_GIT_USERNAME\" ;;",
          "*Password*) printf '%s\\n' \"$EXPERTMESH_GIT_TOKEN\" ;;",
          "*) printf '\\n' ;;",
          "esac",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await chmod(askPassPath, 0o700);

      return await run({
        ...createGitProcessEnv(baseEnv),
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: "0",
        EXPERTMESH_GIT_USERNAME: auth.username,
        EXPERTMESH_GIT_TOKEN: readRequiredEnv(baseEnv, auth.tokenEnv),
        HOME: tempDir,
        XDG_CONFIG_HOME: tempDir,
      });
    }

    const privateKeyPath = resolve(tempDir, "identity");
    const knownHostsEnv = auth.knownHostsEnv;
    const knownHostsPath = knownHostsEnv === undefined ? undefined : resolve(tempDir, "known_hosts");
    await writeFile(privateKeyPath, readRequiredEnv(baseEnv, auth.privateKeyEnv), { mode: 0o600 });
    await chmod(privateKeyPath, 0o600);

    if (knownHostsPath !== undefined && knownHostsEnv !== undefined) {
      await writeFile(knownHostsPath, readRequiredEnv(baseEnv, knownHostsEnv), {
        mode: 0o600,
      });
    }

    return await run({
      ...createGitProcessEnv(baseEnv),
      GIT_TERMINAL_PROMPT: "0",
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
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.file.allow=never",
    ...args,
  ];
}

function createGitProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = readEnv(env, name);

  if (value === undefined) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
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
