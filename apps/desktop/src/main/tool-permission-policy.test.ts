import { describe, expect, it } from "vitest";

import { resolveAutomaticToolPermission } from "./tool-permission-policy.ts";

const request = (toolName: string) => ({
  kind: "tool_approval" as const,
  toolName,
  input: {},
});

describe("Desktop tool permission policy", () => {
  it.each([
    "read_and_delete",
    "get_then_write",
    "mcp__pragma__get_task",
    "WebSearch",
    "webfetch",
    "commit_dsl_changes",
  ])("defers %s when the Runtime requests approval", (toolName) => {
    expect(resolveAutomaticToolPermission("request-approval", request(toolName))).toBe(undefined);
  });

  it.each(["auto-approve", "full-access"] as const)(
    "automatically approves mutations in %s mode",
    (mode) => {
      expect(resolveAutomaticToolPermission(mode, request("commit_dsl_changes"))).toMatchObject({
        approved: true,
      });
    },
  );
});
