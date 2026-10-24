import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExpertAgentHumanInteractionHandler } from "@pragma/core";
import type { PiRuntimePermissionMode } from "./types.ts";

/** Native mutations use the same Host decision boundary as managed tools. */
export function withPiToolApproval<TParams extends ToolDefinition["parameters"], TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  options: {
    readonly permissionMode?: PiRuntimePermissionMode | undefined;
    readonly humanInteractionHandler?: ExpertAgentHumanInteractionHandler | undefined;
  },
): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    async execute(toolCallId, params, signal, onUpdate, context) {
      signal?.throwIfAborted();
      let input = params;
      if ((options.permissionMode ?? "request-approval") === "request-approval") {
        if (options.humanInteractionHandler === undefined) {
          throw new Error(
            `${tool.name} requires Host approval, but no approval handler is configured.`,
          );
        }
        const response = await options.humanInteractionHandler({
          kind: "tool_approval",
          toolName: tool.name,
          toolCallId,
          input,
          reason: `Run native ${tool.name} in the workspace.`,
        });
        signal?.throwIfAborted();
        if (response.kind !== "tool_approval" || !response.approved) {
          throw new Error(
            response.kind === "tool_approval"
              ? (response.reason ?? `User declined ${tool.name}.`)
              : `Invalid ${tool.name} approval response.`,
          );
        }
        if (response.updatedInput !== undefined) {
          if (
            typeof response.updatedInput !== "object" ||
            response.updatedInput === null ||
            Array.isArray(response.updatedInput)
          ) {
            throw new Error(`Invalid Host-approved ${tool.name} input.`);
          }
          input = validateToolArguments(tool, {
            type: "toolCall",
            id: toolCallId,
            name: tool.name,
            arguments: response.updatedInput as Parameters<
              typeof validateToolArguments
            >[1]["arguments"],
          });
        }
      }
      return await tool.execute(
        toolCallId,
        input as Parameters<typeof tool.execute>[1],
        signal,
        onUpdate as Parameters<typeof tool.execute>[3],
        context as Parameters<typeof tool.execute>[4],
      );
    },
  };
}
