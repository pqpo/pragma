import { describe, expect, it, vi } from "vitest";
import type { AcpRuntimeSession } from "@pragma/core";

import {
  createClaudeCompactionHookRelay,
  type ClaudeCompactionHookRelay,
} from "../src/compaction-hooks.ts";
import { createClaudeAcpBinding } from "../src/session.ts";

describe("Claude Code compaction hook relay", () => {
  it("ignores idle replay boundaries and publishes live automatic compaction", async () => {
    const relay = await createClaudeCompactionHookRelay();
    const received = vi.fn();
    relay.subscribe(received);
    const binding = createBinding(relay);
    const session = { sessionId: "owned", active: undefined } as unknown as AcpRuntimeSession;
    const boundary = {
      sessionId: "owned",
      message: {
        type: "system",
        subtype: "compact_boundary",
        session_id: "owned",
        compact_metadata: { trigger: "auto" },
      },
    };
    try {
      binding.extensionNotifications?.["_claude/sdkMessage"]?.(boundary, session);
      expect(received).not.toHaveBeenCalled();
      session.active = {} as NonNullable<AcpRuntimeSession["active"]>;
      binding.extensionNotifications?.["_claude/sdkMessage"]?.(boundary, session);
      expect(received).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ stage: "context.compaction.completed", trigger: "auto" }),
      );
    } finally {
      await relay.close();
    }
  });
  it("cancels outstanding completion waits when the relay closes", async () => {
    const relay = await createClaudeCompactionHookRelay();
    const wait = relay.waitForCompaction("owned");
    const cancelled = expect(wait.completed).rejects.toThrow("cancelled");
    await relay.close();
    await cancelled;
    wait.dispose();
  });
  it.each([
    "matched",
    "native-boundary",
    "foreign-boundary",
    "auto-boundary",
    "boundary-rpc-failure",
    "none",
    "pre-only",
    "post-only",
    "other-session",
  ])("accepts manual compaction only with matching hooks: %s", async (mode) => {
    const relay = await createClaudeCompactionHookRelay();
    const received = vi.fn();
    relay.subscribe(received);
    const wait = relay.waitForCompaction.bind(relay);
    vi.spyOn(relay, "waitForCompaction").mockImplementation((id) => wait(id, 500));
    const binding = createBinding(relay);
    const close = vi.fn(async () => {});
    const session = {
      sessionId: "owned",
      close,
      normalizeError: (error: unknown) => error,
      connection: {
        agent: {
          request: vi.fn(async () => {
            if (mode.endsWith("boundary") || mode === "boundary-rpc-failure")
              binding.extensionNotifications?.["_claude/sdkMessage"]?.(
                {
                  sessionId: "owned",
                  message: {
                    type: "system",
                    subtype: "compact_boundary",
                    session_id: mode === "foreign-boundary" ? "other" : "owned",
                    compact_metadata: { trigger: mode === "auto-boundary" ? "auto" : "manual" },
                  },
                },
                session,
              );
            if (mode === "boundary-rpc-failure") throw new Error("compact RPC failed");
            const id = mode === "other-session" ? "other" : "owned";
            if (["matched", "pre-only", "other-session"].includes(mode))
              await hook(relay, id, "PreCompact");
            if (["matched", "post-only", "other-session"].includes(mode))
              await hook(relay, id, "PostCompact");
            return { stopReason: "end_turn" };
          }),
        },
      },
    } as unknown as AcpRuntimeSession;
    try {
      const pending = binding.compact!(session);
      if (mode === "matched" || mode === "native-boundary") {
        await pending;
        expect(close).not.toHaveBeenCalled();
      } else {
        await expect(pending).rejects.toThrow(
          mode === "boundary-rpc-failure"
            ? "compact RPC failed"
            : "matching PreCompact/PostCompact",
        );
        expect(close).toHaveBeenCalledOnce();
        if (mode === "pre-only")
          expect(received.mock.calls.at(-1)?.[0].stage).toBe("context.compaction.failed");
      }
      const count = received.mock.calls.length;
      relay.failPending("next turn");
      expect(received).toHaveBeenCalledTimes(count);
    } finally {
      await relay.close();
    }
  });
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
        sessionId: "session-1",
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

async function hook(relay: ClaudeCompactionHookRelay, sessionId: string, event: string) {
  const response = await fetch(relay.url, {
    method: "POST",
    headers: { Authorization: relay.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ hook_event_name: event, session_id: sessionId, trigger: "manual" }),
  });
  expect(response.status).toBe(204);
}

function createBinding(relay: ClaudeCompactionHookRelay) {
  return createClaudeAcpBinding({
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
}
