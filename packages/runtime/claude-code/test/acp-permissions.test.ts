import type { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";
import { describe, expect, it } from "vitest";
import { installClaudeAcpEditedInput } from "../src/acp-permissions.ts";

describe("Claude ACP edited approval extension", () => {
  it.each([true, false])(
    "applies edited inputs only after SDK permission succeeds: %s",
    async (approved) => {
      const context = {
        signal: new AbortController().signal,
        toolUseID: "tool",
        requestId: "approval-1",
      };
      const agent = {
        client: {
          async requestPermission() {
            return {
              outcome: { outcome: "selected", optionId: approved ? "allow" : "deny" },
              _meta: { "pragma.updatedInput": { command: "edited" } },
            };
          },
        },
        canUseTool() {
          return async (_name: string, input: Record<string, unknown>) => {
            await agent.client.requestPermission(
              {
                sessionId: "session",
                toolCall: { toolCallId: "tool", rawInput: input },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              },
              context.signal,
            );
            return approved
              ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: "Denied" };
          };
        },
      } as unknown as Pick<ClaudeAcpAgent, "client" | "canUseTool">;
      installClaudeAcpEditedInput(agent);
      const response = await agent.canUseTool("session")("Bash", { command: "original" }, context);
      expect(response).toMatchObject(
        approved
          ? { behavior: "allow", updatedInput: { command: "edited" } }
          : { behavior: "deny" },
      );
    },
  );
});
