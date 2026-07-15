import {
  createPragma,
  createRuntimeRegistry,
  ExpertAgentHumanRequestSchema,
  type Expert,
  type ExpertAgentHumanRequest,
  type ExpertAgentHumanResponse,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertSession,
  type MutableExecution,
  type RuntimeRegistry,
} from "@pragma/core";
import type { InvocableResource } from "@pragma/interpreter";
import type { PragmaExpertResource, PragmaResource } from "@pragma/interpreter/ast";
import type { HumanInteractionRequest, HumanInteractionResponse } from "@pragma/shared";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";

import type { Mission, MissionHumanInteraction } from "../shared/desktop-api.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { createDesktopExpertAgent } from "./desktop-expert-factory.ts";
import { pragmaExpertResourceToDesktopDefinition } from "./expert-definition-store.ts";
import type { MissionStore } from "./mission-store.ts";
import type { ModelProviderStore } from "./model-provider-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";

export interface MissionRunner {
  run(id: string): Promise<Mission>;
  listHumanInteractions(id: string): Promise<readonly MissionHumanInteraction[]>;
  respondToHumanInteraction(input: {
    readonly missionId: string;
    readonly interactionId: string;
    readonly requestId: string;
    readonly response: HumanInteractionResponse;
  }): Promise<void>;
}

export function createMissionRunner(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly capabilityStore: CapabilityStore;
  readonly capabilityCredentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
  readonly pragmaHome: string;
  readonly modelProviders: ModelProviderStore;
  readonly runtimes?: RuntimeRegistry | undefined;
}): MissionRunner {
  const runtimes = options.runtimes ?? createDesktopRuntimeRegistry();
  const app = createPragma({ pragmaHome: options.pragmaHome, runtimes });
  const active = new Map<string, MutableExecution & { readonly result: Promise<unknown> }>();
  const starting = new Map<string, Promise<Mission>>();

  const runMission = async (id: string): Promise<Mission> => {
    const mission = await options.missions.get(id);
    if (active.has(mission.id)) return mission;
    const project = await options.project.openRevision(mission.project.revision);
    const compiled = await project.compile<InvocableResource>(mission.executor.ref, {
      workspace: mission.workspace.path,
      runtimes,
      createExpert: async ({ resource, tools, workspace }) =>
        await createExpert(resource, tools, workspace, mission.project.revision, options),
    });
    const startedAt = new Date().toISOString();

    if ("kind" in compiled.value && compiled.value.kind === "flow") {
      const runtime = resolveRootRuntime(project.listResources(), mission.executor.ref, runtimes);
      const recoverable =
        mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status);
      const handle = recoverable
        ? await app.flows.recover(compiled.value, {
            executionId: mission.execution!.id,
            runtime,
          })
        : await app.flows.start(compiled.value, {
            input: { goal: mission.goal, workspace: mission.workspace.path },
            runtime,
          });
      const running = await options.missions.updateExecution(mission.id, {
        id: handle.executionId,
        status: "running",
        startedAt,
      });
      active.set(mission.id, handle);
      observeExecution(options.missions, mission.id, handle, startedAt, () => {
        active.delete(mission.id);
      });
      return running;
    }

    const recoverable =
      mission.execution !== undefined &&
      mission.execution.sessionId !== undefined &&
      ["queued", "running", "waiting"].includes(mission.execution.status);
    const session = recoverable
      ? await app.experts.resumeSession(compiled.value, {
          sessionId: mission.execution!.sessionId!,
        })
      : await app.experts.createSession(compiled.value, {
          runtime: resolveRootRuntime(project.listResources(), mission.executor.ref, runtimes),
        });
    const turn = await session.prompt(
      recoverable
        ? [
            "[Pragma mission recovery]",
            "The previous Desktop process ended before this mission finished.",
            "Continue the pinned mission from the restored ExpertSession context.",
            `Mission goal: ${mission.goal}`,
          ].join("\n")
        : mission.goal,
    );
    const running = await options.missions.updateExecution(mission.id, {
      id: turn.executionId,
      sessionId: session.sessionId,
      status: "running",
      startedAt,
    });
    active.set(mission.id, turn);
    observeExecution(
      options.missions,
      mission.id,
      turn,
      startedAt,
      async () => {
        try {
          await waitForExpertTurnSettlement(session, turn.requestId);
          await session.close("Mission execution finished.");
        } finally {
          active.delete(mission.id);
        }
      },
      session.sessionId,
    );
    return running;
  };

  return {
    async run(id) {
      const pending = starting.get(id);
      if (pending !== undefined) return await pending;
      const started = runMission(id);
      starting.set(id, started);
      try {
        return await started;
      } finally {
        if (starting.get(id) === started) starting.delete(id);
      }
    },
    async listHumanInteractions(id) {
      const execution = active.get(id);
      if (execution === undefined) return [];
      const events = (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
      const responded = new Set(
        events
          .filter((event) => event.type === "human.responded")
          .map((event) => String((event.data as { interactionId?: unknown }).interactionId)),
      );
      return events.flatMap((event) => {
        if (event.type !== "human.requested") return [];
        const data = event.data as { interactionId?: unknown; request?: unknown };
        const interactionId = String(data.interactionId ?? "");
        if (interactionId === "" || responded.has(interactionId)) return [];
        const request = ExpertAgentHumanRequestSchema.safeParse(data.request);
        return request.success
          ? [{ interactionId, request: toDesktopHumanRequest(request.data) }]
          : [];
      });
    },
    async respondToHumanInteraction(input) {
      const execution = active.get(input.missionId);
      if (execution === undefined) {
        throw new Error("This human interaction is not active in the current Desktop process.");
      }
      const request = await findHumanRequest(execution, input.interactionId);
      await execution.respondToHumanInteraction(
        input.interactionId,
        toExpertHumanResponse(request, input.response),
        {
          requestId: input.requestId,
        },
      );
    },
  };
}

