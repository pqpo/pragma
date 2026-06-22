import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

export const testScriptDir = resolve(scriptDir, "../..");
export const workspaceRoot = resolve(testScriptDir, "..");

export function loadTestScriptEnv(): void {
  loadEnv({
    path: resolve(testScriptDir, ".env"),
    quiet: true,
  });
}

export function readCliQuery(defaultQuery: string): string {
  return process.argv.slice(2).join(" ").trim() || defaultQuery;
}
