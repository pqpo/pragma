import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runAssetGit(
  root: string,
  args: readonly string[],
  options: { readonly maxBuffer?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    timeout: 60_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
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
