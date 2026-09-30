import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runAssetGit(
  root: string,
  args: readonly string[],
  options: { readonly maxBuffer?: number } = {},
): Promise<string> {
  const env = await assetGitEnvironment(root);
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      timeout: 60_000,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      env,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    // Keep stderr first: command wrappers and long remote URLs can otherwise
    // consume the overview's bounded error message before the actual cause.
    if (error instanceof Error) {
      const failure = error as Error & {
        stderr?: string;
        code?: string | number;
        killed?: boolean;
      };
      const reason =
        failure.code === "ENOENT"
          ? "Git executable not found (ENOENT)."
          : failure.killed
            ? `Git operation timed out.${failure.stderr?.trim() ? `\n${failure.stderr.trim()}` : ""}`
            : failure.stderr?.trim() || failure.message;
      failure.message = `Git ${args[0] ?? "operation"} failed: ${reason}`;
    }
    throw error;
  }
}

async function assetGitEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (env.GIT_SSH_COMMAND !== undefined || env.GIT_SSH !== undefined) return env;
  const configured = await execFileAsync(
    "git",
    ["-C", root, "config", "--get", "core.sshCommand"],
    {
      timeout: 60_000,
      maxBuffer: 1_000_000,
      env,
    },
  )
    .then(({ stdout }) => stdout.trim() !== "")
    .catch(() => false);
  return configured ? env : { ...env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
}

export async function assertAssetGitIdentity(root: string): Promise<void> {
  const [name, email] = await Promise.all([
    runAssetGit(root, ["config", "--get", "user.name"]).catch(() => ""),
    runAssetGit(root, ["config", "--get", "user.email"]).catch(() => ""),
  ]);
  if (!name.trim() || !email.trim()) {
    throw new Error("Set Git user.name and user.email before publishing this asset.");
  }
}
