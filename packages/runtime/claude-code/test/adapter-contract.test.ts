import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AcpRuntimeSession,
  DefineAcpRuntimeDriverOptions,
  RuntimeFeatureSet,
  RuntimeNativeSessionContext,
} from "@pragma/core";
import { describeRuntimeConformance } from "@pragma/core/testing/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: undefined as DefineAcpRuntimeDriverOptions<RuntimeFeatureSet> | undefined,
}));
vi.mock("@pragma/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pragma/core")>();
  return {
    ...actual,
    defineAcpRuntimeDriver(...args: Parameters<typeof actual.defineAcpRuntimeDriver>) {
      captured.options = args[0];
      return actual.defineAcpRuntimeDriver(...args);
    },
  };
});
import { createClaudeCodeRuntime } from "../src/index.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describeRuntimeConformance("Claude Code ACP", { createRuntime: createClaudeCodeRuntime });
describe("Claude Code ACP contract", () => {
  it("retains runtime identity and enables steering", () => {
    const runtime = createClaudeCodeRuntime();
    expect(runtime.descriptor).toMatchObject({
      id: "claude-code-local",
      kind: "claude-code-local",
      capabilities: {
        supportsResume: true,
        supportsCancel: true,
        supportsClose: true,
        supportsSteer: true,
        supportsManualCompaction: true,
        supportsContextCompactionEvents: true,
      },
    });
    expect(runtime.features.steering.status).toBe("degraded");
  });
  it.each([false, true])(
    "restores model and effort defaults after turn overrides (explicit default: %s)",
    async (explicit) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-claude-acp-model-"));
      roots.push(root);
      const catalog = ["sonnet", "opus"].map((id) => ({
        id,
        displayName: id,
        provider: { id: "anthropic", kind: "runtime-managed" as const, displayName: "Claude" },
        thinking: { supportedLevels: ["low", "high"].map((value) => ({ value, label: value })) },
        default: id === "sonnet",
      }));
      createClaudeCodeRuntime({
        spawn: vi.fn(),
        acpWorkerPath: "/pragma/worker.js",
        listModels: async () => catalog,
        ...(explicit ? { defaultModelName: "sonnet", defaultThinkingLevel: "low" } : {}),
      });
      const binding = await captured.options!.prepare(context(root));
      expect(binding.promptUsageScope).toBe("turn");
      const session = {
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "default" },
          { id: "effort", category: "thought_level", type: "select", currentValue: "default" },
        ],
        setConfig: vi.fn(async () => {}),
      } as unknown as AcpRuntimeSession;
      await binding.onReady?.(session);
      await binding.selectModel?.(session, {
        model: { providerId: "anthropic", modelId: "opus" },
        thinkingLevel: "high",
      });
      vi.mocked(session.setConfig).mockClear();
      await binding.selectModel?.(session, undefined);
      expect(session.setConfig).toHaveBeenCalledWith("model", explicit ? "sonnet" : "default");
      expect(session.setConfig).toHaveBeenCalledWith("thought_level", explicit ? "low" : "default");
      vi.mocked(session.setConfig).mockClear();
      await binding.selectModel?.(session, { model: { providerId: "anthropic", modelId: "opus" } });
      expect(session.setConfig).toHaveBeenCalledWith("thought_level", explicit ? "low" : "default");
    },
  );
  it("projects only managed config, plugin and MCP into ACP", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-claude-acp-contract-"));
    roots.push(root);
    createClaudeCodeRuntime({
      executablePath: "/opt/claude",
      spawn: vi.fn(),
      acpWorkerPath: "/pragma/claude-acp-worker.js",
    });
    const binding = await captured.options!.prepare(context(root));
    expect(binding.command.args).toEqual(["/pragma/claude-acp-worker.js"]);
    expect(binding.command.env).toMatchObject({
      CLAUDE_CODE_EXECUTABLE: "/opt/claude",
      CLAUDE_CONFIG_DIR: join(root, "session/config"),
    });
    expect(binding.session).toMatchObject({
      cwd: root,
      mcpServers: [{ type: "http", name: "pragma", url: "http://127.0.0.1/private/mcp" }],
      _meta: {
        systemPrompt: { append: "managed system" },
        claudeCode: {
          options: {
            settingSources: [],
            strictMcpConfig: true,
            extraArgs: { bare: null, "strict-mcp-config": null },
            plugins: [{ type: "local", path: join(root, "session/plugin") }],
          },
        },
      },
    });
    const active = { usage: undefined };
    const session = { sessionId: "owned", active } as unknown as AcpRuntimeSession;
    for (let index = 0; index < 2; index++)
      binding.extensionNotifications?.["_claude/sdkMessage"]?.(
        {
          sessionId: "owned",
          message: {
            type: "result",
            usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1 },
          },
        },
        session,
      );
    expect(active.usage).toMatchObject({
      measurement: "reported",
      input: 4,
      output: 6,
      cacheRead: 2,
    });
  });
});
function context(root: string): RuntimeNativeSessionContext {
  return {
    workspace: root,
    processEnvironment: { CLAUDE_CONFIG_DIR: join(root, "host-config") },
    persistence: { spec: { sessionDir: join(root, "session") } },
    paths: { runtimeSessionDir: () => join(root, "session") },
    request: {},
    logger: { warn: vi.fn() },
    agentContext: { systemPrompt: "managed system" },
    features: {
      skills: {
        pluginDir: join(root, "session/plugin"),
        relay: { subscribe: vi.fn(() => vi.fn()) },
      },
      mcp: { registration: { url: "http://127.0.0.1/private/mcp" } },
    },
  } as unknown as RuntimeNativeSessionContext;
}
