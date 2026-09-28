import { z } from "zod";
import type { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";

const editedInputSchema = z.record(z.string(), z.unknown());

/** ACP's selected-option response cannot express edited inputs. This local,
 * namespaced extension carries Host-approved edits back to the SDK callback. */
export function installClaudeAcpEditedInput(
  agent: Pick<ClaudeAcpAgent, "client" | "canUseTool">,
): void {
  const edits = new Map<string, Record<string, unknown>>();
  const requestPermission = agent.client.requestPermission.bind(agent.client);
  agent.client.requestPermission = async (params, signal) => {
    const response = await requestPermission(params, signal);
    const outcome = response.outcome;
    const option =
      outcome.outcome === "selected"
        ? params.options.find((candidate) => candidate.optionId === outcome.optionId)
        : undefined;
    if (
      !signal?.aborted &&
      option?.kind === "allow_once" &&
      response._meta?.["pragma.updatedInput"] !== undefined
    ) {
      edits.set(
        params.toolCall.toolCallId,
        editedInputSchema.parse(response._meta["pragma.updatedInput"]),
      );
    }
    return response;
  };
  const canUseTool = agent.canUseTool.bind(agent);
  agent.canUseTool = (sessionId) => {
    const approve = canUseTool(sessionId);
    return async (toolName, input, context) => {
      try {
        const result = await approve(toolName, input, context);
        const updatedInput = edits.get(context.toolUseID);
        return result?.behavior === "allow" && !context.signal.aborted && updatedInput !== undefined
          ? { ...result, updatedInput }
          : result;
      } finally {
        edits.delete(context.toolUseID);
      }
    };
  };
}
