import { RequestError } from "@agentclientprotocol/sdk";
import { sessionFailureMeta } from "@agentclientprotocol/claude-agent-acp/dist/session-failure-extension.js";
import { describe, expect, it } from "vitest";
import { claudePromptError, normalizeClaudeAcpError } from "../src/acp-errors.ts";

describe("Claude ACP error mapping", () => {
  it("uses the pinned worker's metadata and keeps it ahead of conflicting stderr", () => {
    const failure = claudePromptError(
      sessionFailureMeta({
        id: "failure",
        revision: 1,
        kind: "rate_limited",
        category: "limit",
        severity: "error",
        title: "Throttled",
        details: "provider detail",
        actions: ["retry"],
        recoveryPolicy: "next_attempt",
      }),
    );
    expect(failure).toMatchObject({
      code: "runtime.rate_limited",
      retryable: true,
      httpStatus: 429,
    });
    expect(normalizeClaudeAcpError(failure, "Invalid API key")).toBe(failure);
  });
  it("does not turn warnings or unrecognized metadata into failures", () => {
    expect(
      claudePromptError(
        sessionFailureMeta({
          id: "warning",
          revision: 1,
          kind: "rate_limited",
          category: "limit",
          severity: "warning",
          title: "Retrying",
          actions: ["retry"],
          recoveryPolicy: "next_attempt",
        }),
      ),
    ).toBeUndefined();
    expect(claudePromptError({ failure: "model prose" })).toBeUndefined();
  });
  it("recognizes ACP auth-required and preserves its diagnostic", () => {
    expect(normalizeClaudeAcpError(RequestError.authRequired({}))).toMatchObject({
      code: "runtime.auth_invalid",
      retryable: false,
      message: expect.stringContaining("Authentication required"),
    });
  });
});
