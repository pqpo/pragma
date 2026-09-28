import { describe, expect, it, vi } from "vitest";
import type { AcpRuntimeSession } from "@pragma/core";

import { createClaudeCompactionHookRelay } from "../src/compaction-hooks.ts";
import { createClaudeAcpBinding } from "../src/session.ts";

describe("Claude Code compaction hook relay", () => {
  it("correlates authenticated PreCompact and PostCompact hooks", async () => {
    const relay = await createClaudeCompactionHookRelay();
    const received = vi.fn();
    const unsubscribe = relay.subscribe(received);
    try {
      const headers = {
        Authorization: relay.authorization,
        "Content-Type": "application/json",
      };
      const before = await fetch(relay.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "PreCompact",
          session_id: "session-1",
          trigger: "auto",
        }),
      });
      const after = await fetch(relay.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "PostCompact",
          session_id: "session-1",
          trigger: "auto",
        }),
      });

      expect(before.status).toBe(204);
      expect(after.status).toBe(204);
      expect(received).toHaveBeenCalledTimes(2);
      const started = received.mock.calls[0]?.[0];
      const completed = received.mock.calls[1]?.[0];
      expect(started).toMatchObject({
        stage: "context.compaction.started",
        trigger: "auto",
      });
      expect(completed).toMatchObject({
        operationId: started.operationId,
        stage: "context.compaction.completed",
        trigger: "auto",
      });
    } finally {
      unsubscribe();
      await relay.close();
    }
  });

  it("rejects unauthenticated hook requests", async () => {
    const relay = await createClaudeCompactionHookRelay();
    try {
      const response = await fetch(relay.url, {
        method: "POST",
        body: JSON.stringify({
          hook_event_name: "PreCompact",
          session_id: "session-1",
          trigger: "auto",
        }),
      });
      expect(response.status).toBe(404);
    } finally {
      await relay.close();
    }
  });

  it("fails a started operation when the Runtime turn ends before PostCompact", async () => {
    const relay = await createClaudeCompactionHookRelay();
    const received = vi.fn();
    const unsubscribe = relay.subscribe(received);
    try {
      const response = await fetch(relay.url, {
        method: "POST",
        headers: {
          Authorization: relay.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hook_event_name: "PreCompact",
          session_id: "session-1",
          trigger: "auto",
        }),
      });
      expect(response.status).toBe(204);

      const binding = createClaudeAcpBinding({
        options: { acpWorkerPath: "/pragma/worker.js" },
        workspace: "/pragma/workspace",
        systemPrompt: "managed system",
        managedConfig: { configDir: "/pragma/config" },
        cli: { executablePath: "/pragma/claude", launcherArgs: [] },
        processEnvironment: {},
        pluginDir: "/pragma/plugin",
        mcpServerUrl: "http://127.0.0.1/mcp",
        relay,
        humanInteractionHandler: undefined,
        defaultSelection: undefined,
      });
      binding.onTurnSettled?.({} as AcpRuntimeSession);

      const started = received.mock.calls[0]?.[0];
      expect(received).toHaveBeenLastCalledWith({
        type: "pragma_context_compaction",
        operationId: started.operationId,
        stage: "context.compaction.failed",
        trigger: "auto",
        errorMessage: "Claude Code ended before context compaction completed.",
      });
      binding.onTurnSettled?.({} as AcpRuntimeSession);
      expect(received).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      await relay.close();
    }
  });
});
