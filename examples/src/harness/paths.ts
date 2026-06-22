import { config as loadEnv } from "dotenv";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const examplesDir = resolve(scriptDir, "../..");
export const repositoryRoot = resolve(examplesDir, "..");
export const defaultWorkspaceRoot = resolve(repositoryRoot, "workspace");

export function loadExamplesEnv(): void {
  loadEnv({
    path: resolve(examplesDir, ".env"),
    quiet: true,
  });
}

export function resolveExamplePath(path: string): string {
  return resolve(repositoryRoot, path);
}

export async function ensureWorkspaceDir(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
}
