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
} from "@earendil-works/pi-coding-agent";
import type { SubAgentRuntimeLaunchRequest } from "@expertmesh/agent-core";
import { emitRuntimeStreamEvent } from "@expertmesh/agent-core";

import { readAssistantTextDelta, readToolExecutionEvent } from "./session-events.ts";
import {
  createChildRunId,
  createSequenceCounter,
  createStreamEvent,
  createToolStreamEvents,
  summarizeText,
} from "./stream.ts";
import type { RuntimeStreamBridge } from "./types.ts";

export async function launchPiSubAgent(
  request: SubAgentRuntimeLaunchRequest,
  options: {
    readonly authStorage: AuthStorage;
    readonly cwd: string;
    readonly modelRegistry: ModelRegistry;
    readonly streamBridge: RuntimeStreamBridge;
  },
) {
  const parentRunId = request.parentRunId ?? options.streamBridge.runId;
  const childRunId = request.childRunId ?? createChildRunId(parentRunId);
  const onEvent = request.onEvent ?? options.streamBridge.onEvent;
  const nextSequence = createSequenceCounter();
  const baseSource = {
    kind: "subagent" as const,
    runId: childRunId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    agentType: request.agentType,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
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

  if (parentRunId !== undefined) {
    await emitRuntimeStreamEvent(
      onEvent,
      createStreamEvent({
        runId: parentRunId,
        source: {
          kind: "agent",
          runId: parentRunId,
          path: [],
        },
        sequence: options.streamBridge.nextSequence(),
        type: "subagent.started",
        payload: {
          agentType: request.agentType,
          task: request.task,
          childRunId,
        },
      }),
    );
  }

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [
      ...base,
      request.parentSystemPrompt,
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

  if (request.definition.tools !== undefined && request.definition.tools !== "*") {
    sessionOptions.tools = [...request.definition.tools];
  }

  if (request.definition.disallowedTools !== undefined) {
    sessionOptions.excludeTools = [...request.definition.disallowedTools];
  }

  const { session } = await createAgentSession(sessionOptions);
  const outputTextParts: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    const delta = readAssistantTextDelta(event);
    const toolEvent = readToolExecutionEvent(event);

    if (delta !== undefined) {
      outputTextParts.push(delta);
      void emitRuntimeStreamEvent(
        onEvent,
        createStreamEvent({
          runId: childRunId,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          source: baseSource,
          sequence: nextSequence(),
          type: "message.delta",
          payload: {
            role: "assistant",
            contentType: "text",
            delta,
          },
        }),
      );
    }

    if (toolEvent !== undefined) {
      for (const streamEvent of createToolStreamEvents({
        runId: childRunId,
        parentRunId,
        source: baseSource,
        sequence: nextSequence,
        toolEvent,
      })) {
        void emitRuntimeStreamEvent(onEvent, streamEvent);
      }
    }
  });

  const abort = () => {
    void session.abort();
  };

  request.signal?.addEventListener("abort", abort, { once: true });

  try {
    try {
      await emitRuntimeStreamEvent(
        onEvent,
        createStreamEvent({
          runId: childRunId,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          source: baseSource,
          sequence: nextSequence(),
          type: "run.started",
          payload: {
            task: request.task,
          },
        }),
      );

      await session.prompt(request.task);
      const output = outputTextParts.join("");

      await emitRuntimeStreamEvent(
        onEvent,
        createStreamEvent({
          runId: childRunId,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          source: baseSource,
          sequence: nextSequence(),
          type: "message.completed",
          payload: {
            role: "assistant",
            contentType: "text",
            text: output,
          },
        }),
      );

      await emitRuntimeStreamEvent(
        onEvent,
        createStreamEvent({
          runId: childRunId,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          source: baseSource,
          sequence: nextSequence(),
          type: "run.completed",
          payload: {
            outputSummary: summarizeText(output),
          },
        }),
      );

      if (parentRunId !== undefined) {
        await emitRuntimeStreamEvent(
          onEvent,
          createStreamEvent({
            runId: parentRunId,
            source: {
              kind: "agent",
              runId: parentRunId,
              path: [],
            },
            sequence: options.streamBridge.nextSequence(),
            type: "subagent.completed",
            payload: {
              agentType: request.agentType,
              childRunId,
              outputSummary: summarizeText(output),
            },
          }),
        );
      }

      return {
        text: output,
        details: {
          agentType: request.agentType,
          task: request.task,
          model: request.definition.model ?? "inherit",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "SubAgent run failed";

      await emitRuntimeStreamEvent(
        onEvent,
        createStreamEvent({
          runId: childRunId,
          ...(parentRunId === undefined ? {} : { parentRunId }),
          source: baseSource,
          sequence: nextSequence(),
          type: "run.failed",
          payload: {
            message,
          },
        }),
      );

      if (parentRunId !== undefined) {
        await emitRuntimeStreamEvent(
          onEvent,
          createStreamEvent({
            runId: parentRunId,
            source: {
              kind: "agent",
              runId: parentRunId,
              path: [],
            },
            sequence: options.streamBridge.nextSequence(),
            type: "subagent.failed",
            payload: {
              agentType: request.agentType,
              childRunId,
              message,
            },
          }),
        );
      }

      throw error;
    }
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