function createDesktopRuntimeRegistry(): RuntimeRegistry {
  return createRuntimeRegistry({
    defaultRuntime: "codex",
    runtimes: [
      createCodexRuntime({ descriptor: { id: "codex" } }),
      createClaudeCodeRuntime({ descriptor: { id: "claude-code" } }),
      createPiRuntime({ descriptor: { id: "pi" } }),
    ],
  });
}

async function createExpert(
  resource: PragmaExpertResource,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
  workspace: string,
  revision: number,
  options: {
    readonly capabilityStore: CapabilityStore;
    readonly capabilityCredentials: CapabilityCredentialStore;
    readonly capabilitiesPath: string;
    readonly modelProviders: ModelProviderStore;
  },
): Promise<Expert> {
  const definition = pragmaExpertResourceToDesktopDefinition(
    resource,
    revision,
    new Date().toISOString(),
  );
  return await createDesktopExpertAgent({
    definition,
    workspace,
    store: options.capabilityStore,
    credentials: options.capabilityCredentials,
    capabilitiesPath: options.capabilitiesPath,
    overrides: {
      tools,
      ...(await resolveExpertModels(resource, options)),
    },
  });
}

async function resolveExpertModels(
  resource: PragmaExpertResource,
  options: { readonly modelProviders: ModelProviderStore },
) {
  const runtime = resource.spec.runtime;
  if (runtime?.model === undefined) return {};
  if (runtime.id !== "pi") {
    return { models: { defaultModelName: runtime.model, providers: [] } };
  }
  if (runtime.provider === undefined) {
    throw new Error(`Expert ${resource.metadata.id} must configure a PI model provider.`);
  }
  const provider = await options.modelProviders.getCredentials(runtime.provider);
  return {
    models: {
      defaultModelName: runtime.model,
      providers: [
        {
          provider: runtime.provider,
          modelNames: provider.models,
          baseApi: provider.baseUrl,
          key: provider.apiKey,
          api: "openai-completions" as const,
        },
      ],
    },
  };
}

function resolveRootRuntime(
  resources: readonly PragmaResource[],
  ref: string,
  runtimes: RuntimeRegistry,
): string {
  const parsed = /^(expert|team|flow):([^@]+)@(.+)$/.exec(ref);
  if (parsed === null) return runtimes.defaultRuntime;
  let resource = resources.find(
    (candidate) =>
      resourceKind(candidate) === parsed[1] &&
      candidate.metadata.id === parsed[2] &&
      candidate.metadata.version === parsed[3],
  );
  if (resource?.kind === "ExpertTeam") {
    const coordinator = /^expert:([^@]+)@(.+)$/.exec(resource.spec.coordinator.ref);
    resource = resources.find(
      (candidate) =>
        candidate.kind === "Expert" &&
        candidate.metadata.id === coordinator?.[1] &&
        candidate.metadata.version === coordinator?.[2],
    );
  }
  return resource?.kind === "Expert"
    ? (resource.spec.runtime?.id ?? runtimes.defaultRuntime)
    : runtimes.defaultRuntime;
}

