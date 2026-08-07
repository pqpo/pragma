import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ANTIGRAVITY_WORKSPACE_CUSTOMIZATION_ROOTS = [
  ".agents",
  ".agent",
  "_agents",
  "_agent",
] as const;

/**
 * The public agy CLI discovers workspace customizations before Pragma's
 * managed PreToolUse relay can govern them. In particular, hooks and MCP
 * entries from these roots can run arbitrary same-user processes. Until agy
 * exposes an isolation switch, reject them rather than letting a repository
 * escape the Runtime's managed HOME, MCP allowlist, or approval boundary.
 */
export async function assertAntigravityWorkspaceCustomizationsAreIsolated(
  workspace: string,
): Promise<void> {
  const resolvedWorkspace = resolve(workspace);
  for (const name of ANTIGRAVITY_WORKSPACE_CUSTOMIZATION_ROOTS) {
    const candidate = join(resolvedWorkspace, name);
    try {
      await lstat(candidate);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw new Error(
        `Antigravity Runtime could not inspect workspace customization path ${candidate}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    throw new Error(
      `Antigravity Runtime refuses workspace customization root ${candidate}. agy loads workspace hooks, MCP servers, agents, and plugins outside Pragma's managed Runtime boundary. Move the required configuration into the Pragma Expert or use an isolated workspace.`,
    );
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
