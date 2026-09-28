import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundlers may move this module into a shared chunk. The worker is always a
 * sibling entry in the host's output directory, and executable outside ASAR. */
export function resolveClaudeAcpWorkerPath(override?: string): string {
  if (override !== undefined) return override;
  const source = fileURLToPath(import.meta.url).replace(/\.asar([/\\])/u, ".asar.unpacked$1");
  const name = `claude-acp-worker.${source.endsWith(".ts") ? "ts" : "js"}`;
  const candidates = [join(dirname(source), name), join(dirname(source), "..", name)];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined)
    throw new Error("Bundled Claude ACP worker is missing. Rebuild or reinstall Pragma.");
  return path;
}
