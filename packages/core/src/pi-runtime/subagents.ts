import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AuthStorage,
  CreateAgentSessionOptions,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedToolSet, SubAgentRuntimeLaunchRequest } from "@pragma/core";
import { createToolPolicy, selectResolvedTools } from "@pragma/core";
import { randomUUID } from "node:crypto";

import {
  readAssistantMessageText,
  readAssistantTextDelta,
  readAssistantThinkingDelta,
  readProgressEvent,
  readToolExecutionEvent,
} from "./session-events.ts";
import { createToolStreamEvents } from "./stream.ts";
import type { PiRuntimeStreamState } from "./types.ts";

export async function launchPiSubAgent(
  request: SubAgentRuntimeLaunchRequest,
  options: {
    readonly authStorage: AuthStorage;
    readonly cwd: string;
    readonly modelRegistry: ModelRegistry;
    readonly resolvedTools?: ResolvedToolSet<ToolDefinition> | undefined;
    readonly streamState: PiRuntimeStreamState;
  },
) {
  const parentRunId = request.parentRunId ?? options.streamState.runId;
  const childRunId = request.childRunId ?? createChildRunId(parentRunId);
  const emitter = options.streamState.emitter;
  const baseSource = {
    kind: "tool" as const,
    runId: parentRunId ?? childRunId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    agentType: request.agentType,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    toolKind: "subagent" as const,
    path:
      parentRunId === undefined
        ? []
        : [
            {
              runId: parentRunId,
            },
            {
              runId: childRunId,
              agentType: request.agentType,
            },
          ],
  };

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [
      ...base,
      request.systemPrompt,
    ],
  });
  await loader.reload();

  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  };

  const model = resolveSubAgentModel(request.definition.model, options);
  if (model !== undefined) {
    sessionOptions.model = model;
  }

  const resolvedTools =
    options.resolvedTools === undefined
      ? undefined
      : selectResolvedTools(
          options.resolvedTools,
          createToolPolicy({
            tools: request.definition.tools,
            disallowedTools: request.definition.disallowedTools,
          }),
        );

  if (resolvedTools !== undefined && resolvedTools.tools.length > 0) {
    sessionOptions.customTools = resolvedTools.tools.map((tool) => tool.tool);
  }

  const { session } = await createAgentSession(sessionOptions);
  let output = "";
  const unsubscribe = session.subscribe((event) => {
    const delta = readAssistantTextDelta(event);
    const thinkingDelta = readAssistantThinkingDelta(event);
    const completedMessageText = readAssistantMessageText(event);
    const progressEvent = readProgressEvent(event);
    const toolEvent = readToolExecutionEvent(event);

    if (delta !== undefined) {
      emitter?.emit({
        runId: parentRunId ?? childRunId,
        source: baseSource,
        type: "tool.delta",
        payload: {
          toolCallId: request.toolCallId ?? childRunId,
          toolName: "launch_subagent",
          kind: "subagent",
          channel: "message",
          delta,
        },
      });
    }

    if (thinkingDelta !== undefined) {
      emitter?.emit({
        runId: parentRunId ?? childRunId,
        source: baseSource,
        type: "tool.delta",
        payload: {
          toolCallId: request.toolCallId ?? childRunId,
          toolName: "launch_subagent",
          kind: "subagent",
          channel: "message",
          delta: thinkingDelta,
        },
      });
    }

    if (completedMessageText !== undefined) {
      output = completedMessageText;
    }

    if (progressEvent !== undefined) {
      emitter?.emit({
        runId: parentRunId ?? childRunId,
        source: baseSource,
        type: "progress",
        payload: progressEvent,
      });
    }

    if (toolEvent !== undefined) {
      for (const streamEvent of createToolStreamEvents({
        runId: parentRunId ?? childRunId,
        parentRunId,
        source: baseSource,
        toolEvent,
      })) {
        emitter?.emit(streamEvent);
      }
    }
  });

  const abort = () => {
    void session.abort();
  };

  request.signal?.addEventListener("abort", abort, { once: true });

  try {
    await session.prompt(request.task);

    return {
      text: output,
      details: {
        agentType: request.agentType,
        task: request.task,
        model: request.definition.model ?? "inherit",
      },
    };
  } finally {
    request.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

function resolveSubAgentModel(
  model: string | undefined,
  options: {
    readonly modelRegistry: ModelRegistry;
  },
): CreateAgentSessionOptions["model"] | undefined {
  if (model === undefined || model === "inherit") {
    return undefined;
  }

  return options.modelRegistry
    .getAll()
    .find(
      (candidate) =>
        candidate.id === model ||
        candidate.name === model ||
        `${candidate.provider}/${candidate.id}` === model,
    );
}

function createChildRunId(parentRunId: string | undefined): string {
  return parentRunId === undefined
    ? `subagent-${randomUUID()}`
    : `${parentRunId}:subagent:${randomUUID()}`;
}
