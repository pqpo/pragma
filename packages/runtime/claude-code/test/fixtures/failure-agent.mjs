import { createInterface } from "node:readline";
import process from "node:process";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const result = (id, value) => send({ id, result: value });
const sessionId = "owned-failure-session";
const configOptions = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "bypassPermissions",
    options: [{ value: "bypassPermissions", name: "Bypass" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [{ value: "sonnet", name: "Sonnet" }],
  },
];
let prompts = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.method) continue;
  switch (request.method) {
    case "initialize":
      result(request.id, {
        protocolVersion: 1,
        agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } },
      });
      break;
    case "session/new":
      result(request.id, { sessionId, configOptions });
      break;
    case "session/set_config_option":
      result(request.id, { configOptions });
      break;
    case "session/prompt": {
      const mode = process.env.FAILURE_MODE;
      if (mode === "session-rate" && prompts === 2) {
        process.stderr.write("worker crashed: new diagnostic", () => process.exit(7));
        break;
      }
      if (prompts++ > 0 || mode === "warning") {
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "recovered" },
            },
          },
        });
        result(request.id, {
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
        });
      } else if (mode.startsWith("exit-")) {
        process.stderr.write(
          mode === "exit-auth"
            ? "Invalid API key: provider diagnostic"
            : mode === "exit-rate"
              ? "HTTP 429 rate limit: provider diagnostic"
              : "worker crashed: provider diagnostic",
          () => process.exit(7),
        );
      } else {
        const auth = mode === "session-auth";
        const _meta = {
          jetbrains: {
            air: {
              version: 1,
              sessionFailure: {
                id: "failure-1",
                revision: 1,
                category: auth ? "access" : "limit",
                severity: "error",
                title: auth ? "Sign in" : "Rate limited",
                details: "structured provider diagnostic",
                actions: [auth ? "login" : "retry"],
              },
            },
          },
        };
        // Conflicting stderr must not override the structured rate-limit result.
        if (!auth) process.stderr.write("Invalid API key: unrelated stderr\n");
        if (auth) {
          send({
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "session_info_update", _meta } },
          });
          send({ id: request.id, error: { code: -32000, message: "Authentication required" } });
        } else
          result(request.id, {
            stopReason: "end_turn",
            _meta,
            usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
          });
      }
      break;
    }
    case "session/close":
      result(request.id, {});
      process.exit(0);
      break;
    default:
      result(request.id, {});
  }
}
