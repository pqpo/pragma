import { describe, expect, it } from "vitest";

import { isReadOnlyToolName, resolveAutomaticToolPermission } from "./tool-permission-policy.ts";

const request = (toolName: string) => ({
  kind: "tool_approval" as const,
  toolName,
  input: {},
});

describe("Desktop tool permission policy", () => {
  it.each([
    "list_dsl_resources",
    "read_dsl_resource",
    "mcp__pragma__get_task",
    "Grep",
    "WebSearch",
  ])("always recognizes %s as read-only", (toolName) => {
    expect(isReadOnlyToolName(toolName)).toBe(true);
    expect(resolveAutomaticToolPermission("request-approval", request(toolName))).toMatchObject({
      approved: true,
    });
  });

  it("defers mutations in request-approval mode", () => {
    expect(resolveAutomaticToolPermission("request-approval", request("commit_dsl_changes"))).toBe(
      undefined,
    );
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
