import { createInterface } from "node:readline";
import process from "node:process";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const accumulatedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const result = (id, value) => {
  if (value.usage && process.env.USAGE_SCOPE !== "turn") {
    for (const key of Object.keys(accumulatedUsage)) accumulatedUsage[key] += value.usage[key] ?? 0;
    value = { ...value, usage: { ...accumulatedUsage } };
  }
  send({ id, result: value });
};
const update = (value) =>
  send({ method: "session/update", params: { sessionId: "owned-native-session", update: value } });
const text = (text) =>
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const configOptions = [
  {
    id: "mode",
    category: "mode",
    name: "Mode",
    type: "select",
    currentValue: "default",
    options: ["default", "bypassPermissions"].map((value) => ({ value, name: value })),
  },
  {
    id: "model",
    category: "model",
    name: "Model",
    type: "select",
    currentValue: "sonnet",
    options: ["sonnet", "opus"].map((value) => ({ value, name: value })),
  },
  {
    id: "effort",
    category: "thought_level",
    name: "Effort",
    type: "select",
    currentValue: "high",
    options: [{ value: "high", name: "High" }],
  },
];
let active;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === undefined) continue;
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize":
      result(request.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
          promptCapabilities: { image: true },
          sessionCapabilities: { close: {} },
        },
        _meta: { steering: { supported: process.env.STEERING !== "unsupported" } },
      });
      break;
    case "session/new":
      result(request.id, { sessionId: "owned-native-session", configOptions });
      break;
    case "session/load":
      update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "historical input" },
      });
      text("historical answer");
      result(request.id, { configOptions });
      break;
    case "session/set_config_option":
      result(request.id, { configOptions });
      break;
    case "session/prompt": {
      const input = params.prompt.map((block) => block.text ?? block.type).join(" ");
      if (input.includes("inspect-startup")) {
        text(JSON.stringify(params.prompt));
        result(request.id, {
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
        });
        break;
      }
      if (input === "/compact") {
        update({ sessionUpdate: "usage_update", used: 10, size: 10_000 });
        text("compact noise");
        result(request.id, { stopReason: "end_turn" });
        break;
      }
      if (input.includes("failed-with-usage")) {
        send({ method: "_test/usage", params: {} });
        accumulatedUsage.inputTokens += 5;
        accumulatedUsage.outputTokens += 4;
        accumulatedUsage.totalTokens += 9;
        send({
          id: request.id,
          error: { code: -32603, message: "provider failed after reporting usage" },
        });
        break;
      }
      if (input.includes("crash")) {
        process.exit(7);
      }
      active = request.id;
      if (!input.includes("empty-prelude")) {
        update({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        });
        text("working");
      }
      update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        name: "Read",
        title: "Read file",
        status: "pending",
        rawInput: input.includes("string-input")
          ? "/file"
          : input.includes("array-input")
            ? ["/file", "/other"]
            : input.includes("null-input")
              ? null
              : { path: "/file" },
        content: [{ type: "content", content: { type: "text", text: "half" } }],
      });
      if (input.includes("parallel-tools")) {
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tool-2",
          name: "Search",
          title: "Search context",
          status: "pending",
          rawInput: { query: "test" },
        });
      }
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "contents",
        content: [{ type: "content", content: { type: "text", text: "half done" } }],
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "half done" } }],
      });
      if (input.includes("parallel-tools")) {
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-2",
          status: "completed",
          rawOutput: "found",
        });
      }
      if (input.includes("human")) {
        send({
          id: "approval-1",
          method: "session/request_permission",
          params: {
            sessionId: "owned-native-session",
            toolCall: { toolCallId: "human-tool", title: "Bash" },
            options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
          },
        });
      }
      if (input.includes("multi-tool")) {
        update({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "searching" },
        });
        text("checking");
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tool-2",
          name: "Search",
          title: "Search context",
          status: "pending",
          rawInput: { query: "test" },
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-2",
          status: "completed",
          rawOutput: "found",
        });
      }
      if (!input.includes("hold")) {
        if (!input.includes("no-final")) {
          text(input.includes("json-final") ? '{"answer":"done"}' : "answer");
        }
        result(active, {
          stopReason: input.includes("limited") ? "max_tokens" : "end_turn",
          ...(input.includes("estimated")
            ? {}
            : { usage: { totalTokens: 9, inputTokens: 5, outputTokens: 4 } }),
        });
        active = undefined;
      }
      break;
    }
    case "_session/steering":
      if (params._meta?.steering?.idleBehavior !== "promptRequired")
        throw new Error("Host idle behavior missing");
      if (process.env.STEERING === "timeout") break;
      if (process.env.STEERING === "disconnect") process.exit(8);
      if (process.env.STEERING === "promptRequired" || active === undefined) {
        result(request.id, { outcome: "promptRequired", reason: "noRunningTurn" });
        break;
      }
      if (process.env.STEERING === "detached") {
        result(request.id, { outcome: "startedNewTurn" });
        break;
      }
      result(request.id, { outcome: "injected" });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "steered" } });
      text(params.prompt[0].text);
      if (!params.prompt[0].text.includes("keep running")) {
        result(active, {
          stopReason: "end_turn",
          usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
        });
        active = undefined;
      }
      break;
    case "session/cancel":
      if (process.env.STEERING === "uncancellable") break;
      if (active !== undefined) {
        result(active, { stopReason: "cancelled" });
        active = undefined;
      }
      break;
    case "session/close":
      result(request.id, {});
      process.exit(0);
      break;
    default:
      result(request.id, {});
  }
}
