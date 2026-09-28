import packageManifest from "@agentclientprotocol/claude-agent-acp/package.json" with { type: "json" };
import { runAcp } from "@agentclientprotocol/claude-agent-acp";
import { applyManagedPolicyEnv } from "@agentclientprotocol/claude-agent-acp/dist/managed-policy.js";
import { installClaudeAcpEditedInput } from "./acp-permissions.ts";

if (process.argv.includes("--version")) {
  process.stdout.write(`${packageManifest.version}\n`);
  process.exit(0);
}

// stdout belongs exclusively to ACP. Match the upstream executable's policy
// initialization and shutdown while adding the Host's edited-input extension.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;
await applyManagedPolicyEnv();
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
