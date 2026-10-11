import packageManifest from "@agentclientprotocol/claude-agent-acp/package.json" with { type: "json" };
import { runAcp } from "@agentclientprotocol/claude-agent-acp";
import { applyManagedPolicyEnv } from "@agentclientprotocol/claude-agent-acp/dist/managed-policy.js";
import { installClaudeAcpEditedInput } from "./acp-permissions.ts";

// The worker has already entered Electron's Node mode. Its external CLI and tools must not inherit it.
delete process.env["ELECTRON_RUN_AS_NODE"];

if (process.argv.includes("--version")) {
  process.stdout.write(`${packageManifest.version}\n`);
  process.exit(0);
}

// Never let upstream discover its SDK-bundled CLI. The Host must supply the
// external CLI it resolved/probed; absence is a configuration error, not fallback.
const externalCli = process.env["CLAUDE_CODE_EXECUTABLE"];
if (!externalCli?.trim()) {
  console.error(
    "Claude Code CLI is unavailable. Install Claude Code yourself or correct the configured executable path.",
  );
  process.exit(1);
}

// stdout belongs exclusively to ACP. Match the upstream executable's policy
// initialization and shutdown while adding the Host's edited-input extension.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
await applyManagedPolicyEnv();
// Managed policy can merge environment values; keep the startup-only switch private to this worker.
delete process.env["ELECTRON_RUN_AS_NODE"];
// Policy env may replace or clear this variable. Keep the command selected by
// the Host instead of allowing an unvalidated command or SDK fallback.
process.env["CLAUDE_CODE_EXECUTABLE"] = externalCli;
const { connection, agent } = runAcp();
installClaudeAcpEditedInput(agent);
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await agent
    .dispose()
    .catch((error: unknown) => console.error("Claude ACP cleanup failed", error));
  process.exit(0);
}
void connection.closed.then(shutdown);
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.stdin.resume();