function observeExecution(
  missions: MissionStore,
  missionId: string,
  execution: {
    readonly executionId: string;
    readonly result: Promise<unknown>;
    readonly getState: () => Promise<{ readonly status: string }>;
    readonly listEvents: MutableExecution["listEvents"];
  },
  startedAt: string,
  onFinished: () => void | Promise<void>,
  sessionId?: string,
): void {
  let lastObservedStatus: string | undefined;
  const probe = setInterval(() => {
    void execution
      .getState()
      .then(async (state) => {
        const waiting = state.status === "waiting" || (await hasPendingHumanInteraction(execution));
        if (!waiting) {
          const resumed = lastObservedStatus === "waiting" && state.status === "running";
          lastObservedStatus = state.status;
          if (resumed) {
            await missions.updateExecution(
              missionId,
              {
                id: execution.executionId,
                ...(sessionId === undefined ? {} : { sessionId }),
                status: "running",
                startedAt,
              },
              {
                executionId: execution.executionId,
                statuses: ["queued", "running", "waiting"],
              },
            );
          }
          return;
        }
        if (lastObservedStatus === "waiting") return;
        lastObservedStatus = "waiting";
        await missions.updateExecution(
          missionId,
          {
            id: execution.executionId,
            ...(sessionId === undefined ? {} : { sessionId }),
            status: "waiting",
            startedAt,
          },
          {
            executionId: execution.executionId,
            statuses: ["queued", "running", "waiting"],
          },
        );
      })
      .catch(() => {
        // The result observer below records terminal failures.
      });
  }, 500);
  probe.unref();
  void (async () => {
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let failure: unknown;
    try {
      await execution.result;
    } catch (error) {
      const state = await execution.getState().catch(() => undefined);
      status = state?.status === "cancelled" ? "cancelled" : "failed";
      failure = error;
    }
    clearInterval(probe);
    try {
      await onFinished();
    } catch (error) {
      status = "failed";
      failure ??= error;
    }
    await missions.updateExecution(
      missionId,
      {
        id: execution.executionId,
        ...(sessionId === undefined ? {} : { sessionId }),
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(status === "failed"
          ? { error: failure instanceof Error ? failure.message : String(failure) }
          : {}),
      },
      {
        executionId: execution.executionId,
        statuses: ["queued", "running", "waiting"],
      },
    );
  })().catch((error: unknown) => {
    console.error(`Failed to persist terminal Mission execution ${execution.executionId}.`, error);
  });
}

async function hasPendingHumanInteraction(execution: {
  readonly listEvents: MutableExecution["listEvents"];
}): Promise<boolean> {
  const events = (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => String((event.data as { interactionId?: unknown }).interactionId)),
  );
  return events.some(
    (event) =>
      event.type === "human.requested" &&
      !responded.has(String((event.data as { interactionId?: unknown }).interactionId)),
  );
}

function resourceKind(resource: PragmaResource): "expert" | "team" | "flow" {
  return resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : "flow";
}

async function findHumanRequest(
  execution: MutableExecution,
  interactionId: string,
): Promise<ExpertAgentHumanRequest> {
  const events = (await execution.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
  const event = events.find(
    (candidate) =>
      candidate.type === "human.requested" &&
      (candidate.data as { interactionId?: unknown }).interactionId === interactionId,
  );
  if (event === undefined) throw new Error(`Human interaction was not found: ${interactionId}`);
  return ExpertAgentHumanRequestSchema.parse((event.data as { request?: unknown }).request);
}

function toDesktopHumanRequest(request: ExpertAgentHumanRequest): HumanInteractionRequest {
  if (request.kind === "tool_approval") {
    return {
      kind: "approval",
      title: request.toolName,
      prompt: request.reason ?? `Approve ${request.toolName}?`,
      data: request.input,
    };
  }
  const first = request.questions[0];
  const approval =
    request.questions.length === 1 &&
    first?.kind === "single_choice" &&
    first.options.some((option) => /^approve$/i.test(option.label)) &&
    first.options.some((option) => /^reject$/i.test(option.label));
  return {
    kind: approval ? "approval" : "question",
    ...(first === undefined ? {} : { title: first.header, prompt: first.question }),
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}

function toExpertHumanResponse(
  request: ExpertAgentHumanRequest,
  response: HumanInteractionResponse,
): ExpertAgentHumanResponse {
  if (request.kind === "tool_approval") {
    return {
      kind: "tool_approval",
      approved: response.approved ?? response.decision === "approved",
      ...(response.notes === undefined ? {} : { reason: response.notes }),
    };
  }
  const supplied =
    typeof response.answers === "object" && response.answers !== null
      ? { ...(response.answers as Record<string, unknown>) }
      : {};
  for (const question of request.questions) {
    if (supplied[question.question] !== undefined) continue;
    if (question.kind === "text" && response.notes !== undefined) {
      supplied[question.question] = response.notes;
      continue;
    }
    if (question.kind === "single_choice") {
      const selected =
        response.approved === undefined
          ? response.decision
          : (question.options.find((option) =>
              response.approved
                ? /^approve(?:d)?$/i.test(option.label)
                : /^reject(?:ed)?$/i.test(option.label),
            )?.label ?? response.decision);
      if (selected !== undefined) supplied[question.question] = selected;
    }
  }
  return { kind: "user_question", answered: true, answers: supplied };
}

async function waitForExpertTurnSettlement(
  session: ExpertSession,
  requestId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [state, prompts] = await Promise.all([session.getState(), session.getPromptQueue()]);
    const prompt = prompts.find((candidate) => candidate.requestId === requestId);
    const settled =
      prompt !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(prompt.status) &&
      state.activeExecutionId !== prompt.executionId;
    if (settled) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
